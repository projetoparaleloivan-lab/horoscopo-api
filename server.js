const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const db = new Database('horoscopo.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    nome TEXT,
    email TEXT,
    nascimento TEXT,
    signo TEXT,
    area TEXT,
    situacao TEXT,
    sentimento TEXT,
    sinais TEXT,
    paid INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const PIXEL_ID = process.env.PIXEL_ID || '834191219576803';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const KIWIFY_SECRET = process.env.KIWIFY_SECRET || '';

function sha256(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

async function sendCapiEvent(eventName, email, name, value, eventId, extra) {
  if (!ACCESS_TOKEN) return;
  const userData = {};
  if (email) userData.em = [sha256(email)];
  if (name) userData.fn = [sha256(name.split(' ')[0])];

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId || (eventName + Date.now()),
      action_source: 'website',
      user_data: userData,
      custom_data: value ? { value, currency: 'BRL' } : {}
    }]
  };

  try {
    await fetch(`https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`[CAPI] ${eventName} disparado`);
  } catch (e) {
    console.error('[CAPI] erro:', e.message);
  }
}

function gerarUUID() {
  return Math.random().toString(36).slice(2, 9).toUpperCase();
}

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// POST /api/criar-sessao
app.post('/api/criar-sessao', (req, res) => {
  const { nome, email, nascimento, signo, area, situacao, sentimento, sinais } = req.body;

  if (!nome) return res.status(400).json({ error: 'nome obrigatório' });

  const uuid = gerarUUID();

  db.prepare(`
    INSERT INTO leads (uuid, nome, email, nascimento, signo, area, situacao, sentimento, sinais)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuid, nome, email || '', nascimento || '', signo || '', area || '', situacao || '', sentimento || '', sinais || '');

  console.log(`[SESSAO] criada uuid=${uuid} nome=${nome} signo=${signo} area=${area}`);

  if (email) sendCapiEvent('Lead', email, nome, null, 'lead_' + uuid, {}).catch(() => {});

  res.json({ uuid });
});

// POST /api/webhook/kiwify
app.post('/api/webhook/kiwify', (req, res) => {
  res.json({ ok: true });

  console.log('[KIWIFY] payload:', JSON.stringify(req.body));

  const body = req.body;
  const status = body?.order_status || '';

  if (status !== 'paid') return;

  const uuid = body?.tracking?.src || body?.tracking?.sck || '';
  const email = body?.customer?.email || '';
  const name = body?.customer?.name || '';
  const amount = body?.order?.amount_cents ? body.order.amount_cents / 100 : 14.99;

  if (!uuid) {
    console.warn('[KIWIFY] uuid não encontrado no webhook');
    return;
  }

  const lead = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(uuid);
  if (!lead) {
    console.warn('[KIWIFY] lead não encontrado para uuid:', uuid);
    return;
  }

  db.prepare('UPDATE leads SET paid = 1 WHERE uuid = ?').run(uuid);

  const emailFinal = email || lead.email;
  const nameFinal = name || lead.nome;

  sendCapiEvent('Purchase', emailFinal, nameFinal, amount, 'purchase_' + uuid, {}).catch(console.error);

  console.log(`[KIWIFY] compra confirmada uuid=${uuid} nome=${nameFinal} valor=${amount}`);
});

// GET /api/leads (admin)
app.get('/api/leads', (req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 100').all();
  res.json(leads);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] rodando na porta ${PORT}`));
