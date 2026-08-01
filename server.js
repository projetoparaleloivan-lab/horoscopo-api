const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

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
    relatorio TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Adiciona coluna relatorio se não existir (migração)
try { db.exec(`ALTER TABLE leads ADD COLUMN relatorio TEXT`); } catch(e) {}

const PIXEL_ID = process.env.PIXEL_ID || '834191219576803';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const KIWIFY_SECRET = process.env.KIWIFY_SECRET || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

function sha256(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

async function sendCapiEvent(eventName, email, name, value, eventId) {
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

async function gerarRelatorio(lead) {
  if (!anthropic) {
    console.warn('[CLAUDE] ANTHROPIC_API_KEY não configurada');
    return null;
  }

  const prompt = `Você é um astrólogo especialista em horóscopo personalizado. Gere um relatório místico e envolvente para a seguinte pessoa:

- Nome: ${lead.nome}
- Data de nascimento: ${lead.nascimento}
- Signo: ${lead.signo}
- Área de foco em Agosto: ${lead.area}
- Situação atual: ${lead.situacao}
- Sentimento sobre Agosto: ${lead.sentimento}

Crie um relatório completo de horóscopo VIP para Agosto com as seguintes seções:

1. **Visão Geral de Agosto para ${lead.signo}**
2. **${lead.area}: O que os astros revelam**
3. **Sua energia em Agosto** (baseado no sentimento "${lead.sentimento}")
4. **Conselho dos Astros** (baseado na situação "${lead.situacao}")
5. **Datas importantes de Agosto**
6. **Afirmação do mês**

Escreva de forma mística, pessoal e inspiradora. Use o nome ${lead.nome} ao longo do texto. Seja específico e detalhado. Aproximadamente 400-500 palavras.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const relatorio = message.content[0].text;
    console.log(`[CLAUDE] relatório gerado para ${lead.nome}`);
    return relatorio;
  } catch (e) {
    console.error('[CLAUDE] erro:', e.message);
    return null;
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
  if (email) sendCapiEvent('Lead', email, nome, null, 'lead_' + uuid).catch(() => {});

  res.json({ uuid });
});

// POST /api/webhook/kiwify
app.post('/api/webhook/kiwify', (req, res) => {
  const tokenRecebido = req.query.token || req.headers['x-kiwify-token'] || '';
  if (KIWIFY_SECRET && tokenRecebido !== KIWIFY_SECRET) {
    console.warn('[KIWIFY] token inválido:', tokenRecebido);
    return res.status(401).json({ error: 'unauthorized' });
  }

  res.json({ ok: true });
  console.log('[KIWIFY] payload:', JSON.stringify(req.body));

  const body = req.body;
  const status = body?.order_status || '';
  if (status !== 'paid') return;

  const uuid = body?.tracking?.src || body?.tracking?.sck || '';
  const email = body?.customer?.email || '';
  const name = body?.customer?.name || '';
  const amount = body?.order?.amount_cents ? body.order.amount_cents / 100 : 14.99;

  if (!uuid) { console.warn('[KIWIFY] uuid não encontrado'); return; }

  const lead = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(uuid);
  if (!lead) { console.warn('[KIWIFY] lead não encontrado uuid:', uuid); return; }

  const emailFinal = email || lead.email;
  const nameFinal = name || lead.nome;

  db.prepare('UPDATE leads SET paid = 1, email = CASE WHEN email = "" THEN ? ELSE email END, nome = CASE WHEN nome = "" THEN ? ELSE nome END WHERE uuid = ?')
    .run(emailFinal, nameFinal, uuid);

  sendCapiEvent('Purchase', emailFinal, nameFinal, amount, 'purchase_' + uuid).catch(console.error);
  console.log(`[KIWIFY] compra confirmada uuid=${uuid} nome=${nameFinal}`);

  // Gera relatório com Claude
  const leadAtualizado = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(uuid);
  gerarRelatorio(leadAtualizado).then(relatorio => {
    if (relatorio) {
      db.prepare('UPDATE leads SET relatorio = ? WHERE uuid = ?').run(relatorio, uuid);
      console.log(`[RELATORIO] salvo para uuid=${uuid}`);
    }
  }).catch(console.error);
});

// GET /api/leads (admin)
app.get('/api/leads', (req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 100').all();
  res.json(leads);
});

// GET /api/relatorio/:uuid
app.get('/api/relatorio/:uuid', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(req.params.uuid);
  if (!lead) return res.status(404).json({ error: 'não encontrado' });
  if (!lead.paid) return res.status(403).json({ error: 'pagamento não confirmado' });
  res.json({ nome: lead.nome, signo: lead.signo, area: lead.area, relatorio: lead.relatorio });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] rodando na porta ${PORT}`));
