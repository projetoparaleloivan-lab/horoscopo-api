const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
const puppeteer = require('puppeteer');
const tzlookup = require('tz-lookup');
const swissEphemeris = require('@swisseph/node');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Garante que o diretório de PDFs existe
const PDF_DIR = '/tmp/pdfs';
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || '/data/horoscopo.db';
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    nome TEXT,
    email TEXT,
    nascimento TEXT,
    horario TEXT,
    cidade TEXT,
    intencao TEXT,
    mapa_natal TEXT,
    signo TEXT,
    area TEXT,
    situacao TEXT,
    sentimento TEXT,
    sinais TEXT,
    paid INTEGER DEFAULT 0,
    relatorio TEXT,
    pdf_path TEXT,
    email_enviado_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Migrações seguras
try { db.exec(`ALTER TABLE leads ADD COLUMN email TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN nome TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN paid INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN created_at TEXT DEFAULT (datetime('now'))`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN relatorio TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN pdf_path TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN horario TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN cidade TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN intencao TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN mapa_natal TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN email_enviado_at TEXT`); } catch(e) {}
db.exec(`
  CREATE TABLE IF NOT EXISTS geocodes (
    cidade TEXT PRIMARY KEY,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    display_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const PIXEL_ID = process.env.PIXEL_ID || '834191219576803';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const KIWIFY_SECRET = process.env.KIWIFY_SECRET || '';
const ADMIN_TEST_TOKEN = process.env.ADMIN_TEST_TOKEN || KIWIFY_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || '';

const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

async function enviarRelatorioPorEmail(lead, pdfPath) {
  if (!RESEND_API_KEY || !RESEND_FROM) {
    console.warn('[EMAIL] RESEND_API_KEY/RESEND_FROM não configurados; envio ignorado');
    return false;
  }
  if (!lead.email || !pdfPath || !fs.existsSync(pdfPath)) return false;
  if (lead.email_enviado_at) return true;

  const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [lead.email],
      subject: 'Seu mapa astral completo está pronto ✨',
      html: `<p>Olá, ${lead.nome || 'tudo bem'}!</p><p>Seu mapa astral completo está pronto. O PDF com a sua leitura está em anexo.</p><p>Boa leitura! ✨</p>`,
      attachments: [{ filename: `Mapa_Astral_${lead.nome || 'completo'}.pdf`, content: pdfBase64 }]
    })
  });
  if (!response.ok) throw new Error(`Resend respondeu ${response.status}: ${await response.text()}`);

  db.prepare("UPDATE leads SET email_enviado_at = datetime('now') WHERE uuid = ?").run(lead.uuid);
  console.log(`[EMAIL] relatório enviado uuid=${lead.uuid} para=${lead.email}`);
  return true;
}

function sha256(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

const ZODIAC_SIGNS = [
  'Áries', 'Touro', 'Gêmeos', 'Câncer', 'Leão', 'Virgem',
  'Libra', 'Escorpião', 'Sagitário', 'Capricórnio', 'Aquário', 'Peixes'
];

function parseBirthDate(value) {
  const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) throw new Error('data de nascimento inválida');
  return { day: Number(match[1]), month: Number(match[2]), year: Number(match[3]) };
}

function parseBirthTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error('horário de nascimento inválido');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('horário de nascimento inválido');
  return { hour, minute };
}

async function geocodeCity(city) {
  const normalized = String(city || '').trim().toLowerCase();
  if (!normalized) throw new Error('cidade de nascimento não informada');

  const cached = db.prepare('SELECT latitude, longitude, display_name FROM geocodes WHERE cidade = ?').get(normalized);
  if (cached) return cached;

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&q=${encodeURIComponent(city)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'horoscopo-vip/1.0 (mapa-natal)' }
  });
  if (!response.ok) throw new Error(`geocodificação indisponível (${response.status})`);
  const results = await response.json();
  const result = results[0];
  if (!result || !Number.isFinite(Number(result.lat)) || !Number.isFinite(Number(result.lon))) {
    throw new Error('cidade de nascimento não encontrada');
  }

  const location = {
    latitude: Number(result.lat),
    longitude: Number(result.lon),
    display_name: result.display_name || city
  };
  db.prepare('INSERT OR REPLACE INTO geocodes (cidade, latitude, longitude, display_name) VALUES (?, ?, ?, ?)')
    .run(normalized, location.latitude, location.longitude, location.display_name);
  return location;
}

function localDateToUtc({ year, month, day, hour, minute }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]));
    const displayed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += target - displayed;
  }
  return new Date(guess);
}

function signForLongitude(longitude) {
  const normalized = ((longitude % 360) + 360) % 360;
  return ZODIAC_SIGNS[Math.floor(normalized / 30)];
}

function degreeInSign(longitude) {
  const normalized = ((longitude % 360) + 360) % 360;
  return Number((normalized % 30).toFixed(2));
}

function houseForLongitude(longitude, cusps) {
  const normalized = ((longitude % 360) + 360) % 360;
  for (let house = 1; house <= 12; house += 1) {
    const start = ((cusps[house] % 360) + 360) % 360;
    const end = ((cusps[house === 12 ? 1 : house + 1] % 360) + 360) % 360;
    const inside = start < end
      ? normalized >= start && normalized < end
      : normalized >= start || normalized < end;
    if (inside) return house;
  }
  return null;
}

