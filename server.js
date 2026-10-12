// JASHPI relay v2 - Node 18+, zero dependencies.
// Telegram bot (webhook or polling), SOS fan-out, live location, AI proxy, developer config.
// Env (all optional): BOT_TOKEN, PUBLIC_URL, DATA_DIR, DEV_HASH, PORT, TG_API (testing only)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const DATA = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}
const F_SUBS = path.join(DATA, 'subs.json'), F_CFG = path.join(DATA, 'config.json');
// SHA-256 of the developer code. The code itself is never stored anywhere in this project.
const DEV_HASH = process.env.DEV_HASH || '07ae20918563b4a84e4458725d1b9f7296da63e3b51c1d5e23b7875462d078d4';

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
let subs = read(F_SUBS, {});            // code -> [chat ids]
let cfg = read(F_CFG, {});              // { botToken, ai:{provider,model,key,baseUrl} }
// Free hosting has no disk, so settings can also come from environment variables (they survive restarts):
// AI_PROVIDER (gemini|openai|anthropic), AI_MODEL, AI_KEY, AI_BASE (optional)
if (process.env.AI_KEY && process.env.AI_MODEL) cfg.ai = { provider: process.env.AI_PROVIDER || 'gemini', model: process.env.AI_MODEL, key: process.env.AI_KEY, baseUrl: process.env.AI_BASE || '' };
const saveSubs = () => fs.writeFile(F_SUBS, JSON.stringify(subs), () => {});
const saveCfg = () => fs.writeFile(F_CFG, JSON.stringify(cfg), () => {});

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const isDev = code => typeof code === 'string' && code.length > 6 && code.length < 80 &&
  crypto.timingSafeEqual(Buffer.from(sha(code)), Buffer.from(DEV_HASH));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => typeof v === 'number' && isFinite(v);
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------ Telegram */
const TG_BASE = process.env.TG_API || 'https://api.telegram.org/';
let TOKEN = process.env.BOT_TOKEN || cfg.botToken || '';
let botName = '', hook = '', webhookErr = '', mode = 'off';
const hookOf = t => sha(t).slice(0, 24);

async function tg(method, body, tries = 3) {
  if (!TOKEN) return { ok: false, description: 'no bot token' };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${TG_BASE}bot${TOKEN}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
      });
      const j = await r.json().catch(() => ({ ok: false, description: 'bad json ' + r.status }));
      if (j.ok) return j;
      if (r.status === 429) { await sleep(((j.parameters && j.parameters.retry_after) || 1) * 1000 + 100); continue; }
      if (r.status >= 500) { await sleep(500 * (i + 1)); continue; }
      return j; // 4xx: do not retry (blocked bot, chat not found ...)
    } catch (e) { await sleep(500 * (i + 1)); }
  }
  return { ok: false, description: 'network' };
}
async function say(chat, text, extra) {
  const t = String(text || '').trim() || '…';
  let last = { ok: false };
  for (let i = 0; i < t.length; i += 3900) last = await tg('sendMessage', { chat_id: chat, text: t.slice(i, i + 3900), disable_web_page_preview: true, ...extra });
  return last;
}
const unlink = chat => { let n = 0; for (const k in subs) { const a = subs[k].filter(x => x !== chat); if (a.length !== subs[k].length) n++; subs[k] = a; } saveSubs(); return n; };

