/* Servidor de la tienda OIKOS. Sin dependencias: solo Node 18+.
   Uso:  ADMIN_PIN=1234 node server.js     (PORT y DATA_DIR son opcionales) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Core = require('./core.js');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const IMG_DIR = path.join(DATA_DIR, 'img');
const STORE = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(IMG_DIR, { recursive: true });

/* ---------- datos ---------- */
function hashPin(pin, salt = crypto.randomBytes(12).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function checkPin(pin, hash) {
  const [salt, h] = String(hash || '').split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(crypto.scryptSync(String(pin), salt, 32).toString('hex')), b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function saveImage(dataUrl, id) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return null;
  const file = id.replace(/[^\w-]/g, '') + '-' + Date.now().toString(36) + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(IMG_DIR, file), buf);
  return '/img/' + file;
}
let state;
function load() {
  if (fs.existsSync(STORE)) { state = JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  else {
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalogo.json'), 'utf8'));
    state = Core.fromSeed(seed);
    /* las fotos del catálogo inicial pasan a archivos para no repetir megabytes en cada visita */
    state.products.forEach(p => { if (p.img.startsWith('data:')) p.img = saveImage(p.img, p.id) || ''; });
  }
  const pin = process.env.ADMIN_PIN;
  if (!state.settings.pinHash || pin) {
    state.settings.pinHash = hashPin(pin || '1234');
    if (!pin) console.warn('AVISO: usando el PIN inicial 1234. Cámbialo con ADMIN_PIN o en Ajustes.');
  }
  Core.expire(state, Date.now());
  persist();
}
function persist() {
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STORE);
}
load();
setInterval(() => { if (Core.expire(state, Date.now())) persist(); }, 60 * 1000).unref();

/* ---------- utilidades HTTP ---------- */
const tokens = new Map();               // token -> vencimiento
const hits = new Map();                 // ip:acción -> [instantes]
function limited(ip, action, max, windowMs) {
  const k = ip + ':' + action, now = Date.now(), list = (hits.get(k) || []).filter(t => now - t < windowMs);
  list.push(now); hits.set(k, list);
  return list.length > max;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < 3600e3)) hits.delete(k); for (const [t, e] of tokens) if (e < n) tokens.delete(t); }, 600e3).unref();

const send = (res, code, body, headers = {}) => {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }, headers));
  res.end(data);
};
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('json')); } });
    req.on('error', reject);
  });
}
const ip = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/* ---------- rutas ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method, who = ip(req), now = Date.now();
  if (Core.expire(state, now)) persist();

  if (m === 'GET' && p === '/api/catalog') return send(res, 200, Core.publicCatalog(state));

  if (m === 'POST' && p === '/api/orders') {
    if (limited(who, 'order', 12, 3600e3)) return send(res, 429, { error: 'rate' });
    const pending = state.orders.filter(o => o.status === 'reservado' && o.ip === who).length;
    if (pending >= 3) return send(res, 429, { error: 'pending' });
    const r = Core.createOrder(state, await readBody(req, 64 * 1024), now);
    if (!r.ok) return send(res, r.error === 'unavailable' ? 409 : 400, r);
    r.order.ip = who; persist();
    const o = r.order;
    return send(res, 201, { ok: true, order: { id: o.id, expires: o.expires, total: o.total, items: o.items, name: o.name } });
  }

  if (m === 'POST' && p === '/api/admin/login') {
    if (limited(who, 'login', 8, 600e3)) return send(res, 429, { error: 'rate' });
    const b = await readBody(req, 4096);
    if (!checkPin(b.pin, state.settings.pinHash)) return send(res, 401, { error: 'pin' });
    const t = crypto.randomBytes(24).toString('hex'); tokens.set(t, now + 12 * 3600e3);
    return send(res, 200, { token: t });
  }

  if (p.startsWith('/api/admin/')) {
    const t = req.headers['x-admin-token'];
    if (!t || !(tokens.get(t) > now)) return send(res, 401, { error: 'auth' });
    const seg = p.split('/').slice(3), view = () => Core.adminView(state);
    if (m === 'GET' && seg[0] === 'state') return send(res, 200, view());
    const b = m === 'GET' || m === 'DELETE' ? {} : await readBody(req, 4 * 1024 * 1024);
    let out;
    if (seg[0] === 'product' && m === 'PUT') out = Core.upsertProduct(state, Object.assign({}, b, { id: seg[1] || b.id, img: undefined }));
    else if (seg[0] === 'product' && seg[2] === 'image' && m === 'POST') {
      const pr = state.products.find(x => x.id === seg[1]); if (!pr) return send(res, 404, { error: 'notfound' });
      const url2 = saveImage(b.data, pr.id); if (!url2) return send(res, 400, { error: 'image' });
      pr.img = url2;
    }
    else if (seg[0] === 'product' && m === 'DELETE') Core.deleteProduct(state, seg[1]);
    else if (seg[0] === 'stock' && seg[2] === 'adjust' && m === 'POST') { if (!Core.adjustStock(state, seg[1], b.delta)) return send(res, 404, { error: 'notfound' }); }
    else if (seg[0] === 'stock' && m === 'PUT') { if (!Core.upsertStock(state, Object.assign({}, b, { id: seg[1] || b.id }))) return send(res, 400, { error: 'stock' }); }
    else if (seg[0] === 'stock' && m === 'DELETE') Core.deleteStock(state, seg[1]);
    else if (seg[0] === 'settings' && m === 'PUT') Core.saveSettings(state, b);
    else if (seg[0] === 'pin' && m === 'POST') {
      if (String(b.pin || '').length < 4) return send(res, 400, { error: 'pin' });
      state.settings.pinHash = hashPin(b.pin); tokens.clear();
    }
    else if (seg[0] === 'orders' && seg[2] === 'confirm' && m === 'POST') { const r = Core.confirmOrder(state, seg[1], now); if (!r.ok) return send(res, 409, r); }
    else if (seg[0] === 'orders' && seg[2] === 'cancel' && m === 'POST') { const r = Core.cancelOrder(state, seg[1], now); if (!r.ok) return send(res, 409, r); }
    else return send(res, 404, { error: 'route' });
    persist();
    return send(res, 200, view());
  }
  return send(res, 404, { error: 'route' });
}

function serveFile(res, file, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
    if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, path.join(ROOT, 'index.html'), 'no-cache');
    if (url.pathname === '/core.js') return serveFile(res, path.join(ROOT, 'core.js'), 'no-cache');
    const im = /^\/img\/([\w.-]+)$/.exec(url.pathname);
    if (im) return serveFile(res, path.join(IMG_DIR, im[1]), 'public, max-age=31536000, immutable');
    return send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (e) {
    send(res, e.message === 'large' ? 413 : 400, { error: e.message === 'large' ? 'large' : 'bad' });
  }
}).listen(PORT, () => console.log('Tienda en http://localhost:' + PORT + '  (panel: /#admin)'));