async function calcularMapaNatal(lead) {
  const birthDate = parseBirthDate(lead.nascimento);
  const birthTime = parseBirthTime(lead.horario);
  const location = await geocodeCity(lead.cidade);
  const timeZone = tzlookup(location.latitude, location.longitude);
  const utcDate = localDateToUtc({ ...birthDate, ...birthTime }, timeZone);
  const jd = swissEphemeris.julianDay(
    utcDate.getUTCFullYear(), utcDate.getUTCMonth() + 1, utcDate.getUTCDate(),
    utcDate.getUTCHours() + utcDate.getUTCMinutes() / 60 + utcDate.getUTCSeconds() / 3600
  );
  const houses = swissEphemeris.calculateHouses(jd, location.latitude, location.longitude, swissEphemeris.HouseSystem.Placidus);
  const bodies = {
    Sol: swissEphemeris.Planet.Sun,
    Lua: swissEphemeris.Planet.Moon,
    Mercúrio: swissEphemeris.Planet.Mercury,
    Vênus: swissEphemeris.Planet.Venus,
    Marte: swissEphemeris.Planet.Mars,
    Júpiter: swissEphemeris.Planet.Jupiter,
    Saturno: swissEphemeris.Planet.Saturn,
    Urano: swissEphemeris.Planet.Uranus,
    Netuno: swissEphemeris.Planet.Neptune,
    Plutão: swissEphemeris.Planet.Pluto
  };
  const planetas = {};
  for (const [name, body] of Object.entries(bodies)) {
    const position = swissEphemeris.calculatePosition(jd, body);
    planetas[name] = {
      longitude: Number(position.longitude.toFixed(4)),
      latitude: Number(position.latitude.toFixed(4)),
      grau: degreeInSign(position.longitude),
      signo: signForLongitude(position.longitude),
      casa: houseForLongitude(position.longitude, houses.cusps),
      retrógrado: position.longitudeSpeed < 0
    };
  }

  const angles = {
    ascendente: { longitude: Number(houses.ascendant.toFixed(4)), signo: signForLongitude(houses.ascendant), grau: degreeInSign(houses.ascendant) },
    meioDoCeu: { longitude: Number(houses.mc.toFixed(4)), signo: signForLongitude(houses.mc), grau: degreeInSign(houses.mc) }
  };
  const cuspas = Array.from({ length: 12 }, (_, index) => ({
    casa: index + 1,
    longitude: Number(houses.cusps[index + 1].toFixed(4)),
    signo: signForLongitude(houses.cusps[index + 1]),
    grau: degreeInSign(houses.cusps[index + 1])
  }));

  return {
    sistema: 'Tropical · Placidus',
    nascimento: { data: lead.nascimento, horario: lead.horario, cidade: lead.cidade, fuso: timeZone, utc: utcDate.toISOString() },
    localizacao: { latitude: location.latitude, longitude: location.longitude, nome: location.display_name },
    angulos: angles,
    planetas,
    casas: cuspas,
    calculadoEm: new Date().toISOString()
  };
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

function parseJSONFlex(valor) {
  if (typeof valor !== 'string') return valor;
  const limpo = valor
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const inicio = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');
  return JSON.parse(inicio >= 0 && fim > inicio ? limpo.slice(inicio, fim + 1) : limpo);
}

async function gerarRelatorio(lead) {
  let mapaNatal = null;
  try {
    mapaNatal = lead.mapa_natal ? JSON.parse(lead.mapa_natal) : await calcularMapaNatal(lead);
    if (!lead.mapa_natal && mapaNatal) {
      db.prepare('UPDATE leads SET mapa_natal = ? WHERE uuid = ?').run(JSON.stringify(mapaNatal), lead.uuid);
    }
  } catch (error) {
    console.error('[MAPA NATAL] erro:', error.message);
  }

  if (!anthropic) {
    console.warn('[CLAUDE] ANTHROPIC_API_KEY não configurada');
    return null;
  }

  const secoesPorArea = {
    'Amor': {
      s1: 'visaoGeral: visão geral de Agosto 2026 para o coração de {signo}. Tom poético e esperançoso.',
      s2: 'situacaoAtual: análise profunda da situação amorosa atual de {nome} baseada em "{situacao}". Tom empático.',
      s3: 'energiaAmorosa: a energia de Vênus e como ela influencia o magnetismo e a atração de {nome} em Agosto.',
      s4: 'relacionamentos: perspectivas para relacionamentos — quem está só, quem está junto, o que os astros revelam.',
      s5: 'comunicacaoConflitos: como {nome} deve lidar com comunicação, conflitos e aproximações em Agosto.',
      s6: 'almaGemea: sinais cósmicos sobre conexões especiais, encontros marcantes e possíveis vínculos de alma.',
      s7: 'calendario: 6 datas importantes de Agosto especificamente para o amor de {nome}.',
      s8: 'transitos: trânsitos de Vênus, Marte e Lua que afetam o amor de {signo} em Agosto. Detalhado.',
      s9: 'mensagemCanalizada: mensagem especial dos astros sobre o amor de {nome}. Tom espiritual e tocante.',
      s10: 'afirmacoes: 7 afirmações poderosas de amor e atração para {nome} repetir em Agosto.'
    },
    'Dinheiro': {
      s1: 'visaoGeral: visão geral de Agosto 2026 para a prosperidade de {signo}. Tom encorajador.',
      s2: 'situacaoAtual: análise da situação financeira atual de {nome} baseada em "{situacao}". Tom realista e motivador.',
      s3: 'oportunidades: oportunidades de ganho, negócios e abundância que os astros revelam para {nome} em Agosto.',
      s4: 'investimentos: o que fazer com dinheiro em Agosto — investir, poupar, empreender? Guia astral.',
      s5: 'bloqueios: bloqueios energéticos que podem impedir a prosperidade e como {nome} pode superá-los.',
      s6: 'atracaoAbundancia: práticas e rituais astrológicos para atrair abundância financeira em Agosto.',
      s7: 'calendario: 6 datas importantes de Agosto especificamente para finanças e dinheiro de {nome}.',
      s8: 'transitos: trânsitos de Júpiter, Saturno e Mercúrio que afetam as finanças de {signo} em Agosto.',
      s9: 'mensagemCanalizada: mensagem especial dos astros sobre a prosperidade de {nome}. Tom espiritual.',
      s10: 'afirmacoes: 7 afirmações poderosas de abundância e prosperidade para {nome} em Agosto.'
    },
    'Trabalho': {
      s1: 'visaoGeral: visão geral de Agosto 2026 para a carreira de {signo}. Tom motivador e inspirador.',
      s2: 'situacaoAtual: análise da situação profissional atual de {nome} baseada em "{situacao}". Tom estratégico.',
      s3: 'oportunidades: projetos, oportunidades e portas que se abrem para {nome} no trabalho em Agosto.',
      s4: 'reconhecimento: como {nome} pode ser visto, valorizado e reconhecido profissionalmente em Agosto.',
      s5: 'desafios: desafios profissionais de Agosto e como {nome} deve navegar por eles com sabedoria astral.',
      s6: 'proposito: alinhamento entre propósito de vida e carreira — o que os astros dizem para {nome}.',
      s7: 'calendario: 6 datas importantes de Agosto especificamente para a carreira de {nome}.',
      s8: 'transitos: trânsitos de Marte, Saturno e Sol que afetam a carreira de {signo} em Agosto.',
      s9: 'mensagemCanalizada: mensagem especial dos astros sobre o propósito e sucesso de {nome}. Tom espiritual.',
      s10: 'afirmacoes: 7 afirmações poderosas de sucesso e realização profissional para {nome} em Agosto.'
    },
    'Saúde': {
      s1: 'visaoGeral: visão geral de Agosto 2026 para a energia vital de {signo}. Tom cuidadoso e luminoso.',
      s2: 'situacaoAtual: análise da situação de saúde e bem-estar de {nome} baseada em "{situacao}". Tom empático.',
      s3: 'energiaVital: como a energia física e mental de {nome} está configurada pelos astros em Agosto.',
      s4: 'equilibrioEmocional: saúde emocional, paz interior e equilíbrio mental que {nome} precisa cultivar.',
      s5: 'praticasRecomendadas: práticas, exercícios e rituais astrológicos recomendados para {signo} em Agosto.',
      s6: 'alimentacaoRituais: alimentos, ervas e rituais de cura alinhados com a energia de {signo} em Agosto.',
      s7: 'calendario: 6 datas importantes de Agosto especificamente para a saúde e bem-estar de {nome}.',
      s8: 'transitos: trânsitos da Lua, Mercúrio e Quíron que afetam a saúde de {signo} em Agosto.',
      s9: 'mensagemCanalizada: mensagem especial dos astros sobre a cura e vitalidade de {nome}. Tom espiritual.',
      s10: 'afirmacoes: 7 afirmações poderosas de saúde, vitalidade e equilíbrio para {nome} em Agosto.'
    }
  };

  const secoes = secoesPorArea[lead.area] || secoesPorArea['Amor'];
  const substituir = (txt) => txt.replace(/{nome}/g, lead.nome).replace(/{signo}/g, lead.signo).replace(/{situacao}/g, lead.situacao).replace(/{sentimento}/g, lead.sentimento);

  const prompt = `Você é um astrólogo especialista de alto nível. Gere uma leitura visual e envolvente de mapa astral e previsões, FOCADA EM ${lead.area.toUpperCase()}, para ${lead.nome}. O texto deve parecer uma leitura particular, não um TCC ou artigo acadêmico.

- Nome: ${lead.nome}
- Data de nascimento: ${lead.nascimento}
- Horário de nascimento: ${lead.horario || 'não informado'}
- Cidade de nascimento: ${lead.cidade || 'não informada'}
- Intenção principal da leitura: ${lead.intencao || 'autoconhecimento'}

Dados calculados do mapa natal:
${mapaNatal ? JSON.stringify(mapaNatal) : 'Mapa natal indisponível; não invente posições planetárias.'}

Quando o mapa natal estiver disponível, use somente as posições e casas fornecidas acima para falar de Sol, Lua, Ascendente e planetas. Não invente graus, casas ou aspectos. Explique que a leitura é simbólica e não substitui orientação médica, financeira ou profissional.
- Signo: ${lead.signo}
- Área de foco: ${lead.area}
- Situação atual: ${lead.situacao}
- Sentimento sobre Agosto: ${lead.sentimento}

REGRA CENTRAL DE PERSONALIZAÇÃO: em todas as seções, conecte explicitamente o signo ${lead.signo}, a área escolhida (${lead.area}), a intenção "${lead.intencao || 'autoconhecimento'}" e o sentimento "${lead.sentimento || 'não informado'}". Não escreva previsões genéricas que serviriam para qualquer signo. Use o mapa natal para explicar por que aquela previsão faz sentido para esta pessoa. Prefira parágrafos curtos, subtítulos naturais e frases diretas.

Retorne SOMENTE um JSON válido com exatamente estas 11 chaves (sem markdown, sem blocos de código):

{
  "visaoGeral": "${substituir(secoes.s1)} Mínimo 200 palavras.",
  "mapaLeitura": "Interprete o Sol, a Lua, o Ascendente e os pontos do mapa mais relevantes para ${lead.area}, sempre conectando ${lead.signo} à previsão escolhida. Mínimo 180 palavras.",
  "secao2": "${substituir(secoes.s2)} Mínimo 180 palavras.",
  "secao3": "${substituir(secoes.s3)} Mínimo 180 palavras.",
  "secao4": "${substituir(secoes.s4)} Mínimo 180 palavras.",
  "secao5": "${substituir(secoes.s5)} Mínimo 180 palavras.",
  "secao6": "${substituir(secoes.s6)} Mínimo 150 palavras.",
  "calendario": ["Dia X de Agosto: evento específico para ${lead.nome}", "Dia X...", "Dia X...", "Dia X...", "Dia X...", "Dia X..."],
  "transitos": "${substituir(secoes.s8)} Mínimo 200 palavras.",
  "mensagemCanalizada": "${substituir(secoes.s9)} Entre 120 e 160 palavras.",
  "afirmacoes": ["${substituir(secoes.s10).split(':')[0]} 1", "...2", "...3", "...4", "...5", "...6", "...7"],
  "encerramento": "Fechamento curto, íntimo e motivador, retomando ${lead.signo}, ${lead.area} e a intenção escolhida. Entre 80 e 120 palavras."
}

IMPORTANTE: Retorne APENAS o JSON. Sem texto extra. Sem explicações.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });
    const texto = message.content[0].text.trim();
    console.log(`[CLAUDE] relatório gerado para ${lead.nome}`);

    // Tenta parsear como JSON; se falhar, retorna o texto bruto para compatibilidade
    try {
      const parsed = parseJSONFlex(texto);
      return JSON.stringify(parsed);
    } catch (parseErr) {
      console.warn('[CLAUDE] resposta não é JSON válido, salvando como texto bruto');
      return texto;
    }
  } catch (e) {
    console.error('[CLAUDE] erro:', e.message);
    return null;
  }
}

// ─── HTML Template para o PDF ───────────────────────────────────────────────

const titulosSecoes = {
  'Amor':     ['Situação Amorosa Atual', 'Energia & Magnetismo', 'Relacionamentos & Conexões', 'Comunicação & Conflitos'],
  'Dinheiro': ['Situação Financeira Atual', 'Oportunidades de Ganho', 'Investimentos & Decisões', 'Bloqueios & Rituais de Abundância'],
  'Trabalho': ['Situação Profissional Atual', 'Oportunidades & Projetos', 'Reconhecimento & Liderança', 'Desafios & Propósito'],
  'Saúde':    ['Situação Atual de Saúde', 'Energia Vital & Mental', 'Práticas Recomendadas', 'Alimentação & Rituais de Cura']
};

const iconesSecoes = {
  'Amor':     ['❤️', '💫', '🏹', '🌹'],
  'Dinheiro': ['💰', '🌟', '📈', '🏺'],
  'Trabalho': ['💼', '🚀', '🏆', '⚡'],
  'Saúde':    ['🌿', '✨', '🧘', '🍃']
};

function gerarHTML(lead, dados) {
  const mesAno = 'Agosto 2026';
  const signoEmoji = {
    'Áries': '♈', 'Touro': '♉', 'Gêmeos': '♊', 'Câncer': '♋',
    'Leão': '♌', 'Virgem': '♍', 'Libra': '♎', 'Escorpião': '♏',
    'Sagitário': '♐', 'Capricórnio': '♑', 'Aquário': '♒', 'Peixes': '♓'
  };
  const simbolo = signoEmoji[lead.signo] || '✦';

  // Garante que afirmacoes e calendario são arrays
  const afirmacoes = Array.isArray(dados.afirmacoes) ? dados.afirmacoes : [];
  const calendario = Array.isArray(dados.calendario) ? dados.calendario : [];
  let mapaNatal = null;
  try { mapaNatal = lead.mapa_natal ? JSON.parse(lead.mapa_natal) : null; } catch (_) {}
  const mapaPlanetas = mapaNatal ? Object.entries(mapaNatal.planetas || {}) : [];

  const divider = `<div class="divider"><span>✦</span><span>✦</span><span>✦</span></div>`;
  const foco = `<div class="foco-pill"><span>FOCO DA LEITURA</span><strong>${lead.signo} · ${lead.area}</strong><em>${lead.intencao || 'Sua intenção pessoal'}</em></div>`;

  const paginaSecao = (numero, titulo, icone, conteudo) => `
    <div class="pagina secao-pagina">
      <div class="pagina-numero">${numero} / 10</div>
      <div class="secao-icone">${icone}</div>
      <h2 class="secao-titulo">${titulo}</h2>
      ${divider}
      ${foco}
      <div class="secao-corpo">${conteudo}</div>
      <div class="rodape">Mapa e Previsões · ${lead.nome} · ${lead.signo} · ${mesAno}</div>
    </div>
  `;

  const paragrafo = (txt) => `<p>${txt}</p>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mapa e Previsões · ${lead.nome} · ${mesAno}</title>
<style>
  @font-face {
    font-family: 'Cinzel';
    src: local('Georgia'), local('Times New Roman'), local('serif');
  }

  :root {
    --bg-profundo: #070510;
    --bg-secundario: #0d0b1e;
    --bg-card: #110f25;
    --dourado-sol: #f3ba2f;
    --dourado-claro: #ffe8aa;
    --dourado-escuro: #c9922a;
    --magenta-astral: #d946ef;
    --lilas-brilhante: #c084fc;
    --azul-astral: #818cf8;
    --texto-marfim: #f8f5ee;
    --texto-suave: #c9c3b8;
    --texto-dimmer: #7a7369;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg-profundo);
    color: var(--texto-marfim);
    font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 13pt;
    line-height: 1.8;
  }

  /* ── Estrelas de fundo ── */
  .pagina {
    position: relative;
    width: 210mm;
    min-height: 297mm;
    padding: 18mm 16mm 16mm;
    overflow: hidden;
    page-break-after: always;
    background: var(--bg-profundo);
  }

  .pagina::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image:
      radial-gradient(1px 1px at 12% 18%, rgba(255,232,170,0.55) 0%, transparent 100%),
      radial-gradient(1px 1px at 87% 9%,  rgba(255,232,170,0.4)  0%, transparent 100%),
      radial-gradient(1px 1px at 34% 72%, rgba(255,232,170,0.45) 0%, transparent 100%),
      radial-gradient(1px 1px at 65% 55%, rgba(255,232,170,0.35) 0%, transparent 100%),
      radial-gradient(1px 1px at 5%  90%, rgba(255,232,170,0.3)  0%, transparent 100%),
      radial-gradient(1px 1px at 92% 78%, rgba(255,232,170,0.5)  0%, transparent 100%),
      radial-gradient(1px 1px at 48% 12%, rgba(255,232,170,0.3)  0%, transparent 100%),
      radial-gradient(1px 1px at 22% 44%, rgba(255,232,170,0.35) 0%, transparent 100%),
      radial-gradient(1px 1px at 78% 31%, rgba(255,232,170,0.4)  0%, transparent 100%),
      radial-gradient(1px 1px at 55% 85%, rgba(255,232,170,0.45) 0%, transparent 100%),
      radial-gradient(1.5px 1.5px at 40% 60%, rgba(217,70,239,0.25) 0%, transparent 100%),
      radial-gradient(1.5px 1.5px at 70% 20%, rgba(192,132,252,0.2) 0%, transparent 100%);
    pointer-events: none;
    z-index: 0;
  }

  .pagina > * { position: relative; z-index: 1; }

  /* ─────────────── CAPA ─────────────── */
  .capa {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    background: radial-gradient(ellipse at 50% 30%, #1a0f3a 0%, var(--bg-profundo) 70%);
    min-height: 297mm;
  }

  .capa::after {
    content: '';
    position: absolute;
    inset: 0;
    border: 1.5px solid transparent;
    background: linear-gradient(var(--bg-profundo), var(--bg-profundo)) padding-box,
                linear-gradient(135deg, var(--dourado-sol), var(--magenta-astral), var(--dourado-sol)) border-box;
    pointer-events: none;
    z-index: 0;
  }

  .capa-badge {
    font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 8pt;
    font-weight: 600;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: var(--dourado-sol);
    background: rgba(243,186,47,0.08);
    border: 1px solid rgba(243,186,47,0.3);
    padding: 6px 20px;
    border-radius: 40px;
    margin-bottom: 40px;
  }

  .capa-simbolo {
    font-size: 110pt;
    background: linear-gradient(135deg, var(--dourado-sol) 0%, var(--dourado-claro) 40%, var(--magenta-astral) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    line-height: 1;
    margin-bottom: 30px;
    filter: drop-shadow(0 0 30px rgba(243,186,47,0.4));
  }

  .capa-subtitulo {
    font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 9pt;
    font-weight: 500;
    letter-spacing: 5px;
    text-transform: uppercase;
    color: var(--lilas-brilhante);
    margin-bottom: 16px;
  }

  .capa-nome {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 32pt;
    font-weight: 700;
    background: linear-gradient(135deg, var(--dourado-claro), var(--dourado-sol));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 8px;
    line-height: 1.2;
  }

  .capa-signo {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 15pt;
    font-weight: 400;
    color: var(--texto-suave);
    letter-spacing: 2px;
    margin-bottom: 40px;
  }

  .capa-linha {
    width: 60%;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--dourado-sol), transparent);
    margin: 0 auto 40px;
  }

  .capa-titulo-principal {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 24pt;
    font-weight: 900;
    background: linear-gradient(135deg, var(--dourado-sol), var(--dourado-claro), var(--magenta-astral));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    line-height: 1.3;
    margin-bottom: 20px;
  }

  .capa-mes {
    font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 11pt;
    font-weight: 300;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: var(--dourado-claro);
    margin-bottom: 60px;
  }

  .capa-rodape {
    font-size: 8pt;
    color: var(--texto-dimmer);
    letter-spacing: 3px;
    text-transform: uppercase;
  }

  /* ─────────────── PÁGINAS DE SEÇÃO ─────────────── */
  .secao-pagina {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .pagina-numero {
    position: absolute;
    top: 12mm;
    right: 16mm;
    font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 7.5pt;
    color: var(--texto-dimmer);
    letter-spacing: 2px;
  }

  .secao-icone {
    font-size: 36pt;
    text-align: center;
    margin-bottom: 12px;
    filter: drop-shadow(0 0 12px rgba(243,186,47,0.5));
    line-height: 1;
  }

  .secao-titulo {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 20pt;
    font-weight: 700;
    text-align: center;
    background: linear-gradient(135deg, var(--dourado-sol), var(--dourado-claro));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 16px;
    line-height: 1.3;
  }

  .divider {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-bottom: 28px;
    color: var(--dourado-sol);
    font-size: 8pt;
    opacity: 0.7;
  }

  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--dourado-escuro));
  }

  .divider::after {
    background: linear-gradient(90deg, var(--dourado-escuro), transparent);
  }

  .secao-corpo {
    flex: 1;
    color: var(--texto-marfim);
    font-size: 11.5pt;
    line-height: 1.85;
  }

  .secao-corpo p {
    margin-bottom: 16px;
  }

  .secao-corpo p:last-child {
    margin-bottom: 0;
  }

  .foco-pill {
    display: flex;
    align-items: center;
    gap: 10px;
    width: fit-content;
    max-width: 100%;
    margin: 0 auto 24px;
    padding: 7px 14px;
    border: 1px solid rgba(243,186,47,0.28);
    border-radius: 999px;
    background: rgba(243,186,47,0.07);
    color: var(--dourado-claro);
    font-size: 8.5pt;
    line-height: 1.2;
  }

  .foco-pill span { color: var(--lilas-brilhante); letter-spacing: 1.5px; font-size: 7pt; }
  .foco-pill strong { color: var(--dourado-claro); }
  .foco-pill em { color: var(--texto-suave); font-style: normal; }

  .mapa-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 24px;
  }

  .mapa-leitura {
    margin-bottom: 22px;
    padding: 16px 18px;
    border-left: 3px solid var(--magenta-astral);
    border-radius: 0 10px 10px 0;
    background: linear-gradient(135deg, rgba(217,70,239,0.08), rgba(129,140,248,0.05));
  }

  .mapa-leitura p { margin: 0; font-size: 10.8pt; line-height: 1.7; }

  .mapa-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    border: 1px solid rgba(243,186,47,0.18);
    border-radius: 8px;
    background: rgba(243,186,47,0.04);
    font-size: 10.5pt;
  }

  .mapa-item span {
    color: var(--texto-suave);
    font-size: 9.5pt;
  }

  /* ─── Calendário ─── */
  .calendario-lista {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .calendario-item {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    background: rgba(243,186,47,0.04);
    border: 1px solid rgba(243,186,47,0.15);
    border-left: 3px solid var(--dourado-sol);
    border-radius: 0 8px 8px 0;
    padding: 12px 16px;
  }

  .calendario-icone {
    font-size: 14pt;
    line-height: 1.4;
    flex-shrink: 0;
  }

  .calendario-texto {
    font-size: 10.5pt;
    line-height: 1.65;
    color: var(--texto-marfim);
  }

  /* ─── Afirmações ─── */
  .afirmacoes-lista {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .afirmacao-item {
    display: flex;
    gap: 14px;
    align-items: center;
    background: linear-gradient(135deg, rgba(217,70,239,0.06), rgba(192,132,252,0.06));
    border: 1px solid rgba(192,132,252,0.2);
    border-radius: 10px;
    padding: 14px 18px;
  }

  .afirmacao-numero {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 18pt;
    font-weight: 700;
    background: linear-gradient(135deg, var(--magenta-astral), var(--lilas-brilhante));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    min-width: 32px;
    line-height: 1;
    flex-shrink: 0;
  }

  .afirmacao-texto {
    font-size: 10.5pt;
    font-style: italic;
    color: var(--dourado-claro);
    line-height: 1.5;
  }

  /* ─── Mensagem canalizada ─── */
  .mensagem-card {
    background: linear-gradient(135deg, rgba(129,140,248,0.08), rgba(192,132,252,0.08));
    border: 1px solid rgba(192,132,252,0.25);
    border-radius: 12px;
    padding: 28px 30px;
    text-align: center;
    margin-top: 12px;
  }

  .mensagem-card p {
    font-size: 12pt;
    font-style: italic;
    color: var(--dourado-claro);
    line-height: 1.9;
    margin: 0;
  }

  .mensagem-aspas {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 48pt;
    background: linear-gradient(135deg, var(--magenta-astral), var(--lilas-brilhante));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    line-height: 0.6;
    display: block;
    margin-bottom: 16px;
    text-align: left;
  }

  /* ─── Transitos tag ─── */
  .planeta-tag {
    display: inline-block;
    background: rgba(243,186,47,0.1);
    border: 1px solid rgba(243,186,47,0.3);
    border-radius: 20px;
    padding: 2px 10px;
    font-size: 9pt;
    color: var(--dourado-sol);
    margin: 2px;
    font-weight: 600;
  }

  /* ─── Rodapé das seções ─── */
  .rodape {
    margin-top: auto;
    padding-top: 20px;
    text-align: center;
    font-size: 7.5pt;
    color: var(--texto-dimmer);
    letter-spacing: 2px;
    border-top: 1px solid rgba(243,186,47,0.1);
  }

  /* ─── Encerramento especial ─── */
  .encerramento-box {
    background: linear-gradient(135deg, rgba(243,186,47,0.06), rgba(217,70,239,0.06));
    border: 1px solid rgba(243,186,47,0.2);
    border-radius: 12px;
    padding: 24px 28px;
  }

  @media print {
    .pagina { page-break-after: always; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>

<!-- ════════════════════ PÁGINA 1 — CAPA ════════════════════ -->
  <div class="pagina capa">
  <div class="capa-badge">✦ Relatório Exclusivo · Edição VIP ✦</div>
  <div class="capa-simbolo">${simbolo}</div>
  <div class="capa-subtitulo">Mapa astral personalizado</div>
  <div class="capa-nome">${lead.nome}</div>
  <div class="capa-signo">${lead.signo} · ${lead.nascimento || ''}</div>
  <div class="capa-linha"></div>
  <div class="capa-titulo-principal">Mapa e Previsões<br>${mesAno}</div>
  <div class="capa-mes">✦ Revelações Astrais Exclusivas ✦</div>
  <div class="capa-rodape">Produzido especialmente para você · Documento confidencial</div>
</div>

<!-- ════════════════════ PÁGINA 2 — VISÃO GERAL ════════════════════ -->
${paginaSecao(2, `Visão Geral de ${mesAno}`, '🌌', paragrafo(dados.visaoGeral || ''))}

${mapaNatal ? `
<div class="pagina secao-pagina">
  <div class="pagina-numero">3 / 11</div>
  <div class="secao-icone">🪐</div>
  <h2 class="secao-titulo">Seu Mapa Natal</h2>
  ${divider}
  ${foco}
  <div class="secao-corpo">
    <div class="mapa-leitura">${paragrafo(dados.mapaLeitura || `Seu mapa natal é a base simbólica desta leitura de ${lead.area}.` )}</div>
    <p><strong>Nascimento:</strong> ${mapaNatal.nascimento?.data || lead.nascimento} às ${mapaNatal.nascimento?.horario || lead.horario}, ${mapaNatal.nascimento?.cidade || lead.cidade}.</p>
    <p><strong>Ascendente:</strong> ${mapaNatal.angulos?.ascendente?.signo || '—'} a ${mapaNatal.angulos?.ascendente?.grau ?? '—'}° · <strong>Meio do Céu:</strong> ${mapaNatal.angulos?.meioDoCeu?.signo || '—'} a ${mapaNatal.angulos?.meioDoCeu?.grau ?? '—'}°</p>
    <div class="mapa-grid">
      ${mapaPlanetas.map(([nome, planeta]) => `<div class="mapa-item"><strong>${nome}</strong><span>${planeta.signo} · ${planeta.grau}° · Casa ${planeta.casa || '—'}${planeta.retrógrado ? ' · retrógrado' : ''}</span></div>`).join('')}
    </div>
  </div>
  <div class="rodape">Mapa calculado com efemérides astronômicas · ${lead.nome}</div>
</div>` : ''}

<!-- ════════════════════ PÁGINAS 3-6 — SEÇÕES DA ÁREA ESCOLHIDA ════════════════════ -->
${paginaSecao(4, titulosSecoes[lead.area]?.[0] || lead.area, iconesSecoes[lead.area]?.[0] || '✨', paragrafo(dados.secao2 || ''))}
${paginaSecao(5, titulosSecoes[lead.area]?.[1] || lead.area, iconesSecoes[lead.area]?.[1] || '✨', paragrafo(dados.secao3 || ''))}
${paginaSecao(6, titulosSecoes[lead.area]?.[2] || lead.area, iconesSecoes[lead.area]?.[2] || '✨', paragrafo(dados.secao4 || ''))}
${paginaSecao(7, titulosSecoes[lead.area]?.[3] || lead.area, iconesSecoes[lead.area]?.[3] || '✨', paragrafo(dados.secao5 || ''))}

<!-- ════════════════════ PÁGINA 7 — CALENDÁRIO ════════════════════ -->
<div class="pagina secao-pagina">
  <div class="pagina-numero">8 / 11</div>
  <div class="secao-icone">📅</div>
  <h2 class="secao-titulo">Calendário Astral de ${mesAno}</h2>
  ${divider}
  <div class="secao-corpo">
    <ul class="calendario-lista">
      ${calendario.map(item => `
        <li class="calendario-item">
          <span class="calendario-icone">⭐</span>
          <span class="calendario-texto">${item}</span>
        </li>
      `).join('')}
    </ul>
  </div>
  <div class="rodape">Mapa e Previsões · ${lead.nome} · ${lead.signo} · ${mesAno}</div>
</div>

<!-- ════════════════════ PÁGINA 8 — TRÂNSITOS ════════════════════ -->
${paginaSecao(9, 'Trânsitos Planetários', '🪐', paragrafo(dados.transitos || ''))}

<!-- ════════════════════ PÁGINA 9 — MENSAGEM CANALIZADA ════════════════════ -->
<div class="pagina secao-pagina">
  <div class="pagina-numero">10 / 11</div>
  <div class="secao-icone">🔮</div>
  <h2 class="secao-titulo">Mensagem dos Astros para Você</h2>
  ${divider}
  <div class="secao-corpo">
    <div class="mensagem-card">
      <span class="mensagem-aspas">"</span>
      <p>${dados.mensagemCanalizada || ''}</p>
    </div>
  </div>
  <div style="margin-top:32px">
    <h3 style="font-family:'Cinzel',serif;font-size:13pt;color:var(--lilas-brilhante);margin-bottom:20px;text-align:center;letter-spacing:2px;">AFIRMAÇÕES DO MÊS</h3>
    <ul class="afirmacoes-lista">
      ${afirmacoes.map((af, i) => `
        <li class="afirmacao-item">
          <span class="afirmacao-numero">${String(i + 1).padStart(2, '0')}</span>
          <span class="afirmacao-texto">${af}</span>
        </li>
      `).join('')}
    </ul>
  </div>
  <div class="rodape">Mapa e Previsões · ${lead.nome} · ${lead.signo} · ${mesAno}</div>
</div>

<!-- ════════════════════ PÁGINA 10 — ENCERRAMENTO ════════════════════ -->
<div class="pagina secao-pagina">
  <div class="pagina-numero">11 / 11</div>
  <div class="secao-icone">🌟</div>
  <h2 class="secao-titulo">Sua Jornada Continua</h2>
  ${divider}
  <div class="secao-corpo">
    <div class="encerramento-box">
      ${paragrafo(dados.encerramento || '')}
    </div>
  </div>
  <div style="margin-top:40px;text-align:center;">
    <div style="font-size:48pt;margin-bottom:12px;filter:drop-shadow(0 0 20px rgba(243,186,47,0.5));">${simbolo}</div>
    <div style="font-family:'Cinzel',serif;font-size:13pt;background:linear-gradient(135deg,var(--dourado-sol),var(--dourado-claro));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:3px;">
      ${lead.nome.toUpperCase()}
    </div>
    <div style="font-size:8.5pt;color:var(--texto-dimmer);letter-spacing:3px;margin-top:6px;text-transform:uppercase;">
      ${lead.signo} · ${mesAno}
    </div>
    <div style="width:50%;height:1px;background:linear-gradient(90deg,transparent,var(--dourado-sol),transparent);margin:20px auto;"></div>
    <div style="font-size:8pt;color:var(--texto-dimmer);letter-spacing:2px;">
      ✦ Os astros sempre falam — basta aprender a ouvi-los ✦
    </div>
  </div>
  <div class="rodape">Mapa e Previsões · ${lead.nome} · ${lead.signo} · ${mesAno}</div>
</div>

</body>
</html>`;
}

// ─── Geração do PDF com Puppeteer ────────────────────────────────────────────

async function gerarPDF(lead, relatorioBruto) {
  let dados;
  try {
    if (typeof relatorioBruto === 'string') {
      // O modelo às vezes envolve o JSON em ```json ... ```. Removemos esse
      // invólucro e também toleramos texto incidental antes/depois do objeto.
      dados = parseJSONFlex(relatorioBruto);
    } else {
      dados = relatorioBruto;
    }
  } catch (e) {
    // Se não for JSON, monta um objeto simples com o texto na visão geral
    dados = {
      visaoGeral: relatorioBruto || '', mapaLeitura: '',
      secao2: '', secao3: '', secao4: '', secao5: '', secao6: '',
      calendario: [], transitos: '', mensagemCanalizada: '',
      afirmacoes: [], encerramento: ''
    };
  }

  const html = gerarHTML(lead, dados);
  const pdfPath = path.join(PDF_DIR, `horoscopo_${lead.uuid}.pdf`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (req.resourceType() === 'font' || req.url().includes('fonts.googleapis') || req.url().includes('fonts.gstatic')) {
        req.abort();
      } else {
        req.continue();
      }
    });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);

    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });

    console.log(`[PDF] gerado em ${pdfPath}`);
    return pdfPath;
  } finally {
    await browser.close();
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

// ─────────────────── ENDPOINTS ───────────────────────────────────────────────

// POST /api/criar-sessao
app.post('/api/criar-sessao', (req, res) => {
  const { uuid: uuidRecebido, nome, email, nascimento, horario, cidade, intencao, signo, area, situacao, sentimento, sinais } = req.body;
  if (!nome) return res.status(400).json({ error: 'nome obrigatório' });

  const uuid = uuidRecebido || gerarUUID();
  db.prepare(`
    INSERT INTO leads (uuid, nome, email, nascimento, horario, cidade, intencao, signo, area, situacao, sentimento, sinais)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuid, nome, email || '', nascimento || '', horario || '', cidade || '', intencao || '', signo || '', area || '', situacao || '', sentimento || '', sinais || '');

  console.log(`[SESSAO] criada uuid=${uuid} nome=${nome} signo=${signo} area=${area}`);
  if (email) sendCapiEvent('Lead', email, nome, null, 'lead_' + uuid).catch(() => {});

  res.json({ uuid });
});

// POST /api/webhook/kiwify
app.post('/api/webhook/kiwify', (req, res) => {
  // A Kiwify assina o JSON com o token configurado no webhook e envia
  // a assinatura no parâmetro `signature` da URL. Mantemos também o
  // formato de token direto para compatibilidade com integrações antigas.
  const tokenRecebido = req.query.token || req.headers['x-kiwify-token'] || '';
  const assinaturaRecebida = req.query.signature || req.headers['x-kiwify-signature'] || '';
  const assinaturaEsperada = KIWIFY_SECRET
    ? crypto.createHmac('sha1', KIWIFY_SECRET).update(JSON.stringify(req.body)).digest('hex')
    : '';
  const assinaturaValida = assinaturaRecebida && assinaturaEsperada &&
    assinaturaRecebida.length === assinaturaEsperada.length &&
    crypto.timingSafeEqual(Buffer.from(assinaturaRecebida), Buffer.from(assinaturaEsperada));
  const autenticado = !KIWIFY_SECRET || tokenRecebido === KIWIFY_SECRET || assinaturaValida;
  if (!autenticado) {
    console.warn('[KIWIFY] assinatura/token inválido');
    return res.status(401).json({ error: 'unauthorized' });
  }

  res.json({ ok: true });
  console.log('[KIWIFY] payload:', JSON.stringify(req.body));

  const body = req.body;
  const status = body?.order_status || '';
  if (status !== 'paid') return;

  const tracking = body?.tracking || body?.TrackingParameters || {};
  const customer = body?.customer || body?.Cliente || {};
  let uuid = tracking.src || tracking.sck || '';
  const email = customer.email || '';
  const name = customer.name || customer.full_name || '';
  const amount = body?.order?.amount_cents ? body.order.amount_cents / 100 : 14.99;

  if (!uuid && !email) { console.warn('[KIWIFY] uuid não encontrado'); return; }

  let lead = uuid ? db.prepare('SELECT * FROM leads WHERE uuid = ?').get(uuid) : null;
  // Alguns checkouts podem perder o parâmetro sck. Recupera a sessão mais
  // recente pelo e-mail para não deixar uma compra aprovada sem entrega.
  if (!lead && email) {
    lead = db.prepare('SELECT * FROM leads WHERE lower(email) = lower(?) ORDER BY created_at DESC LIMIT 1').get(email);
    if (lead) {
      console.warn(`[KIWIFY] UUID não encontrado; lead recuperado pelo e-mail uuid=${lead.uuid}`);
      uuid = lead.uuid;
    }
  }
  if (!lead) { console.warn('[KIWIFY] lead não encontrado'); return; }

  const emailFinal = email || lead.email;
  const nameFinal = name || lead.nome;

  // Mantém compatibilidade com volumes SQLite criados por versões antigas.
  db.prepare('UPDATE leads SET paid = 1 WHERE uuid = ?').run(uuid);
  const leadColumns = new Set(db.prepare('PRAGMA table_info(leads)').all().map(column => column.name));
  if (leadColumns.has('email') && emailFinal) {
    db.prepare('UPDATE leads SET email = ? WHERE uuid = ?').run(emailFinal, uuid);
  }
  if (leadColumns.has('nome') && nameFinal) {
    db.prepare('UPDATE leads SET nome = ? WHERE uuid = ?').run(nameFinal, uuid);
  }

  sendCapiEvent('Purchase', emailFinal, nameFinal, amount, 'purchase_' + uuid).catch(console.error);
  console.log(`[KIWIFY] compra confirmada uuid=${uuid} nome=${nameFinal}`);

  // Gera relatório JSON com Claude e em seguida o PDF
  const leadAtualizado = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(uuid);
  gerarRelatorio(leadAtualizado).then(async relatorio => {
    if (!relatorio) return;
    db.prepare('UPDATE leads SET relatorio = ? WHERE uuid = ?').run(relatorio, uuid);
    console.log(`[RELATORIO] salvo para uuid=${uuid}`);

    try {
      const pdfPath = await gerarPDF(leadAtualizado, relatorio);
      db.prepare('UPDATE leads SET pdf_path = ? WHERE uuid = ?').run(pdfPath, uuid);
      console.log(`[PDF] caminho salvo no DB para uuid=${uuid}`);
      const leadComPdf = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(uuid);
      await enviarRelatorioPorEmail(leadComPdf, pdfPath);
    } catch (pdfErr) {
      console.error('[PDF] erro na geração:', pdfErr.message);
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
  res.json({ nome: lead.nome, signo: lead.signo, area: lead.area, mapaNatal: lead.mapa_natal ? JSON.parse(lead.mapa_natal) : null, relatorio: lead.relatorio });
});

// GET /api/pdf/:uuid
app.get('/api/pdf/:uuid', async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(req.params.uuid);
  if (!lead) return res.status(404).json({ error: 'lead não encontrado' });
  if (!lead.paid) return res.status(403).json({ error: 'pagamento não confirmado' });
  if (!lead.relatorio) return res.status(202).json({ error: 'relatório ainda sendo gerado, tente novamente em alguns instantes' });

  try {
    let pdfPath = lead.pdf_path;

    // Gera o PDF sob demanda se ainda não existir ou o arquivo foi removido
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      console.log(`[PDF] gerando sob demanda para uuid=${lead.uuid}`);
      pdfPath = await gerarPDF(lead, lead.relatorio);
      db.prepare('UPDATE leads SET pdf_path = ? WHERE uuid = ?').run(pdfPath, lead.uuid);
    }

    const nomeArquivo = `Mapa_Previsoes_${(lead.nome || 'mapa').replace(/\s+/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (e) {
    console.error('[PDF] erro ao servir:', e.message);
    res.status(500).json({ error: 'erro ao gerar PDF', detalhe: e.message });
  }
});

// POST /api/admin/inserir-e-gerar — insere lead manualmente e gera relatório
app.post('/api/admin/inserir-e-gerar', async (req, res) => {
  const { uuid, nome, email, nascimento, horario, cidade, intencao, signo, area, situacao, sentimento, sinais } = req.body;
  if (!uuid || !nome) return res.status(400).json({ error: 'uuid e nome obrigatórios' });

  db.prepare(`
    INSERT OR REPLACE INTO leads (uuid, nome, email, nascimento, horario, cidade, intencao, signo, area, situacao, sentimento, sinais, paid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(uuid, nome, email || '', nascimento || '', horario || '', cidade || '', intencao || '', signo || '', area || '', situacao || '', sentimento || '', sinais || '');

  res.json({ ok: true, msg: 'lead inserido, gerando relatório em background...' });

  const lead = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(uuid);
  gerarRelatorio(lead).then(async relatorio => {
    if (!relatorio) return;
    db.prepare('UPDATE leads SET relatorio = ? WHERE uuid = ?').run(relatorio, uuid);
    try {
      const pdfPath = await gerarPDF(lead, relatorio);
      db.prepare('UPDATE leads SET pdf_path = ? WHERE uuid = ?').run(pdfPath, uuid);
      console.log(`[ADMIN] PDF pronto uuid=${uuid}`);
      const leadComPdf = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(uuid);
      await enviarRelatorioPorEmail(leadComPdf, pdfPath);
    } catch (e) {
      console.error('[ADMIN] erro PDF:', e.message);
    }
  }).catch(console.error);
});

// POST /api/admin/gerar/:uuid — força geração do relatório (sem verificar paid)
app.post('/api/admin/gerar/:uuid', async (req, res) => {
  const token = req.headers['x-admin-test-token'] || req.query.token || '';
  if (!ADMIN_TEST_TOKEN || token !== ADMIN_TEST_TOKEN) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  const lead = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(req.params.uuid);
  if (!lead) return res.status(404).json({ error: 'lead não encontrado' });

  db.prepare('UPDATE leads SET paid = 1 WHERE uuid = ?').run(req.params.uuid);
  res.json({ ok: true, msg: 'gerando relatório em background...' });

  const leadAtualizado = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(req.params.uuid);
  gerarRelatorio(leadAtualizado).then(async relatorio => {
    if (!relatorio) return;
    db.prepare('UPDATE leads SET relatorio = ? WHERE uuid = ?').run(relatorio, req.params.uuid);
    try {
      const pdfPath = await gerarPDF(leadAtualizado, relatorio);
      db.prepare('UPDATE leads SET pdf_path = ? WHERE uuid = ?').run(pdfPath, req.params.uuid);
      console.log(`[ADMIN] PDF pronto para uuid=${req.params.uuid}`);
      const leadComPdf = db.prepare('SELECT * FROM leads WHERE uuid = ?').get(req.params.uuid);
      await enviarRelatorioPorEmail(leadComPdf, pdfPath);
    } catch (e) {
      console.error('[ADMIN] erro PDF:', e.message);
    }
  }).catch(console.error);
});

// ─── KAIQUE LEADS ────────────────────────────────────────────────────────────
const KAIQUE_PIXEL_ID    = process.env.KAIQUE_PIXEL_ID    || '912547404676067';
const KAIQUE_ACCESS_TOKEN = process.env.KAIQUE_ACCESS_TOKEN || '';

db.exec(`
  CREATE TABLE IF NOT EXISTS kaique_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    whatsapp TEXT,
    categoria TEXT,
    utm_source TEXT,
    utm_campaign TEXT,
    event_id TEXT,
    fbp TEXT,
    fbc TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
try { db.exec(`ALTER TABLE kaique_leads ADD COLUMN event_id TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE kaique_leads ADD COLUMN fbp TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE kaique_leads ADD COLUMN fbc TEXT`); } catch(e) {}

async function sendKaiqueCapiEvent(nome, whatsapp, eventId, fbp, fbc, userAgent) {
  if (!KAIQUE_ACCESS_TOKEN) return;
  const userData = {};
  if (nome) userData.fn = [sha256(nome.split(' ')[0])];
  if (whatsapp) {
    const phone = whatsapp.replace(/\D/g, '');
    const phoneNorm = phone.startsWith('55') ? phone : '55' + phone;
    userData.ph = [sha256(phoneNorm)];
  }
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (userAgent) userData.client_user_agent = userAgent;

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId || ('kaique_lead_' + Date.now()),
      action_source: 'website',
      user_data: userData
    }]
  };

  try {
    await fetch(`https://graph.facebook.com/v19.0/${KAIQUE_PIXEL_ID}/events?access_token=${KAIQUE_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log('[KAIQUE CAPI] Lead disparado');
  } catch(e) {
    console.error('[KAIQUE CAPI] erro:', e.message);
  }
}

app.post('/api/kaique/lead', (req, res) => {
  const { nome, whatsapp, categoria, utm_source, utm_campaign, event_id, fbp, fbc, user_agent } = req.body;
  db.prepare(`
    INSERT INTO kaique_leads (nome, whatsapp, categoria, utm_source, utm_campaign, event_id, fbp, fbc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nome || '', whatsapp || '', categoria || '', utm_source || '', utm_campaign || '', event_id || '', fbp || '', fbc || '');
  console.log(`[KAIQUE] lead: ${nome} | ${whatsapp} | ${categoria}`);
  res.json({ ok: true });

  sendKaiqueCapiEvent(nome, whatsapp, event_id, fbp, fbc, user_agent).catch(console.error);
});

app.get('/api/kaique/leads', (req, res) => {
  const leads = db.prepare('SELECT * FROM kaique_leads ORDER BY created_at DESC LIMIT 200').all();
  res.json(leads);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] rodando na porta ${PORT}`));
