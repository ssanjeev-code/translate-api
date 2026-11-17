// Free chat-translation API for Salesforce POC. Zero dependencies, Node 18+.
// POST /translate  -> { author, originalMessage, translatedMessage, sourceLanguage, targetLanguage }

const http = require('http');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';               // optional shared secret (x-api-key header)
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || ''; // optional: raises MyMemory free quota to 50k chars/day
const LIBRE_URL = (process.env.LIBRETRANSLATE_URL || '').replace(/\/$/, ''); // e.g. https://your-libretranslate-host
const LIBRE_KEY = process.env.LIBRETRANSLATE_KEY || '';
const LINGVA_URLS = (process.env.LINGVA_URLS || 'https://lingva.ml,https://lingva.thedaviddelta.com,https://lingva.lunar.icu')
  .split(',').map(s => s.trim().replace(/\/$/, ''));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Providers are tried in order. Free public endpoints rate-limit shared hosting IPs, hence the fallbacks.
const PROVIDERS = (process.env.PROVIDERS || 'edge,google,lingva,mymemory,libretranslate')
  .split(',').map(s => s.trim()).filter(p => p !== 'libretranslate' || LIBRE_URL);
const MAX_CHARS = 5000;
const CHUNK = 450;

// "en_US" -> "en", "fr_Fr" -> "fr", "zh_CN" -> "zh-CN", "auto" stays "auto"
function normalizeLang(code) {
  if (!code) return '';
  const c = String(code).trim().replace('_', '-');
  const [lang, region] = c.split('-');
  const l = lang.toLowerCase();
  if (l === 'auto') return 'auto';
  if (l === 'zh') return region && /^(tw|hk|hant)$/i.test(region) ? 'zh-TW' : 'zh-CN';
  return l;
}

// Split long text on sentence boundaries so providers with small limits still work.
function chunk(text, size = CHUNK) {
  if (text.length <= size) return [text];
  const parts = text.match(/[^.!?\n。！？]+[.!?\n。！？]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (let p of parts) {
    while (p.length > size) { out.push(p.slice(0, size)); p = p.slice(size); }
    if ((cur + p).length > size) { out.push(cur); cur = p; } else cur += p;
  }
  if (cur) out.push(cur);
  return out.filter(Boolean);
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Provider 1: Google's public web endpoint (no key, supports auto-detect). Unofficial - fine for POC.
async function viaGoogle(text, sl, tl) {
  let out = '', detected = sl;
  for (const part of chunk(text)) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=' +
      encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl) + '&q=' + encodeURIComponent(part);
    const data = await fetchJson(url);
    out += data[0].map(s => s[0]).join('');
    if (data[2]) detected = data[2];
  }
  return { text: out, detected };
}

// Provider 2: MyMemory (no key, 5k chars/day anonymous; 50k with email). Needs explicit source lang.
async function viaMyMemory(text, sl, tl) {
  if (sl === 'auto') throw new Error('MyMemory needs an explicit sourceLanguage');
  let out = '';
  for (const part of chunk(text)) {
    let url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(part) +
      '&langpair=' + encodeURIComponent(sl + '|' + tl);
    if (MYMEMORY_EMAIL) url += '&de=' + encodeURIComponent(MYMEMORY_EMAIL);
    const data = await fetchJson(url);
    if (data.responseStatus !== 200) throw new Error(data.responseDetails || 'MyMemory error');
    out += data.responseData.translatedText;
  }
  return { text: out, detected: sl };
}

// Provider: Microsoft Edge browser translator (free token, supports auto-detect).
let edgeToken = { value: '', exp: 0 };
async function edgeAuth() {
  if (edgeToken.value && Date.now() < edgeToken.exp) return edgeToken.value;
  const res = await fetch('https://edge.microsoft.com/translate/auth', {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`auth HTTP ${res.status}`);
  edgeToken = { value: (await res.text()).trim(), exp: Date.now() + 8 * 60 * 1000 };
  return edgeToken.value;
}
const edgeLang = l => (l === 'zh-CN' ? 'zh-Hans' : l === 'zh-TW' ? 'zh-Hant' : l === 'auto' ? '' : l);
async function viaEdge(text, sl, tl) {
  try {
    const token = await edgeAuth();
    const from = edgeLang(sl);
    const url = 'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=' +
      encodeURIComponent(edgeLang(tl)) + (from ? '&from=' + encodeURIComponent(from) : '');
    let out = '', detected = sl;
    for (const part of chunk(text, 1500)) {
      const data = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify([{ Text: part }])
      });
      out += data[0].translations[0].text;
      if (data[0].detectedLanguage) detected = data[0].detectedLanguage.language;
    }
    return { text: out, detected };
  } catch (e) {
    edgeToken = { value: '', exp: 0 }; // force a fresh token next time
    throw e;
  }
}

