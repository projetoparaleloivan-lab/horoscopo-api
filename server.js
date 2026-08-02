const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Garante que o diretório de PDFs existe
const PDF_DIR = '/tmp/pdfs';
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

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
    pdf_path TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Migrações seguras
try { db.exec(`ALTER TABLE leads ADD COLUMN relatorio TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE leads ADD COLUMN pdf_path TEXT`); } catch(e) {}

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

  const prompt = `Você é um astrólogo especialista de alto nível. Gere um relatório de horóscopo VIP FOCADO EM ${lead.area.toUpperCase()}, profundo, místico e extremamente personalizado para:

- Nome: ${lead.nome}
- Data de nascimento: ${lead.nascimento}
- Signo: ${lead.signo}
- Área de foco: ${lead.area}
- Situação atual: ${lead.situacao}
- Sentimento sobre Agosto: ${lead.sentimento}

Retorne SOMENTE um JSON válido com exatamente estas 10 chaves (sem markdown, sem blocos de código):

{
  "visaoGeral": "${substituir(secoes.s1)} Mínimo 200 palavras.",
  "secao2": "${substituir(secoes.s2)} Mínimo 180 palavras.",
  "secao3": "${substituir(secoes.s3)} Mínimo 180 palavras.",
  "secao4": "${substituir(secoes.s4)} Mínimo 180 palavras.",
  "secao5": "${substituir(secoes.s5)} Mínimo 180 palavras.",
  "secao6": "${substituir(secoes.s6)} Mínimo 150 palavras.",
  "calendario": ["Dia X de Agosto: evento específico para ${lead.nome}", "Dia X...", "Dia X...", "Dia X...", "Dia X...", "Dia X..."],
  "transitos": "${substituir(secoes.s8)} Mínimo 200 palavras.",
  "mensagemCanalizada": "${substituir(secoes.s9)} Entre 120 e 160 palavras.",
  "afirmacoes": ["${substituir(secoes.s10).split(':')[0]} 1", "...2", "...3", "...4", "...5", "...6", "...7"]
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
      const parsed = JSON.parse(texto);
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

  const divider = `<div class="divider"><span>✦</span><span>✦</span><span>✦</span></div>`;

  const paginaSecao = (numero, titulo, icone, conteudo) => `
    <div class="pagina secao-pagina">
      <div class="pagina-numero">${numero} / 10</div>
      <div class="secao-icone">${icone}</div>
      <h2 class="secao-titulo">${titulo}</h2>
      ${divider}
      <div class="secao-corpo">${conteudo}</div>
      <div class="rodape">Horóscopo VIP · ${lead.nome} · ${lead.signo} · ${mesAno}</div>
    </div>
  `;

  const paragrafo = (txt) => `<p>${txt}</p>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Horóscopo VIP · ${lead.nome} · ${mesAno}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Plus+Jakarta+Sans:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&display=swap');

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
    font-family: 'Plus Jakarta Sans', sans-serif;
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
    font-family: 'Plus Jakarta Sans', sans-serif;
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
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: 9pt;
    font-weight: 500;
    letter-spacing: 5px;
    text-transform: uppercase;
    color: var(--lilas-brilhante);
    margin-bottom: 16px;
  }

  .capa-nome {
    font-family: 'Cinzel', serif;
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
    font-family: 'Cinzel', serif;
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
    font-family: 'Cinzel', serif;
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
    font-family: 'Plus Jakarta Sans', sans-serif;
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
    font-family: 'Plus Jakarta Sans', sans-serif;
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
    font-family: 'Cinzel', serif;
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
    font-family: 'Cinzel', serif;
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
    font-family: 'Cinzel', serif;
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
  <div class="capa-subtitulo">Horóscopo Personalizado</div>
  <div class="capa-nome">${lead.nome}</div>
  <div class="capa-signo">${lead.signo} · ${lead.nascimento || ''}</div>
  <div class="capa-linha"></div>
  <div class="capa-titulo-principal">Horóscopo VIP<br>${mesAno}</div>
  <div class="capa-mes">✦ Revelações Astrais Exclusivas ✦</div>
  <div class="capa-rodape">Produzido especialmente para você · Documento confidencial</div>
</div>

<!-- ════════════════════ PÁGINA 2 — VISÃO GERAL ════════════════════ -->
${paginaSecao(2, `Visão Geral de ${mesAno}`, '🌌', paragrafo(dados.visaoGeral || ''))}

<!-- ════════════════════ PÁGINAS 3-6 — SEÇÕES DA ÁREA ESCOLHIDA ════════════════════ -->
${paginaSecao(3, titulosSecoes[lead.area]?.[0] || lead.area, iconesSecoes[lead.area]?.[0] || '✨', paragrafo(dados.secao2 || ''))}
${paginaSecao(4, titulosSecoes[lead.area]?.[1] || lead.area, iconesSecoes[lead.area]?.[1] || '✨', paragrafo(dados.secao3 || ''))}
${paginaSecao(5, titulosSecoes[lead.area]?.[2] || lead.area, iconesSecoes[lead.area]?.[2] || '✨', paragrafo(dados.secao4 || ''))}
${paginaSecao(6, titulosSecoes[lead.area]?.[3] || lead.area, iconesSecoes[lead.area]?.[3] || '✨', paragrafo(dados.secao5 || ''))}

<!-- ════════════════════ PÁGINA 7 — CALENDÁRIO ════════════════════ -->
<div class="pagina secao-pagina">
  <div class="pagina-numero">7 / 10</div>
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
  <div class="rodape">Horóscopo VIP · ${lead.nome} · ${lead.signo} · ${mesAno}</div>
</div>

<!-- ════════════════════ PÁGINA 8 — TRÂNSITOS ════════════════════ -->
${paginaSecao(8, 'Trânsitos Planetários', '🪐', paragrafo(dados.transitos || ''))}

<!-- ════════════════════ PÁGINA 9 — MENSAGEM CANALIZADA ════════════════════ -->
<div class="pagina secao-pagina">
  <div class="pagina-numero">9 / 10</div>
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
  <div class="rodape">Horóscopo VIP · ${lead.nome} · ${lead.signo} · ${mesAno}</div>
</div>

<!-- ════════════════════ PÁGINA 10 — ENCERRAMENTO ════════════════════ -->
<div class="pagina secao-pagina">
  <div class="pagina-numero">10 / 10</div>
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
  <div class="rodape">Horóscopo VIP · ${lead.nome} · ${lead.signo} · ${mesAno}</div>
</div>

</body>
</html>`;
}

// ─── Geração do PDF com Puppeteer ────────────────────────────────────────────

async function gerarPDF(lead, relatorioBruto) {
  let dados;
  try {
    dados = typeof relatorioBruto === 'string' ? JSON.parse(relatorioBruto) : relatorioBruto;
  } catch (e) {
    // Se não for JSON, monta um objeto simples com o texto na visão geral
    dados = {
      visaoGeral: relatorioBruto || '',
      secao2: '', secao3: '', secao4: '', secao5: '', secao6: '',
      calendario: [], transitos: '', mensagemCanalizada: '',
      afirmacoes: [], encerramento: ''
    };
  }

  const html = gerarHTML(lead, dados);
  const pdfPath = path.join(PDF_DIR, `horoscopo_${lead.uuid}.pdf`);

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

    // Aguarda carregamento das fontes do Google
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
  const { uuid: uuidRecebido, nome, email, nascimento, signo, area, situacao, sentimento, sinais } = req.body;
  if (!nome) return res.status(400).json({ error: 'nome obrigatório' });

  const uuid = uuidRecebido || gerarUUID();
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
  res.json({ nome: lead.nome, signo: lead.signo, area: lead.area, relatorio: lead.relatorio });
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

    const nomeArquivo = `Horoscopo_VIP_${(lead.nome || 'horoscopo').replace(/\s+/g, '_')}_Agosto2026.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (e) {
    console.error('[PDF] erro ao servir:', e.message);
    res.status(500).json({ error: 'erro ao gerar PDF', detalhe: e.message });
  }
});

// POST /api/admin/gerar/:uuid — força geração do relatório (sem verificar paid)
app.post('/api/admin/gerar/:uuid', async (req, res) => {
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
    } catch (e) {
      console.error('[ADMIN] erro PDF:', e.message);
    }
  }).catch(console.error);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] rodando na porta ${PORT}`));