const seen = []; // dedupe update ids
async function onUpdate(u) {
  if (u.update_id != null) { if (seen.includes(u.update_id)) return; seen.push(u.update_id); if (seen.length > 500) seen.shift(); }
  const m = u.message || u.edited_message || (u.callback_query && u.callback_query.message);
  if (u.callback_query) tg('answerCallbackQuery', { callback_query_id: u.callback_query.id }, 1);
  if (!m || !m.chat) return;
  if (u.edited_message && !u.edited_message.text) return;   // live-location edits from users: ignore silently
  const chat = m.chat.id, text = (m.text || '').trim();
  const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(text);

  if (cmd) {
    const c = cmd[1].toLowerCase(), arg = (cmd[2] || '').trim();
    if (c === 'start') {
      if (/^[a-z0-9]{16}$/.test(arg)) {
        subs[arg] = [...new Set([...(subs[arg] || []), chat])].slice(0, 20); saveSubs();
        return say(chat, '✅ Linked. You will now receive JASHPI safety alerts and live location from this person.\n\nSend /stop any time to unlink.');
      }
      return say(chat, '👋 This is the JASHPI safety bot.\n\nTo receive someone\'s alerts, ask them to open JASHPI → Settings → "Link Telegram" and tap the link they get. You can also chat with me here to ask safety questions.');
    }
    if (c === 'stop') { const n = unlink(chat); return say(chat, n ? '🛑 Unlinked. You will no longer receive alerts.' : 'You were not linked to anyone.'); }
    if (c === 'status') { let n = 0; for (const k in subs) if (subs[k].includes(chat)) n++; return say(chat, n ? `🟢 You are linked to ${n} JASHPI user(s).` : '⚪ Not linked yet. Use the link inside the JASHPI app.'); }
    if (c === 'help') return say(chat, 'Commands:\n/status – am I linked?\n/stop – stop alerts\n\nAnything else you type, I will answer as a safety assistant.');
    return say(chat, 'Unknown command. Try /help');
  }
  if (m.location) return say(chat, `📍 Got it: https://maps.google.com/?q=${m.location.latitude},${m.location.longitude}`);
  if (text) {
    if (!aiReady()) return say(chat, 'I am online ✅ (AI answers are not enabled yet). Send /help.');
    tg('sendChatAction', { chat_id: chat, action: 'typing' }, 1);
    try { return say(chat, await ai({ mode: 'chat', lang: 'en', messages: [{ role: 'user', content: text }] })); }
    catch (e) { return say(chat, '⚠ I could not answer right now. Please try again.'); }
  }
  return say(chat, 'I can read text and locations only.');
}

let pollOn = false;
async function poll() {
  if (pollOn) return; pollOn = true; mode = 'polling'; let off = 0;
  await tg('deleteWebhook', { drop_pending_updates: false });
  while (mode === 'polling' && TOKEN) {
    const r = await tg('getUpdates', { offset: off, timeout: 25, allowed_updates: ['message', 'edited_message', 'callback_query'] }, 1);
    if (!r.ok) { await sleep(3000); continue; }
    for (const u of r.result) { off = u.update_id + 1; onUpdate(u).catch(e => log('update', e.message)); }
  }
  pollOn = false;
}

async function bootBot() {
  mode = 'off'; botName = ''; webhookErr = '';
  if (!TOKEN) { log('No bot token yet. Set BOT_TOKEN or use Developer mode in the app.'); return { ok: false, error: 'no token' }; }
  hook = hookOf(TOKEN);
  const me = await tg('getMe', {});
  if (!me.ok) { log('getMe failed:', me.description); TOKEN = TOKEN; return { ok: false, error: me.description }; }
  botName = me.result.username || '';
  const base = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (base) {
    const r = await tg('setWebhook', {
      url: `${base}/tg/${hook}`, secret_token: hook, max_connections: 20,
      allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: false
    });
    mode = r.ok ? 'webhook' : 'off'; webhookErr = r.ok ? '' : r.description;
    if (!r.ok) { log('setWebhook failed, falling back to polling:', r.description); poll(); }
  } else poll();
  tg('setMyCommands', { commands: [{ command: 'status', description: 'Am I linked?' }, { command: 'stop', description: 'Stop alerts' }, { command: 'help', description: 'Help' }] }, 1);
  log('bot ready @' + botName, 'mode=' + mode);
  return { ok: true, bot: botName };
}

