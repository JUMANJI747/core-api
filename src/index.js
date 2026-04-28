'use strict';

const express = require('express');
const prisma = require('./db');

const app = express();
app.use(express.json({ limit: '5mb' }));

app.locals.prisma = prisma;

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || '').trim();

// ============ AUTH MIDDLEWARE ============
function auth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || '';
  if (key.trim() !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.use('/api', auth);

// ============ HEALTH ============
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true });
  } catch (e) {
    res.json({ ok: true, db: false, error: e.message });
  }
});

// ============ ROUTES ============
app.use('/api/contractors', require('./routes/contractors'));
app.use('/api/deals', require('./routes/deals'));
app.use('/api/consignments', require('./routes/consignments'));
app.use('/api', require('./routes/emails'));
app.use('/api/mailing', require('./routes/mailing'));
app.use('/api/products', require('./routes/products'));
app.use('/api', require('./routes/config'));
app.use('/api', require('./routes/invoices'));
app.use('/api/jpk', require('./routes/jpk'));
app.use('/api/jpk', require('./routes/jpk-package'));
app.use('/api', require('./routes/parse-document'));
app.use('/api', require('./routes/analytics'));
app.use('/api', require('./routes/glob'));

// ============ START ============
app.listen(PORT, () => {
  console.log(`Core API running on port ${PORT}`);
});

// ============ INBOX POLLER ============
require('./inbox-poller');
