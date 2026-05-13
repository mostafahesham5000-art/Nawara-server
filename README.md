#شركة النوارة - نظام سحابي

## خطوات الرفع على Railway

### 1. قاعدة البيانات (Neon.tech) - مجاني
1. اذهب إلى https://neon.tech وسجّل حساب
2. أنشئ مشروع جديد → اسمه "nawara"
3. انسخ الـ Connection String (هيبدأ بـ postgresql://)

### 2. رفع الكود (GitHub)
1. اذهب إلى https://github.com وسجّل حساب
2. أنشئ Repository جديد اسمه "nawara-server"
3. ارفع ملفات المجلد ده

### 3. السيرفر (Railway) - مجاني
1. اذهب إلى https://railway.app وسجّل بحساب GitHub
2. New Project → Deploy from GitHub → اختار nawara-server
3. في Settings → Variables أضف:
   - DATABASE_URL = (الـ connection string من Neon)
   - NODE_ENV = production
4. Deploy!

## بعد الرفع
- هتلاقي رابط زي: https://nawara-server.up.railway.app
- افتحه من أي مكان في العالم 🌍