/* ---------------------------------------------------------------------- AI */
const aiReady = () => !!(cfg.ai && cfg.ai.key && cfg.ai.model);
const LANGS = { en: 'English', hi: 'Hindi (Devanagari script)', hn: 'Hinglish (Hindi written in Roman letters)' };
const SYS = {
  chat: l => `You are JASHPI, a calm, friendly personal-safety assistant inside a phone app. Reply in ${LANGS[l] || 'English'}. Keep answers short (under 120 words), practical and step-by-step. For medical or life-threatening emergencies tell the user to call local emergency services first (112 in India). Never invent facts.`,
  scan: l => `You are a scam and fraud analyst. The user shares a link, QR content, SMS, WhatsApp message, OTP message, or a screenshot of one. Decide if it is SAFE, SUSPICIOUS or SCAM. Reply with ONLY a JSON object, no markdown: {"verdict":"safe|suspicious|scam","score":0-100 (risk),"title":"short headline","reasons":["max 4 short reasons"],"advice":"one short action sentence"}. Write the text fields in ${LANGS[l] || 'English'}. Be honest about uncertainty: if you cannot verify a link, say suspicious rather than safe. Remember: a real OTP must never be shared with anyone.`
};
async function ai({ mode: md, lang, messages, image }) {
  const c = cfg.ai; if (!c || !c.key) throw new Error('AI not configured');
  const system = (SYS[md] || SYS.chat)(lang);
  const msgs = (messages || []).slice(-12).map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || '').slice(0, 6000) }));
  if (!msgs.length) throw new Error('empty');
  const img = image && image.data ? { data: String(image.data), mime: image.mime || 'image/jpeg' } : null;
  const p = c.provider || 'gemini';
  let r, j;
  if (p === 'gemini') {
    const base = (c.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const contents = msgs.map((x, i) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }, ...(img && i === msgs.length - 1 && x.role === 'user' ? [{ inlineData: { mimeType: img.mime, data: img.data } }] : [])] }));
    r = await fetch(`${base}/models/${encodeURIComponent(c.model)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': c.key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents }) });
    j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || 'gemini ' + r.status);
    const t = (((j.candidates || [])[0] || {}).content || {}).parts; if (!t) throw new Error('empty reply');
    return t.map(x => x.text || '').join('').trim();
  }
  if (p === 'anthropic') {
    const base = (c.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const messages2 = msgs.map((x, i) => ({ role: x.role, content: [{ type: 'text', text: x.content }, ...(img && i === msgs.length - 1 && x.role === 'user' ? [{ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }] : [])] }));
    r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: c.model, max_tokens: 1024, system, messages: messages2 }) });
    j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || 'anthropic ' + r.status);
    return (j.content || []).map(x => x.text || '').join('').trim();
  }
  // "openai" = any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Together, local ...)
  const base = (c.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const m2 = [{ role: 'system', content: system }, ...msgs.map((x, i) => (img && i === msgs.length - 1 && x.role === 'user')
    ? { role: 'user', content: [{ type: 'text', text: x.content }, { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } }] } : x)];
  r = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key }, body: JSON.stringify({ model: c.model, messages: m2 }) });
  j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || 'api ' + r.status);
  return (((j.choices || [])[0] || {}).message || {}).content || '';
}

/* ----------------------------------------------------------- SOS / live location */
const tracks = {};   // id -> {lat,lng,name,t}
const lives = {};    // id -> {msgs:[{chat,id}], last}
setInterval(() => { const n = Date.now(); for (const k in tracks) if (n - tracks[k].t > 6 * 3600e3) delete tracks[k]; }, 600e3);

const idsFor = (code, extra) => [...new Set([...(subs[code] || []), ...(Array.isArray(extra) ? extra.filter(Number.isFinite) : [])])].slice(0, 20);

async function liveStart(b) {
  const ids = idsFor(b.code, b.ids), msgs = [];
  await Promise.all(ids.map(async chat => {
    const r = await tg('sendLocation', { chat_id: chat, latitude: b.lat, longitude: b.lng, live_period: 86400 });
    if (r.ok) msgs.push({ chat, id: r.result.message_id });
  }));
  lives[b.id] = { msgs, last: Date.now() };
  return msgs.length;
}
function liveEdit(id, lat, lng) {
  const L = lives[id]; if (!L || Date.now() - L.last < 8000) return; L.last = Date.now();
  L.msgs.forEach(m => tg('editMessageLiveLocation', { chat_id: m.chat, message_id: m.id, latitude: lat, longitude: lng }, 1));
}
async function liveStop(id) {
  const L = lives[id]; if (!L) return;
  delete lives[id];
  await Promise.all(L.msgs.map(m => tg('stopMessageLiveLocation', { chat_id: m.chat, message_id: m.id }, 1)));
}

/* ------------------------------------------------------------------- HTTP */
const hits = {};
const limited = (ip, max) => { const n = Date.now(), h = (hits[ip] = (hits[ip] || []).filter(t => n - t < 60000)); h.push(n); return h.length > max; };
const send = (r, c, b, t = 'application/json') => {
  r.writeHead(c, { 'content-type': t + '; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  r.end(typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b));
};
const body = (q, max = 3e6) => new Promise(res => { let d = ''; q.on('data', c => { d += c; if (d.length > max) q.destroy(); }); q.on('end', () => { try { res(JSON.parse(d || '{}')); } catch (e) { res({}); } }); q.on('error', () => res({})); });
const esc = x => String(x).replace(/[&<>"']/g, '');

http.createServer(async (q, s) => {
  const u = new URL(q.url, 'http://x'), p = u.pathname;
  const ip = String(q.headers['x-forwarded-for'] || q.socket.remoteAddress).split(',')[0].trim();
  if (q.method === 'OPTIONS') return send(s, 204, '');
  try {
    // Telegram webhook: never rate-limited, always answered fast so Telegram does not retry / drop messages
    if (hook && p === `/tg/${hook}` && q.method === 'POST') {
      if (q.headers['x-telegram-bot-api-secret-token'] && q.headers['x-telegram-bot-api-secret-token'] !== hook) return send(s, 403, {});
      const upd = await body(q, 1e6);
      send(s, 200, {});
      onUpdate(upd).catch(e => log('update error', e.message));
      return;
    }
    if (limited(ip, p === '/ai' ? 20 : 60)) return send(s, 429, { error: 'slow down' });

    if (p === '/' ) return send(s, 200, '<meta name=viewport content="width=device-width"><body style="font:18px sans-serif;padding:24px">JASHPI relay is running ✅</body>', 'text/html');
    if (p === '/health' || p === '/info') return send(s, 200, { ok: true, bot: botName, mode, ai: aiReady(), webhookErr });

    if (p === '/ai' && q.method === 'POST') {
      if (!aiReady()) return send(s, 503, { error: 'AI is not set up yet' });
      const b = await body(q, 6e6);
      try { return send(s, 200, { text: await ai(b) }); }
      catch (e) { return send(s, 502, { error: String(e.message).slice(0, 200) }); }
    }

    if (p.startsWith('/subs/')) { const i = subs[p.slice(6)] || []; return send(s, 200, { count: i.length }); }

    if (p === '/sos' && q.method === 'POST') {
      const b = await body(q);
      if (!/^[a-z0-9]{16}$/.test(b.code || '')) return send(s, 400, { error: 'code' });
      const ids = idsFor(b.code, b.ids), text = String(b.text || '').slice(0, 1500);
      let sent = 0;
      await Promise.all(ids.map(async id => {
        const r = await say(id, '🚨 ' + text);
        if (r.ok) { sent++; if (num(b.lat) && num(b.lng)) tg('sendLocation', { chat_id: id, latitude: b.lat, longitude: b.lng }); }
      }));
      return send(s, 200, { sent, total: ids.length });
    }

    if (p === '/live/start' && q.method === 'POST') {
      const b = await body(q);
      if (!/^[a-z0-9]{16}$/.test(b.code || '') || !/^[a-z0-9]{10}$/.test(b.id || '') || !num(b.lat) || !num(b.lng)) return send(s, 400, {});
      tracks[b.id] = { lat: b.lat, lng: b.lng, name: String(b.name || '').slice(0, 40), t: Date.now() };
      return send(s, 200, { telegram: await liveStart(b) });
    }
    if (p === '/live/stop' && q.method === 'POST') { const b = await body(q); if (/^[a-z0-9]{10}$/.test(b.id || '')) { await liveStop(b.id); delete tracks[b.id]; } return send(s, 200, {}); }

    if (p === '/track' && q.method === 'POST') {
      const b = await body(q);
      if (!/^[a-z0-9]{10}$/.test(b.id || '') || !num(b.lat) || !num(b.lng)) return send(s, 400, {});
      tracks[b.id] = { lat: b.lat, lng: b.lng, name: String(b.name || '').slice(0, 40), t: Date.now() };
      liveEdit(b.id, b.lat, b.lng);
      return send(s, 200, {});
    }
    if (p.startsWith('/where/')) { const k = tracks[p.slice(7)]; return send(s, 200, k ? { ok: true, age: Math.round((Date.now() - k.t) / 1000) } : { ok: false }); }
    if (p.startsWith('/t/')) {
      const k = tracks[p.slice(3)];
      if (!k) return send(s, 404, '<meta http-equiv=refresh content=5><meta name=viewport content="width=device-width"><body style="font:18px sans-serif;padding:24px">Waiting for location… this page refreshes by itself. If it stays blank, the link has expired.</body>', 'text/html');
      const d = .004, src = `https://www.openstreetmap.org/export/embed.html?bbox=${k.lng - d},${k.lat - d},${k.lng + d},${k.lat + d}&layer=mapnik&marker=${k.lat},${k.lng}`;
      return send(s, 200, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><meta http-equiv=refresh content=5><title>Live location</title><body style="margin:0;font:16px sans-serif"><div style="padding:12px;background:#0B1030;color:#fff"><b>${esc(k.name)}</b> · updated ${Math.round((Date.now() - k.t) / 1000)}s ago · <a style="color:#19D3F2" href="https://maps.google.com/?q=${k.lat},${k.lng}">Open in Maps</a></div><iframe src="${src}" style="border:0;width:100%;height:calc(100vh - 48px)"></iframe></body>`, 'text/html');
    }

    // ---- developer only: settings here apply to EVERY user of the app
    if ((p === '/config' || p === '/config/get') && q.method === 'POST') {
      const b = await body(q);
      if (limited('dev' + ip, 8) || !isDev(b.code)) return send(s, 403, { error: 'forbidden' });
      const whInfo = async () => { if (!TOKEN) return null; const r = await tg('getWebhookInfo', {}, 1); return r.ok ? { set: !!r.result.url, pending: r.result.pending_update_count, lastError: r.result.last_error_message || '' } : null; };
      const out = async () => ({ ok: true, bot: botName, mode, botSet: !!TOKEN, webhookErr, webhook: await whInfo(), ai: { provider: (cfg.ai || {}).provider || '', model: (cfg.ai || {}).model || '', baseUrl: (cfg.ai || {}).baseUrl || '', keySet: !!(cfg.ai && cfg.ai.key) } });
      if (p === '/config/get') return send(s, 200, await out());
      let botRes = null;
      if (typeof b.botToken === 'string' && b.botToken.trim()) {
        const old = TOKEN; mode = 'off';
        TOKEN = b.botToken.trim();
        const me = await tg('getMe', {}, 1);
        if (!me.ok) { TOKEN = old; if (old) bootBot(); return send(s, 400, { error: 'Telegram rejected this bot token' }); }
        cfg.botToken = TOKEN; saveCfg(); botRes = await bootBot();
      }
      if (b.ai && typeof b.ai === 'object') {
        const a = b.ai, prev = cfg.ai || {};
        cfg.ai = { provider: ['gemini', 'openai', 'anthropic'].includes(a.provider) ? a.provider : (prev.provider || 'gemini'), model: String(a.model || prev.model || '').trim().slice(0, 100), baseUrl: String(a.baseUrl || '').trim().slice(0, 200), key: String(a.key || '').trim() || prev.key || '' };
        saveCfg();
      }
      const res = { ...(await out()), botRes };
      if (b.test) {
        if (!aiReady()) res.aiTest = 'FAILED: AI is not set (model or key missing)';
        else { try { await ai({ mode: 'chat', lang: 'en', messages: [{ role: 'user', content: 'Say OK' }] }); res.aiTest = 'OK'; } catch (e) { res.aiTest = 'FAILED: ' + String(e.message).slice(0, 220); } }
      }
      if (b.listModels && cfg.ai && cfg.ai.key) {
        try {
          const c = cfg.ai, g = (c.provider || 'gemini') === 'gemini';
          const base = (c.baseUrl || (g ? 'https://generativelanguage.googleapis.com/v1beta' : c.provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')).replace(/\/$/, '');
          const hd = g ? { 'x-goog-api-key': c.key } : c.provider === 'anthropic' ? { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + c.key };
          const r = await fetch(base + '/models' + (g ? '?pageSize=200' : ''), { headers: hd }); const j = await r.json();
          const arr = (j.models || j.data || []).filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map(m => String(m.name || m.id).replace(/^models\//, ''));
          res.models = arr.filter(n => /flash|pro|sonnet|haiku|opus|gpt|mini|llama/i.test(n)).slice(0, 25);
        } catch (e) { res.models = ['could not list: ' + String(e.message).slice(0, 100)]; }
      }
      return send(s, 200, res);
    }
    send(s, 404, { error: 'not found' });
  } catch (e) { log('server error', e); send(s, 500, { error: 'server' }); }
}).listen(process.env.PORT || 3000, '0.0.0.0', () => { log('JASHPI relay listening'); bootBot(); });
