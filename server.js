const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { getDB } = require('./db/init');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const today = () => new Date().toISOString().split('T')[0];

// ── LINK ENGINE ──────────────────────────────────────────────
async function applyTransaction(db, tx) {
  for (const item of (tx.items || [])) {
    const delta = Number(item.qty) * (tx.type === 'بيع' ? -1 : 1);
    await db.run(`UPDATE products SET stock = stock + ? WHERE name = ?`, [delta, item.product_name || item.name]);
  }

  if (tx.remaining > 0 && tx.party_id) {
    if (tx.party_type === 'customer') {
      await db.run(`UPDATE customers SET balance = balance + ? WHERE id = ?`, [tx.remaining, tx.party_id]);
    } else if (tx.party_type === 'supplier') {
      await db.run(`UPDATE suppliers SET balance = balance + ? WHERE id = ?`, [tx.remaining, tx.party_id]);
    }
  }

  if (tx.type === 'بيع' && tx.paid > 0) {
    await db.run(`INSERT INTO revenues (date,amount,description,source,party_name,tx_id) VALUES (?,?,?,?,?,?)`,
      [tx.date, tx.paid, `بيع – ${tx.party_name} – ${(tx.items||[]).map(i=>i.product_name||i.name).join('، ')}`, 'بيع', tx.party_name, tx.id]);
  }

  if (tx.type === 'شراء' && tx.paid > 0) {
    await db.run(`INSERT INTO expenses (date,amount,description,category,party_name,tx_id) VALUES (?,?,?,?,?,?)`,
      [tx.date, tx.paid, `شراء – ${tx.party_name} – ${(tx.items||[]).map(i=>i.product_name||i.name).join('، ')}`, 'شراء', tx.party_name, tx.id]);
  }

  if (tx.pay_method === 'شيك' && tx.paid > 0) {
    await db.run(`INSERT INTO collection (date,amount,type,party_name,party_type,party_id,status,notes,cheque_image,tx_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [tx.cheque_date || tx.date, tx.paid, 'شيك', tx.party_name, tx.party_type, tx.party_id||null, 'معلق', `معاملة ${tx.type} – مدفوع`, tx.cheque_image||null, tx.id]);
  }

  if (tx.remaining > 0) {
    const remMethod = tx.remaining_method || 'غير محدد';
    const remDate = remMethod === 'شيك' ? (tx.remaining_cheque_date || tx.date) : tx.date;
    await db.run(`INSERT INTO collection (date,amount,type,party_name,party_type,party_id,status,notes,cheque_image,tx_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [remDate, tx.remaining, remMethod === 'شيك' ? 'شيك' : (remMethod === 'تحويل' ? 'تحويل' : 'كاش'),
       tx.party_name, tx.party_type, tx.party_id||null, 'معلق',
       `متبقي من ${tx.type} – ${(tx.items||[]).map(i=>i.product_name||i.name).join('، ')}`,
       tx.remaining_cheque_image||null, tx.id]);
  }
}

async function reverseTransaction(db, tx) {
  const items = await db.all2(`SELECT * FROM transaction_items WHERE transaction_id = ?`, [tx.id]);
  for (const item of items) {
    const delta = Number(item.qty) * (tx.type === 'بيع' ? 1 : -1);
    await db.run(`UPDATE products SET stock = stock + ? WHERE name = ?`, [delta, item.product_name]);
  }
  if (tx.remaining > 0 && tx.party_id) {
    if (tx.party_type === 'customer') {
      await db.run(`UPDATE customers SET balance = GREATEST(0, balance - ?) WHERE id = ?`, [tx.remaining, tx.party_id]);
    } else if (tx.party_type === 'supplier') {
      await db.run(`UPDATE suppliers SET balance = GREATEST(0, balance - ?) WHERE id = ?`, [tx.remaining, tx.party_id]);
    }
  }
  await db.run(`DELETE FROM revenues WHERE tx_id = ?`, [tx.id]);
  await db.run(`DELETE FROM expenses WHERE tx_id = ?`, [tx.id]);
  await db.run(`DELETE FROM collection WHERE tx_id = ?`, [tx.id]);
}

function route(fn) {
  return async (req, res) => {
    let db;
    try {
      db = await getDB();
      await fn(req, res, db);
    } catch (err) {
      console.error('\n❌ API Error on', req.method, req.path);
      console.error('Error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    } finally {
      if (db && db.release_client) db.release_client();
    }
  };
}

// ══════════════════════════════════════════════════════════════
// CUSTOMERS
// ══════════════════════════════════════════════════════════════
app.get('/api/customers', route(async (req, res, db) => {
  res.json(await db.all2(`SELECT * FROM customers ORDER BY name`));
}));
app.get('/api/customers/:id', route(async (req, res, db) => {
  const r = await db.get2(`SELECT * FROM customers WHERE id=?`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
}));
app.post('/api/customers', route(async (req, res, db) => {
  const { name, phone, address, balance, notes } = req.body;
  await db.run(`INSERT INTO customers (name,phone,address,balance,notes) VALUES (?,?,?,?,?)`,
    [name, phone||'', address||'', balance||0, notes||'']);
  const id = await db.lastId();
  res.json(await db.get2(`SELECT * FROM customers WHERE id=?`, [id]));
}));
app.put('/api/customers/:id', route(async (req, res, db) => {
  const { name, phone, address, balance, notes } = req.body;
  await db.run(`UPDATE customers SET name=?,phone=?,address=?,balance=?,notes=? WHERE id=?`,
    [name, phone||'', address||'', balance||0, notes||'', req.params.id]);
  res.json(await db.get2(`SELECT * FROM customers WHERE id=?`, [req.params.id]));
}));
app.delete('/api/customers/:id', route(async (req, res, db) => {
  await db.run(`DELETE FROM customers WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/customers/:id/pay', route(async (req, res, db) => {
  const { date, amount, method, notes, cheque_date, cheque_image } = req.body;
  const cust = await db.get2(`SELECT * FROM customers WHERE id=?`, [req.params.id]);
  if (!cust) return res.status(404).json({ error: 'not found' });
  await db.run(`UPDATE customers SET balance = GREATEST(0, balance - ?) WHERE id=?`, [amount, req.params.id]);
  await db.run(`INSERT INTO revenues (date,amount,description,source,party_name) VALUES (?,?,?,?,?)`,
    [date, amount, `دفعة من ${cust.name}${notes ? ' – ' + notes : ''}`, 'تحصيل', cust.name]);
  const colStatus = method === 'شيك' ? 'معلق' : 'محصّل';
  const colDate = method === 'شيك' ? (cheque_date || date) : date;
  await db.run(`INSERT INTO collection (date,amount,type,party_name,party_type,party_id,status,notes,cheque_image) VALUES (?,?,?,?,?,?,?,?,?)`,
    [colDate, amount, method, cust.name, 'customer', cust.id, colStatus, notes || `دفعة من ${cust.name}`, cheque_image||null]);
  const updated = await db.get2(`SELECT balance FROM customers WHERE id=?`, [req.params.id]);
  res.json({ ok: true, new_balance: updated.balance });
}));

// ══════════════════════════════════════════════════════════════
// SUPPLIERS
// ══════════════════════════════════════════════════════════════
app.get('/api/suppliers', route(async (req, res, db) => {
  res.json(await db.all2(`SELECT * FROM suppliers ORDER BY name`));
}));
app.get('/api/suppliers/:id', route(async (req, res, db) => {
  const r = await db.get2(`SELECT * FROM suppliers WHERE id=?`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
}));
app.post('/api/suppliers', route(async (req, res, db) => {
  const { name, phone, address, balance, notes } = req.body;
  await db.run(`INSERT INTO suppliers (name,phone,address,balance,notes) VALUES (?,?,?,?,?)`,
    [name, phone||'', address||'', balance||0, notes||'']);
  const id = await db.lastId();
  res.json(await db.get2(`SELECT * FROM suppliers WHERE id=?`, [id]));
}));
app.put('/api/suppliers/:id', route(async (req, res, db) => {
  const { name, phone, address, balance, notes } = req.body;
  await db.run(`UPDATE suppliers SET name=?,phone=?,address=?,balance=?,notes=? WHERE id=?`,
    [name, phone||'', address||'', balance||0, notes||'', req.params.id]);
  res.json(await db.get2(`SELECT * FROM suppliers WHERE id=?`, [req.params.id]));
}));
app.delete('/api/suppliers/:id', route(async (req, res, db) => {
  await db.run(`DELETE FROM suppliers WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/suppliers/:id/pay', route(async (req, res, db) => {
  const { date, amount, method, notes, cheque_date } = req.body;
  const supp = await db.get2(`SELECT * FROM suppliers WHERE id=?`, [req.params.id]);
  if (!supp) return res.status(404).json({ error: 'not found' });
  await db.run(`UPDATE suppliers SET balance = GREATEST(0, balance - ?) WHERE id=?`, [amount, req.params.id]);
  await db.run(`INSERT INTO expenses (date,amount,description,category,party_name) VALUES (?,?,?,?,?)`,
    [date, amount, `سداد للمورد: ${supp.name}${notes ? ' – ' + notes : ''}`, 'سداد موردين', supp.name]);
  if (method === 'شيك') {
    await db.run(`INSERT INTO collection (date,amount,type,party_name,party_type,party_id,status,notes) VALUES (?,?,?,?,?,?,?,?)`,
      [cheque_date||date, amount, 'شيك', supp.name, 'supplier', supp.id, 'معلق', `سداد للمورد: ${supp.name}`]);
  }
  const updated = await db.get2(`SELECT balance FROM suppliers WHERE id=?`, [req.params.id]);
  res.json({ ok: true, new_balance: updated.balance });
}));

// ══════════════════════════════════════════════════════════════
// INVENTORY
// ══════════════════════════════════════════════════════════════
app.get('/api/inventory', route(async (req, res, db) => {
  const cats = await db.all2(`SELECT * FROM inventory_categories ORDER BY sort_order`);
  const result = [];
  for (const cat of cats) {
    const products = await db.all2(`SELECT * FROM products WHERE category_id=?`, [cat.id]);
    const prods = [];
    for (const p of products) {
      const imgs = await db.all2(`SELECT filename FROM product_images WHERE product_id=?`, [p.id]);
      prods.push({ ...p, images: imgs.map(i => '/uploads/' + i.filename) });
    }
    result.push({ ...cat, products: prods });
  }
  res.json(result);
}));
app.post('/api/products', upload.array('images', 10), route(async (req, res, db) => {
  const { category_id, name, unit, stock, notes } = req.body;
  await db.run(`INSERT INTO products (category_id,name,unit,stock,notes) VALUES (?,?,?,?,?)`,
    [category_id, name, unit||'قطعة', stock||0, notes||'']);
  const pid = await db.lastId();
  if (req.files) {
    for (const f of req.files)
      await db.run(`INSERT INTO product_images (product_id,filename) VALUES (?,?)`, [pid, f.filename]);
  }
  res.json({ id: pid });
}));
app.put('/api/products/:id', upload.array('images', 10), route(async (req, res, db) => {
  const { name, unit, stock, notes, remove_images } = req.body;
  await db.run(`UPDATE products SET name=?,unit=?,stock=?,notes=? WHERE id=?`,
    [name, unit||'قطعة', stock||0, notes||'', req.params.id]);
  if (remove_images) {
    for (const fn of JSON.parse(remove_images)) {
      await db.run(`DELETE FROM product_images WHERE product_id=? AND filename=?`, [req.params.id, fn]);
      try { fs.unlinkSync(path.join(__dirname, 'uploads', fn)); } catch (e) {}
    }
  }
  if (req.files) {
    for (const f of req.files)
      await db.run(`INSERT INTO product_images (product_id,filename) VALUES (?,?)`, [req.params.id, f.filename]);
  }
  res.json({ ok: true });
}));
app.delete('/api/products/:id', route(async (req, res, db) => {
  const imgs = await db.all2(`SELECT filename FROM product_images WHERE product_id=?`, [req.params.id]);
  imgs.forEach(img => { try { fs.unlinkSync(path.join(__dirname, 'uploads', img.filename)); } catch (e) {} });
  await db.run(`DELETE FROM products WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// TRANSACTIONS
// ══════════════════════════════════════════════════════════════
app.get('/api/transactions', route(async (req, res, db) => {
  const { date, date_from, date_to, type, search } = req.query;
  let q = `SELECT * FROM transactions WHERE 1=1`;
  const params = [];
  if (date)      { q += ` AND date=?`;           params.push(date); }
  if (date_from) { q += ` AND date>=?`;           params.push(date_from); }
  if (date_to)   { q += ` AND date<=?`;           params.push(date_to); }
  if (type)      { q += ` AND type=?`;            params.push(type); }
  if (search)    { q += ` AND party_name LIKE ?`; params.push('%' + search + '%'); }
  q += ` ORDER BY date DESC, id DESC`;
  const txs = await db.all2(q, params);
  const result = [];
  for (const tx of txs) {
    const items = await db.all2(`SELECT * FROM transaction_items WHERE transaction_id=?`, [tx.id]);
    result.push({ ...tx, items });
  }
  res.json(result);
}));
app.get('/api/transactions/:id', route(async (req, res, db) => {
  const tx = await db.get2(`SELECT * FROM transactions WHERE id=?`, [req.params.id]);
  if (!tx) return res.status(404).json({ error: 'not found' });
  tx.items = await db.all2(`SELECT * FROM transaction_items WHERE transaction_id=?`, [tx.id]);
  res.json(tx);
}));
app.post('/api/transactions', upload.fields([
  { name: 'cheque_image', maxCount: 1 },
  { name: 'remaining_cheque_image', maxCount: 1 }
]), route(async (req, res, db) => {
  const b = req.body;
  const chequeImg = req.files?.cheque_image?.[0]?.filename || null;
  const remChequeImg = req.files?.remaining_cheque_image?.[0]?.filename || null;
  const items = JSON.parse(b.items || '[]');
  const total = Number(b.total) || 0;
  const paid = Math.max(0, Number(b.paid) || 0);
  const remaining = Math.max(0, Number(b.remaining) || 0);

  await db.run(`INSERT INTO transactions (type,date,party_type,party_id,party_name,party_phone,total,payment_type,paid,remaining,pay_method,remaining_method,remaining_cheque_date,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.type, b.date, b.party_type||'', b.party_id||null, b.party_name||'', b.party_phone||'',
     total, b.payment_type||'كلي', paid, remaining,
     b.pay_method||'', b.remaining_method||'', b.remaining_cheque_date||'', b.notes||'']);
  const txId = await db.lastId();

  for (const item of items)
    await db.run(`INSERT INTO transaction_items (transaction_id,product_name,qty,unit,price,subtotal) VALUES (?,?,?,?,?,?)`,
      [txId, item.product_name||item.name, item.qty, item.unit||'قطعة', item.price, Number(item.qty)*Number(item.price)]);

  await applyTransaction(db, {
    id: txId, type: b.type, date: b.date, party_type: b.party_type, party_id: b.party_id||null,
    party_name: b.party_name, total, paid, remaining,
    pay_method: b.pay_method, cheque_date: b.cheque_date, cheque_image: chequeImg,
    remaining_method: b.remaining_method, remaining_cheque_date: b.remaining_cheque_date,
    remaining_cheque_image: remChequeImg, items
  });
  res.json({ id: txId });
}));
app.put('/api/transactions/:id', upload.fields([
  { name: 'cheque_image', maxCount: 1 },
  { name: 'remaining_cheque_image', maxCount: 1 }
]), route(async (req, res, db) => {
  const old = await db.get2(`SELECT * FROM transactions WHERE id=?`, [req.params.id]);
  if (!old) return res.status(404).json({ error: 'not found' });
  await reverseTransaction(db, old);

  const b = req.body;
  const chequeImg = req.files?.cheque_image?.[0]?.filename || b.cheque_image_existing || null;
  const remChequeImg = req.files?.remaining_cheque_image?.[0]?.filename || b.remaining_cheque_image_existing || null;
  const items = JSON.parse(b.items || '[]');
  const total = Number(b.total) || 0;
  const paid = Math.max(0, Number(b.paid) || 0);
  const remaining = Math.max(0, Number(b.remaining) || 0);

  await db.run(`UPDATE transactions SET type=?,date=?,party_type=?,party_id=?,party_name=?,party_phone=?,total=?,payment_type=?,paid=?,remaining=?,pay_method=?,remaining_method=?,remaining_cheque_date=?,notes=? WHERE id=?`,
    [b.type, b.date, b.party_type||'', b.party_id||null, b.party_name||'', b.party_phone||'',
     total, b.payment_type||'كلي', paid, remaining,
     b.pay_method||'', b.remaining_method||'', b.remaining_cheque_date||'', b.notes||'', req.params.id]);
  await db.run(`DELETE FROM transaction_items WHERE transaction_id=?`, [req.params.id]);
  for (const item of items)
    await db.run(`INSERT INTO transaction_items (transaction_id,product_name,qty,unit,price,subtotal) VALUES (?,?,?,?,?,?)`,
      [req.params.id, item.product_name||item.name, item.qty, item.unit||'قطعة', item.price, Number(item.qty)*Number(item.price)]);

  await applyTransaction(db, {
    id: req.params.id, type: b.type, date: b.date, party_type: b.party_type, party_id: b.party_id||null,
    party_name: b.party_name, total, paid, remaining,
    pay_method: b.pay_method, cheque_date: b.cheque_date, cheque_image: chequeImg,
    remaining_method: b.remaining_method, remaining_cheque_date: b.remaining_cheque_date,
    remaining_cheque_image: remChequeImg, items
  });
  res.json({ ok: true });
}));
app.delete('/api/transactions/:id', route(async (req, res, db) => {
  const tx = await db.get2(`SELECT * FROM transactions WHERE id=?`, [req.params.id]);
  if (!tx) return res.status(404).json({ error: 'not found' });
  await reverseTransaction(db, tx);
  await db.run(`DELETE FROM transactions WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// REVENUES
// ══════════════════════════════════════════════════════════════
app.get('/api/revenues', route(async (req, res, db) => {
  const { from, to } = req.query;
  let q = `SELECT * FROM revenues WHERE 1=1`;
  const p = [];
  if (from) { q += ` AND date>=?`; p.push(from); }
  if (to)   { q += ` AND date<=?`; p.push(to); }
  res.json(await db.all2(q + ` ORDER BY date DESC, id DESC`, p));
}));
app.get('/api/revenues/:id', route(async (req, res, db) => {
  const r = await db.get2(`SELECT * FROM revenues WHERE id=?`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
}));
app.post('/api/revenues', route(async (req, res, db) => {
  const { date, amount, description, source, party_name } = req.body;
  await db.run(`INSERT INTO revenues (date,amount,description,source,party_name) VALUES (?,?,?,?,?)`,
    [date, amount, description||'', source||'يدوي', party_name||'']);
  await db.run(`INSERT INTO transactions (type,date,party_type,party_name,total,payment_type,paid,remaining,pay_method,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['إيراد', date, '', party_name||'', amount, 'كلي', amount, 0, 'كاش', description||'إيراد يدوي']);
  res.json({ id: await db.lastId() });
}));
app.put('/api/revenues/:id', route(async (req, res, db) => {
  const { date, amount, description, source, party_name } = req.body;
  await db.run(`UPDATE revenues SET date=?,amount=?,description=?,source=?,party_name=? WHERE id=? AND tx_id IS NULL`,
    [date, amount, description||'', source||'يدوي', party_name||'', req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/revenues/:id', route(async (req, res, db) => {
  const r = await db.get2(`SELECT * FROM revenues WHERE id=?`, [req.params.id]);
  if (r?.tx_id) await db.run(`DELETE FROM transactions WHERE id=?`, [r.tx_id]);
  await db.run(`DELETE FROM revenues WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// EXPENSES
// ══════════════════════════════════════════════════════════════
app.get('/api/expenses', route(async (req, res, db) => {
  const { from, to } = req.query;
  let q = `SELECT * FROM expenses WHERE 1=1`;
  const p = [];
  if (from) { q += ` AND date>=?`; p.push(from); }
  if (to)   { q += ` AND date<=?`; p.push(to); }
  res.json(await db.all2(q + ` ORDER BY date DESC, id DESC`, p));
}));
app.get('/api/expenses/:id', route(async (req, res, db) => {
  const e = await db.get2(`SELECT * FROM expenses WHERE id=?`, [req.params.id]);
  if (!e) return res.status(404).json({ error: 'not found' });
  res.json(e);
}));
app.post('/api/expenses', route(async (req, res, db) => {
  const { date, amount, description, category, party_name } = req.body;
  await db.run(`INSERT INTO expenses (date,amount,description,category,party_name) VALUES (?,?,?,?,?)`,
    [date, amount, description||'', category||'أخرى', party_name||'']);
  await db.run(`INSERT INTO transactions (type,date,party_type,party_name,total,payment_type,paid,remaining,pay_method,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['مصروف', date, '', party_name||'', amount, 'كلي', amount, 0, 'كاش', description||category||'مصروف يدوي']);
  res.json({ id: await db.lastId() });
}));
app.put('/api/expenses/:id', route(async (req, res, db) => {
  const { date, amount, description, category, party_name } = req.body;
  await db.run(`UPDATE expenses SET date=?,amount=?,description=?,category=?,party_name=? WHERE id=? AND tx_id IS NULL`,
    [date, amount, description||'', category||'أخرى', party_name||'', req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/expenses/:id', route(async (req, res, db) => {
  const e = await db.get2(`SELECT * FROM expenses WHERE id=?`, [req.params.id]);
  if (e?.tx_id) await db.run(`DELETE FROM transactions WHERE id=?`, [e.tx_id]);
  await db.run(`DELETE FROM expenses WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// COLLECTION
// ══════════════════════════════════════════════════════════════
app.get('/api/collection', route(async (req, res, db) => {
  res.json(await db.all2(`SELECT * FROM collection ORDER BY date ASC, id DESC`));
}));
app.get('/api/collection/:id', route(async (req, res, db) => {
  const c = await db.get2(`SELECT * FROM collection WHERE id=?`, [req.params.id]);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
}));
app.post('/api/collection', upload.single('cheque_image'), route(async (req, res, db) => {
  const { date, amount, type, party_name, party_type, party_id, status, notes } = req.body;
  const cheque_image = req.file ? req.file.filename : null;
  await db.run(`INSERT INTO collection (date,amount,type,party_name,party_type,party_id,status,notes,cheque_image) VALUES (?,?,?,?,?,?,?,?,?)`,
    [date, amount, type||'كاش', party_name||'', party_type||'', party_id||null, status||'معلق', notes||'', cheque_image]);
  const id = await db.lastId();
  if (status === 'محصّل') {
    await db.run(`INSERT INTO revenues (date,amount,description,source,party_name) VALUES (?,?,?,?,?)`,
      [date, amount, `تحصيل من ${party_name}`, 'تحصيل', party_name]);
    if (party_id && party_type === 'customer')
      await db.run(`UPDATE customers SET balance = GREATEST(0, balance - ?) WHERE id=?`, [amount, party_id]);
  }
  res.json({ id });
}));
app.put('/api/collection/:id', upload.single('cheque_image'), route(async (req, res, db) => {
  const { date, amount, type, party_name, status, notes } = req.body;
  const existing = await db.get2(`SELECT * FROM collection WHERE id=?`, [req.params.id]);
  const cheque_image = req.file ? req.file.filename : existing?.cheque_image;
  await db.run(`UPDATE collection SET date=?,amount=?,type=?,party_name=?,status=?,notes=?,cheque_image=? WHERE id=?`,
    [date, amount, type||'كاش', party_name||'', status||'معلق', notes||'', cheque_image, req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/collection/:id/collect', route(async (req, res, db) => {
  const col = await db.get2(`SELECT * FROM collection WHERE id=?`, [req.params.id]);
  if (!col) return res.status(404).json({ error: 'not found' });
  await db.run(`UPDATE collection SET status='محصّل' WHERE id=?`, [req.params.id]);
  await db.run(`INSERT INTO revenues (date,amount,description,source,party_name) VALUES (?,?,?,?,?)`,
    [today(), col.amount, `تحصيل من ${col.party_name}`, 'تحصيل', col.party_name]);
  if (col.party_id && col.party_type === 'customer')
    await db.run(`UPDATE customers SET balance = GREATEST(0, balance - ?) WHERE id=?`, [col.amount, col.party_id]);
  res.json({ ok: true });
}));
app.delete('/api/collection/:id', route(async (req, res, db) => {
  const col = await db.get2(`SELECT * FROM collection WHERE id=?`, [req.params.id]);
  if (col?.cheque_image) { try { fs.unlinkSync(path.join(__dirname, 'uploads', col.cheque_image)); } catch (e) {} }
  await db.run(`DELETE FROM collection WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════
app.get('/api/dashboard', route(async (req, res, db) => {
  const totalReceivables = (await db.get2(`SELECT COALESCE(SUM(balance),0) as v FROM customers`)).v;
  const totalPayables    = (await db.get2(`SELECT COALESCE(SUM(balance),0) as v FROM suppliers`)).v;
  const totalRevenues    = (await db.get2(`SELECT COALESCE(SUM(amount),0) as v FROM revenues`)).v;
  const totalExpenses    = (await db.get2(`SELECT COALESCE(SUM(amount),0) as v FROM expenses`)).v;
  const pendingCheques   = await db.all2(`SELECT * FROM collection WHERE type='شيك' AND status!='محصّل' ORDER BY date ASC`);
  const todayTx          = await db.all2(`SELECT * FROM transactions WHERE date=? ORDER BY id DESC`, [today()]);
  const recentTxRaw      = await db.all2(`SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT 10`);
  const recentTx = [];
  for (const tx of recentTxRaw) {
    const items = await db.all2(`SELECT * FROM transaction_items WHERE transaction_id=?`, [tx.id]);
    recentTx.push({ ...tx, items });
  }
  const alertDate = new Date(); alertDate.setDate(alertDate.getDate() + 7);
  const chequeAlerts = await db.all2(
    `SELECT * FROM collection WHERE type='شيك' AND status!='محصّل' AND date<=? ORDER BY date ASC`,
    [alertDate.toISOString().split('T')[0]]
  );
  res.json({ totalReceivables, totalPayables, totalRevenues, totalExpenses, pendingCheques, todayTx, recentTx, chequeAlerts });
}));

// ══════════════════════════════════════════════════════════════
// STATEMENTS
// ══════════════════════════════════════════════════════════════
app.get('/api/statement/customer/:id', route(async (req, res, db) => {
  const cust = await db.get2(`SELECT * FROM customers WHERE id=?`, [req.params.id]);
  if (!cust) return res.status(404).json({ error: 'not found' });
  const txsRaw = await db.all2(`SELECT * FROM transactions WHERE party_type='customer' AND party_id=? ORDER BY date DESC`, [req.params.id]);
  const txs = [];
  for (const tx of txsRaw) {
    const items = await db.all2(`SELECT * FROM transaction_items WHERE transaction_id=?`, [tx.id]);
    txs.push({ ...tx, items });
  }
  const payments = await db.all2(`SELECT * FROM collection WHERE party_type='customer' AND party_id=? ORDER BY date DESC`, [req.params.id]);
  res.json({ party: cust, transactions: txs, payments });
}));
app.get('/api/statement/supplier/:id', route(async (req, res, db) => {
  const supp = await db.get2(`SELECT * FROM suppliers WHERE id=?`, [req.params.id]);
  if (!supp) return res.status(404).json({ error: 'not found' });
  const txsRaw = await db.all2(`SELECT * FROM transactions WHERE party_type='supplier' AND party_id=? ORDER BY date DESC`, [req.params.id]);
  const txs = [];
  for (const tx of txsRaw) {
    const items = await db.all2(`SELECT * FROM transaction_items WHERE transaction_id=?`, [tx.id]);
    txs.push({ ...tx, items });
  }
  const payments = await db.all2(`SELECT * FROM expenses WHERE party_name=? AND category='سداد موردين' ORDER BY date DESC`, [supp.name]);
  res.json({ party: supp, transactions: txs, payments });
}));

// ── SERVE FRONTEND ───────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  =====================================');
  console.log('  شركة النوارة للاستيراد والتصدير');
  console.log('  =====================================');
  console.log(`  السيرفر شغال على البورت: ${PORT}`);
  console.log('');
});