// Provider: Lingva (open-source Google Translate front-end). Tries several public mirrors.
async function viaLingva(text, sl, tl) {
  let out = '';
  for (const part of chunk(text, 400)) {
    let done = false, lastErr;
    for (const base of LINGVA_URLS) {
      try {
        const data = await fetchJson(`${base}/api/v1/${encodeURIComponent(sl)}/${encodeURIComponent(tl)}/${encodeURIComponent(part)}`);
        if (!data.translation) throw new Error('empty response');
        out += data.translation; done = true; break;
      } catch (e) { lastErr = e; }
    }
    if (!done) throw lastErr || new Error('no Lingva mirror available');
  }
  return { text: out, detected: sl };
}

// Provider: your own / a hosted LibreTranslate server (set LIBRETRANSLATE_URL, and LIBRETRANSLATE_KEY if needed).
async function viaLibre(text, sl, tl) {
  const data = await fetchJson(LIBRE_URL + '/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: sl, target: tl, format: 'text', api_key: LIBRE_KEY || undefined })
  });
  return { text: data.translatedText, detected: (data.detectedLanguage && data.detectedLanguage.language) || sl };
}

const impl = { edge: viaEdge, google: viaGoogle, lingva: viaLingva, mymemory: viaMyMemory, libretranslate: viaLibre };

// Small in-memory cache (repeat messages like "Hello" cost nothing) and per-provider cooldown after 429/403.
const cache = new Map();
const CACHE_MAX = 500;
const cooldown = {};

async function translate(text, sl, tl) {
  if (sl === tl) return { text, detected: sl };
  const key = `${sl}|${tl}|${text}`;
  if (cache.has(key)) return { ...cache.get(key), provider: 'cache' };

  const errors = [];
  for (const name of PROVIDERS) {
    if ((cooldown[name] || 0) > Date.now()) { errors.push(`${name}: cooling down`); continue; }
    try {
      const r = { ...(await impl[name](text, sl, tl)), provider: name };
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { text: r.text, detected: r.detected });
      return r;
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      if (/429|403|503/.test(e.message)) cooldown[name] = Date.now() + 60_000;
    }
  }
  throw new Error('All providers failed -> ' + errors.join('; '));
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 50_000) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      return send(res, 200, { status: 'ok', providers: PROVIDERS });
    }
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/translate') {
      return send(res, 404, { error: 'Not found. Use POST /translate' });
    }
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
      return send(res, 401, { error: 'Invalid or missing x-api-key header' });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return send(res, 400, { error: 'Body must be valid JSON' }); }

    // Accepts the original (misspelled) field name plus the correct spelling.
    const text = body.sentense_To_Translate ?? body.sentence_To_Translate ?? body.sentenceToTranslate;
    const author = body.author || '';
    const tl = normalizeLang(body.targetLanguage);
    const sl = normalizeLang(body.sourceLanguage) || 'auto';

    if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'sentense_To_Translate is required' });
    if (!tl || tl === 'auto') return send(res, 400, { error: 'targetLanguage is required' });
    if (text.length > MAX_CHARS) return send(res, 400, { error: `Text exceeds ${MAX_CHARS} characters` });

    const r = await translate(text, sl, tl);
    console.log(`[${new Date().toISOString()}] ${r.provider || 'noop'} ${sl}->${tl} (${text.length} chars)`);
    return send(res, 200, {
      author,
      originalMessage: text,
      translatedMessage: r.text,
      sourceLanguage: r.detected || sl,
      targetLanguage: tl
    });
  } catch (e) {
    console.error(e.message);
    return send(res, 502, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Translation API listening on :${PORT}`));
}
module.exports = { server, normalizeLang, chunk };
