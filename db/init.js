const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

let _initialized = false;

async function getDB() {
  const client = await pool.connect();

  client.run = async (sql, params = []) => {
    const pg = toPostgres(sql, params);
    await client.query(pg.sql, pg.params);
  };
  client.run2 = client.run;

  client.get2 = async (sql, params = []) => {
    const pg = toPostgres(sql, params);
    const res = await client.query(pg.sql, pg.params);
    return res.rows[0] || null;
  };

  client.all2 = async (sql, params = []) => {
    const pg = toPostgres(sql, params);
    const res = await client.query(pg.sql, pg.params);
    return res.rows;
  };

  client.lastId = async () => {
    const res = await client.query('SELECT lastval() as id');
    return parseInt(res.rows[0].id);
  };

  client.save = () => {};
  client.release_client = () => client.release();

  if (!_initialized) {
    await createTables(client);
    _initialized = true;
  }

  return client;
}

function toPostgres(sql, params) {
  let i = 0;
  let s = sql.replace(/\?/g, () => `$${++i}`);
  s = s
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
    .replace(/datetime\('now'\)/gi, "to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')")
    .replace(/PRAGMA[^;]*/gi, 'SELECT 1')
    .replace(/last_insert_rowid\(\)/gi, 'lastval()')
    .replace(/MAX\(0,\s*/g, 'GREATEST(0, ');
  return { sql: s, params };
}

async function createTables(client) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '',
      address TEXT DEFAULT '', balance REAL DEFAULT 0, notes TEXT DEFAULT '',
      created_at TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'))`,
    `CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '',
      address TEXT DEFAULT '', balance REAL DEFAULT 0, notes TEXT DEFAULT '',
      created_at TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'))`,
    `CREATE TABLE IF NOT EXISTS inventory_categories (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '📦', sort_order INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY, category_id INTEGER NOT NULL, name TEXT NOT NULL,
      unit TEXT DEFAULT 'قطعة', stock REAL DEFAULT 0, price REAL DEFAULT 0,
      notes TEXT DEFAULT '', created_at TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'))`,
    `CREATE TABLE IF NOT EXISTS product_images (
      id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL, filename TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY, type TEXT NOT NULL, date TEXT NOT NULL,
      party_type TEXT DEFAULT '', party_id INTEGER, party_name TEXT DEFAULT '',
      party_phone TEXT DEFAULT '', total REAL DEFAULT 0, payment_type TEXT DEFAULT 'كلي',
      paid REAL DEFAULT 0, remaining REAL DEFAULT 0, pay_method TEXT DEFAULT '',
      remaining_method TEXT DEFAULT '', remaining_cheque_date TEXT DEFAULT '',
      notes TEXT DEFAULT '', created_at TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'))`,
    `CREATE TABLE IF NOT EXISTS transaction_items (
      id SERIAL PRIMARY KEY, transaction_id INTEGER NOT NULL, product_name TEXT NOT NULL,
      qty REAL NOT NULL, unit TEXT DEFAULT 'قطعة', price REAL NOT NULL, subtotal REAL NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS revenues (
      id SERIAL PRIMARY KEY, date TEXT NOT NULL, amount REAL NOT NULL,
      description TEXT DEFAULT '', source TEXT DEFAULT 'يدوي',
      party_name TEXT DEFAULT '', tx_id INTEGER,
      created_at TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'))`,
    `CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY, date TEXT NOT NULL, amount REAL NOT NULL,
      description TEXT DEFAULT '', category TEXT DEFAULT 'أخرى',
      party_name TEXT DEFAULT '', tx_id INTEGER,
      created_at TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'))`,
    `CREATE TABLE IF NOT EXISTS collection (
      id SERIAL PRIMARY KEY, date TEXT NOT NULL, amount REAL NOT NULL,
      type TEXT DEFAULT 'كاش', party_name TEXT DEFAULT '', party_type TEXT DEFAULT '',
      party_id INTEGER, status TEXT DEFAULT 'معلق', notes TEXT DEFAULT '',
      cheque_image TEXT, tx_id INTEGER,
      created_at TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'))`
  ];
  for (const t of tables) await client.query(t);

  const { rows } = await client.query('SELECT COUNT(*) as c FROM inventory_categories');
  if (parseInt(rows[0].c) === 0) {
    const cats = [
      ['سقالات','🏗️',1],['كونتر','🔩',2],['شدة معدنية','⚙️',3],
      ['خشب تسليح','🪵',4],['خشب أبلكاش','📋',5],['أخرى','📦',6]
    ];
    for (const [name,icon,order] of cats)
      await client.query('INSERT INTO inventory_categories (name,icon,sort_order) VALUES ($1,$2,$3)',[name,icon,order]);
  }
}

module.exports = { getDB };
