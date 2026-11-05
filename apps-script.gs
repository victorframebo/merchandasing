/* Lógica de la tienda: stock por talla, reservas y ventas.
   La usan el servidor (server.js) y la vista previa del navegador, así que no depende de nada externo. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SIZES = ['P (6 años)', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', '7XL', '8XL'];
  const PRE_SIZES = SIZES.slice(1);
  const MAX_LINE = 10;
  const HOUR = 3600 * 1000;

  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const int = (v, min, max) => Math.min(max, Math.max(min, Math.floor(Number(v) || 0)));
  const num = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function defaults() {
    return {
      settings: { name: 'OIKOS', sub: '', wa: '', cur: 'Bs', low: 3, reserveHours: 24 },
      products: [], stock: [], orders: []
    };
  }

  /* convierte el catálogo inicial (catalogo.json) en un estado completo */
  function fromSeed(seed) {
    const st = defaults(), s = (seed && seed.settings) || {};
    st.settings.name = str(s.name || 'OIKOS', 60);
    st.settings.sub = str(s.sub, 300);
    st.settings.wa = str(s.wa, 20).replace(/\D/g, '');
    st.settings.cur = str(s.cur || 'Bs', 8);
    st.settings.low = int(s.low, 0, 999);
    st.settings.reserveHours = num(s.reserveHours || 24, 0.25, 720);
    (seed.products || []).forEach(p => st.products.push({
      id: str(p.id || uid('p'), 40), name: str(p.name, 120), desc: str(p.desc, 600),
      price: num(p.price, 0, 1e7), img: str(p.img, 3e6), visible: p.visible !== false, pedido: p.pedido !== false
    }));
    (seed.stock || []).forEach(r => {
      if (!SIZES.includes(r.size) || !st.products.some(p => p.id === r.p)) return;
      st.stock.push({
        id: str(r.id || uid('r'), 40), p: r.p, size: r.size,
        front: r.front == null ? null : num(r.front, 0, 200), back: r.back == null ? null : num(r.back, 0, 200),
        qty: int(r.qty, 0, 99999)
      });
    });
    return st;
  }

  /* ---------- existencias y reservas ---------- */
  function onHand(st, pid, size) {
    return st.stock.reduce((a, r) => a + (r.p === pid && (size == null || r.size === size) ? r.qty : 0), 0);
  }
  function reserved(st, pid, size) {
    let n = 0;
    for (const o of st.orders) {
      if (o.status !== 'reservado') continue;
      for (const it of o.items) if (!it.pre && it.p === pid && (size == null || it.size === size)) n += it.qty;
    }
    return n;
  }
  const available = (st, pid, size) => Math.max(0, onHand(st, pid, size) - reserved(st, pid, size));
  const availTotal = (st, pid) => SIZES.reduce((a, s) => a + available(st, pid, s), 0);
  const isPre = (st, p) => availTotal(st, p.id) <= 0 && p.pedido !== false;

  function expire(st, now) {
    let changed = false;
    for (const o of st.orders) {
      if (o.status === 'reservado' && o.expires != null && o.expires <= now) { o.status = 'vencido'; changed = true; }
    }
    return changed;
  }

  /* lo que ve cualquier cliente: nunca incluye cantidades */
  function publicCatalog(st) {
    const s = st.settings;
    return {
      settings: { name: s.name, sub: s.sub, wa: s.wa, cur: s.cur, reserveHours: s.reserveHours },
      products: st.products.filter(p => p.visible).map(p => {
        const pre = isPre(st, p), sizes = pre ? PRE_SIZES : SIZES.filter(z => available(st, p.id, z) > 0);
        return { id: p.id, name: p.name, desc: p.desc, price: p.price, img: p.img, pre, soldOut: !pre && sizes.length === 0, sizes };
      })
    };
  }

  /* ---------- pedidos ---------- */
  function newCode(st) {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (;;) {
      let c = ''; for (let i = 0; i < 6; i++) c += A[Math.floor(Math.random() * A.length)];
      if (!st.orders.some(o => o.id === c)) return c;
    }
  }

  /* reserva todo o nada: si una talla ya no alcanza, no se aparta nada */
  function createOrder(st, input, now) {
    expire(st, now);
    const name = str(input && input.name, 80).trim();
    if (!name) return { ok: false, error: 'name' };
    const raw = Array.isArray(input.items) ? input.items.slice(0, 40) : [];
    const lines = new Map();
    for (const it of raw) {
      const key = it.p + '|' + it.size, qty = int(it.qty, 0, MAX_LINE);
      if (qty < 1) continue;
      const cur = lines.get(key);
      lines.set(key, { p: String(it.p), size: String(it.size), pre: cur ? cur.pre : (it.pre === undefined ? undefined : !!it.pre), qty: Math.min(MAX_LINE, (cur ? cur.qty : 0) + qty) });
    }
    if (!lines.size) return { ok: false, error: 'empty' };
    const items = [], bad = [];
    for (const l of lines.values()) {
      const p = st.products.find(x => x.id === l.p && x.visible);
      if (!p) { bad.push({ p: l.p, size: l.size, available: 0 }); continue; }
      const pre = isPre(st, p);
      /* si el cliente vio la talla en stock y ya pasó a pedido (o al revés), no se cambia en silencio */
      if (l.pre !== undefined && l.pre !== pre) { bad.push({ p: p.id, size: l.size, available: pre ? 0 : (SIZES.includes(l.size) ? available(st, p.id, l.size) : 0) }); continue; }
      if (pre) {
        if (!PRE_SIZES.includes(l.size)) { bad.push({ p: p.id, size: l.size, available: 0 }); continue; }
      } else if (!SIZES.includes(l.size) || available(st, p.id, l.size) < l.qty) {
        bad.push({ p: p.id, size: l.size, available: SIZES.includes(l.size) ? available(st, p.id, l.size) : 0 }); continue;
      }
      items.push({ p: p.id, size: l.size, qty: l.qty, price: p.price, name: p.name, pre });
    }
    if (bad.length) return { ok: false, error: 'unavailable', items: bad };
    const reservable = items.some(i => !i.pre);
    const order = {
      id: newCode(st), created: now, expires: reservable ? now + st.settings.reserveHours * HOUR : null,
      name, phone: str(input.phone, 30), note: str(input.note, 500), items,
      total: items.reduce((a, i) => a + i.qty * i.price, 0), status: 'reservado'
    };
    st.orders.unshift(order);
    return { ok: true, order };
  }

  function confirmOrder(st, id, now) {
    expire(st, now);
    const o = st.orders.find(x => x.id === id);
    if (!o) return { ok: false, error: 'notfound' };
    if (o.status !== 'reservado' && o.status !== 'vencido') return { ok: false, error: 'state' };
    for (const it of o.items) {
      if (it.pre) continue;
      const free = o.status === 'vencido' ? available(st, it.p, it.size) : onHand(st, it.p, it.size);
      if (free < it.qty) return { ok: false, error: 'stock', item: it };
    }
    for (const it of o.items) {
      if (it.pre) continue;
      let rem = it.qty;
      for (const r of st.stock) {
        if (r.p !== it.p || r.size !== it.size || rem <= 0) continue;
        const take = Math.min(r.qty, rem); r.qty -= take; rem -= take;
      }
    }
    o.status = 'confirmado'; o.confirmed = now;
    return { ok: true, order: o };
  }

  function cancelOrder(st, id, now) {
    const o = st.orders.find(x => x.id === id);
    if (!o) return { ok: false, error: 'notfound' };
    if (o.status === 'cancelado') return { ok: false, error: 'state' };
    if (o.status === 'confirmado') {
      for (const it of o.items) {
        if (it.pre) continue;
        const row = st.stock.find(r => r.p === it.p && r.size === it.size);
        if (row) row.qty += it.qty;
        else if (st.products.some(p => p.id === it.p)) st.stock.push({ id: uid('r'), p: it.p, size: it.size, front: null, back: null, qty: it.qty });
      }
    }
    o.status = 'cancelado'; o.cancelled = now;
    return { ok: true, order: o };
  }

  /* ---------- panel del dueño ---------- */
  function adminView(st) {
    const rowInfo = {}, prod = {};
    for (const p of st.products) {
      const bySize = {};
      let h = 0, rs = 0;
      for (const z of SIZES) {
        const a = onHand(st, p.id, z), b = reserved(st, p.id, z);
        if (a || b) bySize[z] = { onHand: a, reserved: b, available: Math.max(0, a - b) };
        h += a; rs += b;
      }
      prod[p.id] = { onHand: h, reserved: rs, available: Math.max(0, h - rs), pre: isPre(st, p), bySize };
    }
    for (const r of st.stock) {
      const a = onHand(st, r.p, r.size), b = reserved(st, r.p, r.size);
      rowInfo[r.id] = { reserved: b, available: Math.max(0, a - b), over: b > a };
    }
    const s = st.settings;
    return {
      settings: { name: s.name, sub: s.sub, wa: s.wa, cur: s.cur, low: s.low, reserveHours: s.reserveHours },
      products: st.products, stock: st.stock, orders: st.orders, prod, rowInfo, sizes: SIZES
    };
  }

  function upsertProduct(st, d) {
    let p = d.id && st.products.find(x => x.id === d.id);
    if (!p) { p = { id: uid('p'), name: '', desc: '', price: 0, img: '', visible: true, pedido: true }; st.products.push(p); }
    if ('name' in d) p.name = str(d.name, 120);
    if ('desc' in d) p.desc = str(d.desc, 600);
    if ('price' in d) p.price = num(d.price, 0, 1e7);
    if ('visible' in d) p.visible = !!d.visible;
    if ('pedido' in d) p.pedido = !!d.pedido;
    if ('img' in d) p.img = str(d.img, 3e6);
    return p;
  }
  function deleteProduct(st, id) {
    st.products = st.products.filter(p => p.id !== id);
    st.stock = st.stock.filter(r => r.p !== id);
  }
  function upsertStock(st, d) {
    let r = d.id && st.stock.find(x => x.id === d.id);
    if (!r) {
      if (!st.products.some(p => p.id === d.p) || !SIZES.includes(d.size)) return null;
      r = { id: uid('r'), p: d.p, size: d.size, front: null, back: null, qty: 0 }; st.stock.push(r);
    }
    if ('p' in d && st.products.some(p => p.id === d.p)) r.p = d.p;
    if ('size' in d && SIZES.includes(d.size)) r.size = d.size;
    if ('front' in d) r.front = d.front === '' || d.front == null ? null : num(d.front, 0, 200);
    if ('back' in d) r.back = d.back === '' || d.back == null ? null : num(d.back, 0, 200);
    if ('qty' in d) r.qty = int(d.qty, 0, 99999);
    return r;
  }
  function adjustStock(st, id, delta) {
    const r = st.stock.find(x => x.id === id);
    if (!r) return null;
    r.qty = int(r.qty + int(delta, -9999, 9999), 0, 99999);
    return r;
  }
  function deleteStock(st, id) { st.stock = st.stock.filter(r => r.id !== id); }
  function saveSettings(st, d) {
    const s = st.settings;
    if ('name' in d) s.name = str(d.name, 60).trim() || 'OIKOS';
    if ('sub' in d) s.sub = str(d.sub, 300);
    if ('wa' in d) s.wa = str(d.wa, 20).replace(/\D/g, '');
    if ('cur' in d) s.cur = str(d.cur, 8) || 'Bs';
    if ('low' in d) s.low = int(d.low, 0, 999);
    if ('reserveHours' in d) s.reserveHours = num(d.reserveHours, 0.25, 720);
    return s;
  }

  return { SIZES, PRE_SIZES, MAX_LINE, defaults, fromSeed, onHand, reserved, available, availTotal, isPre, expire,
    publicCatalog, createOrder, confirmOrder, cancelOrder, adminView, upsertProduct, deleteProduct,
    upsertStock, adjustStock, deleteStock, saveSettings, uid };
});

/* ============================================================
   TIENDA OIKOS · servidor en Google Apps Script + Google Sheets
   La hoja es la base de datos: Productos, Stock, Pedidos, Ajustes.
   La lógica de reservas es la misma de core.js (arriba).
   ============================================================ */
var INITIAL_PIN = 'CAMBIA_ESTE_PIN';          // solo se usa al ejecutar setup() por primera vez
var HEAD = {
  Productos: ['id', 'nombre', 'descripcion', 'precio', 'imagen', 'visible', 'a_pedido'],
  Stock: ['id', 'producto_id', 'producto', 'talla', 'frente_cm', 'espalda_cm', 'existencia', 'reservado', 'disponible'],
  Pedidos: ['codigo', 'creado', 'vence', 'cliente', 'telefono', 'nota', 'articulos', 'total', 'estado', 'confirmado', 'cancelado'],
  Ajustes: ['clave', 'valor']
};
var SEED = {"settings": {"name": "OIKOS", "title": "", "sub": "Escribe aquí una frase sobre tu tienda.", "wa": "59171015521", "cur": "Bs", "low": 3}, "products": [{"id": "p1", "name": "Playera negra · Heridos en relación", "desc": "Negra, con el logo OIKOS en el pecho. En la espalda, «heridos en RELACIÓN, sanados en» con flechas circulares y un corazón geométrico, en blanco.", "price": 150, "img": "", "visible": true}, {"id": "p2", "name": "Playera negra · COM[UNIDAD]", "desc": "Negra, con COM[UNIDAD] grande al frente: COM en blanco y UNIDAD en naranja entre corchetes. En la espalda, el logo OIKOS en blanco.", "price": 150, "img": "", "visible": true}, {"id": "p3", "name": "Playera negra · Una silla para cada historia", "desc": "Negra, con el logo OIKOS en el pecho. En la espalda, dibujos de sillas y la frase «Hay una silla para cada historia y una mesa para todos».", "price": 150, "img": "", "visible": true}, {"id": "p4", "name": "Playera negra · Todos a la mesa", "desc": "Negra, con el logo OIKOS en el pecho. En la espalda, el dibujo de una mesa a línea y «Todos a la mesa» en letra manuscrita.", "price": 150, "img": "", "visible": true}, {"id": "p5", "name": "Playera negra · Habitar", "desc": "Negra, con el logo OIKOS en el pecho. En la espalda, HABITAR repetido en letras grandes sobre una foto en blanco y negro de cuatro personas abrazadas.", "price": 150, "img": "", "visible": true}, {"id": "p6", "name": "Playera raglán · La comunidad del brunch", "desc": "Raglán blanca con mangas azul marino. Al frente, «La comunidad del brunch» con tablero a cuadros, íconos y el sello OIKOS Est. 2024. Logo en la espalda.", "price": 150, "img": "", "visible": true}, {"id": "p7", "name": "Playera raglán · Habitar en familia", "desc": "Raglán blanca con mangas azul marino. Al frente, «Habitar en familia» en azul marino. En la espalda, el logo OIKOS.", "price": 150, "img": "", "visible": true}], "stock": [{"id": "r1", "p": "p3", "size": "S", "front": 9, "back": 28, "qty": 1}, {"id": "r2", "p": "p3", "size": "M", "front": 9, "back": 28, "qty": 1}, {"id": "r3", "p": "p3", "size": "L", "front": 11, "back": 32, "qty": 3}, {"id": "r4", "p": "p3", "size": "XL", "front": 12, "back": 32, "qty": 1}, {"id": "r5", "p": "p5", "size": "M", "front": 9, "back": 26, "qty": 1}, {"id": "r6", "p": "p5", "size": "L", "front": 11, "back": 28, "qty": 1}, {"id": "r7", "p": "p5", "size": "2XL", "front": 12, "back": 32, "qty": 1}, {"id": "r8", "p": "p1", "size": "M", "front": 9, "back": 28, "qty": 1}, {"id": "r9", "p": "p1", "size": "XL", "front": 12, "back": 32, "qty": 1}, {"id": "r10", "p": "p2", "size": "M", "front": 28, "back": 9, "qty": 1}, {"id": "r11", "p": "p7", "size": "M", "front": 27, "back": 9, "qty": 1}, {"id": "r12", "p": "p7", "size": "L", "front": 29, "back": 11, "qty": 2}, {"id": "r13", "p": "p7", "size": "XL", "front": 29, "back": 12, "qty": 1}, {"id": "r14", "p": "p7", "size": "2XL", "front": 33, "back": 12, "qty": 1}, {"id": "r15", "p": "p6", "size": "P (6 años)", "front": null, "back": null, "qty": 1}, {"id": "r16", "p": "p6", "size": "S", "front": 28, "back": 9, "qty": 1}, {"id": "r17", "p": "p6", "size": "M", "front": 28, "back": 9, "qty": 1}, {"id": "r18", "p": "p6", "size": "L", "front": 30, "back": 11, "qty": 1}, {"id": "r19", "p": "p6", "size": "XL", "front": 30, "back": 12, "qty": 2}, {"id": "r20", "p": "p6", "size": "2XL", "front": 33, "back": 12, "qty": 1}]};

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(n) {
  var s = ss_().getSheetByName(n);
  if (!s) { s = ss_().insertSheet(n); s.getRange(1, 1, 1, HEAD[n].length).setValues([HEAD[n]]).setFontWeight('bold'); s.setFrozenRows(1);
    var txt = { Productos: [1], Stock: [1, 2, 4], Pedidos: [1, 5], Ajustes: [] }[n];
    txt.forEach(function (c) { s.getRange(2, c, 2000, 1).setNumberFormat('@'); });
  }
  return s;
}
function rows_(n) {
  var v = sheet_(n).getDataRange().getValues(), h = v.shift();
  return v.filter(function (r) { return r.some(function (c) { return c !== ''; }); })
    .map(function (r) { var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o; });
}
function write_(n, arr) {
  var s = sheet_(n), w = HEAD[n].length, last = s.getLastRow();
  if (last > 1) s.getRange(2, 1, last - 1, Math.max(w, s.getLastColumn())).clearContent();
  if (arr.length) s.getRange(2, 1, arr.length, w).setValues(arr);
}
var bool_ = function (v) { return v === true || /^(true|si|sí|1|x)$/i.test(String(v).trim()); };
var nul_ = function (v) { return v === '' || v == null ? null : Number(v); };

/* hoja -> estado */
function load_() {
  var set = {}, pinHash = '';
  rows_('Ajustes').forEach(function (r) { set[r.clave] = r.valor; });
  pinHash = String(set.pinHash || ''); delete set.pinHash;
  var seed = {
    settings: set,
    products: rows_('Productos').map(function (r) {
      return { id: String(r.id), name: r.nombre, desc: r.descripcion, price: r.precio, img: String(r.imagen || ''), visible: bool_(r.visible), pedido: bool_(r.a_pedido) };
    }),
    stock: rows_('Stock').map(function (r) {
      return { id: String(r.id || ''), p: String(r.producto_id), size: String(r.talla), front: nul_(r.frente_cm), back: nul_(r.espalda_cm), qty: r.existencia };
    })
  };
  var st = Core.fromSeed(seed);
  st.orders = rows_('Pedidos').map(function (r) {
    var items = []; try { items = JSON.parse(r.articulos); } catch (e) {}
    var o = { id: String(r.codigo), created: new Date(r.creado).getTime(), expires: r.vence === '' ? null : new Date(r.vence).getTime(),
      name: r.cliente, phone: String(r.telefono || ''), note: r.nota, items: items, total: Number(r.total) || 0, status: String(r.estado) };
    if (r.confirmado !== '') o.confirmed = new Date(r.confirmado).getTime();
    if (r.cancelado !== '') o.cancelled = new Date(r.cancelado).getTime();
    return o;
  });
  st.pinHash = pinHash;
  return st;
}
/* estado -> hoja */
function save_(st) {
  var d = function (ms) { return ms == null ? '' : new Date(ms); };
  var name = {}; st.products.forEach(function (p) { name[p.id] = p.name; });
  write_('Productos', st.products.map(function (p) { return [p.id, p.name, p.desc, p.price, p.img, p.visible, p.pedido !== false]; }));
  write_('Stock', st.stock.map(function (r) {
    var res = Core.reserved(st, r.p, r.size);
    return [r.id, r.p, name[r.p] || '', r.size, r.front == null ? '' : r.front, r.back == null ? '' : r.back, r.qty, res, Math.max(0, r.qty - res)];
  }));
  write_('Pedidos', st.orders.map(function (o) {
    return [o.id, d(o.created), d(o.expires), o.name, o.phone, o.note, JSON.stringify(o.items), o.total, o.status, d(o.confirmed), d(o.cancelled)];
  }));
  var s = st.settings;
  write_('Ajustes', [['name', s.name], ['sub', s.sub], ['wa', s.wa], ['cur', s.cur], ['low', s.low], ['reserveHours', s.reserveHours], ['pinHash', st.pinHash]]);
}

/* ---------- PIN y sesiones ---------- */
function hash_(pin, salt) {
  salt = salt || Utilities.getUuid().slice(0, 12);
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return salt + ':' + d.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function checkPin_(pin, stored) {
  var salt = String(stored || '').split(':')[0];
  return !!salt && hash_(pin, salt) === stored;
}
var cache_ = function () { return CacheService.getScriptCache(); };

/* ---------- API (mismas rutas que el servidor Node) ---------- */
function handle_(rq) {
  var m = String(rq.method || 'GET'), p = String(rq.path || ''), b = rq.body || {}, now = Date.now();
  var st = load_(), dirty = Core.expire(st, now), out;
  var done = function (code, body) { if (dirty) save_(st); return { s: code, b: body }; };

  if (m === 'GET' && p === '/api/catalog') return done(200, Core.publicCatalog(st));

  if (m === 'POST' && p === '/api/orders') {
    var pend = st.orders.filter(function (o) { return o.status === 'reservado'; });
    if (pend.length >= 150) return done(429, { error: 'rate' });
    var ph = String(b.phone || '').replace(/\D/g, '');
    if (ph && pend.filter(function (o) { return String(o.phone).replace(/\D/g, '') === ph; }).length >= 3) return done(429, { error: 'pending' });
    var r = Core.createOrder(st, b, now);
    if (!r.ok) return done(r.error === 'unavailable' ? 409 : 400, r);
    dirty = true; var o = r.order;
    return done(201, { ok: true, order: { id: o.id, expires: o.expires, total: o.total, items: o.items, name: o.name } });
  }

  if (m === 'POST' && p === '/api/admin/login') {
    var fails = Number(cache_().get('fails') || 0);
    if (fails >= 8) return done(429, { error: 'rate' });
    if (!checkPin_(b.pin, st.pinHash)) { cache_().put('fails', String(fails + 1), 600); return done(401, { error: 'pin' }); }
    var t = Utilities.getUuid() + Utilities.getUuid();
    cache_().put('t_' + t, '1', 21000);
    return done(200, { token: t });
  }

  if (p.indexOf('/api/admin/') === 0) {
    if (!rq.token || !cache_().get('t_' + rq.token)) return done(401, { error: 'auth' });
    var seg = p.split('/').slice(3), view = function () { return Core.adminView(st); };
    if (m === 'GET' && seg[0] === 'state') return done(200, view());
    if (seg[0] === 'product' && m === 'PUT') Core.upsertProduct(st, Object.assign({}, b, { id: seg[1] || b.id, img: undefined }));
    else if (seg[0] === 'product' && seg[2] === 'image') return done(400, { error: 'image' });
    else if (seg[0] === 'product' && m === 'DELETE') Core.deleteProduct(st, seg[1]);
    else if (seg[0] === 'stock' && seg[2] === 'adjust') { if (!Core.adjustStock(st, seg[1], b.delta)) return done(404, { error: 'notfound' }); }
    else if (seg[0] === 'stock' && m === 'PUT') { if (!Core.upsertStock(st, Object.assign({}, b, { id: seg[1] || b.id }))) return done(400, { error: 'stock' }); }
    else if (seg[0] === 'stock' && m === 'DELETE') Core.deleteStock(st, seg[1]);
    else if (seg[0] === 'settings' && m === 'PUT') Core.saveSettings(st, b);
    else if (seg[0] === 'pin' && m === 'POST') {
      if (String(b.pin || '').length < 4) return done(400, { error: 'pin' });
      st.pinHash = hash_(b.pin);
    }
    else if (seg[0] === 'orders' && seg[2] === 'confirm') { var c = Core.confirmOrder(st, seg[1], now); if (!c.ok) return done(409, c); }
    else if (seg[0] === 'orders' && seg[2] === 'cancel') { var k = Core.cancelOrder(st, seg[1], now); if (!k.ok) return done(409, k); }
    else return done(404, { error: 'route' });
    dirty = true;
    return done(200, view());
  }
  return done(404, { error: 'route' });
}

function run_(rq) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return handle_(rq); }
  catch (err) { return { s: 500, b: { error: 'server', detail: String(err) } }; }
  finally { lock.releaseLock(); }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function doPost(e) { var rq = {}; try { rq = JSON.parse(e.postData.contents); } catch (x) {} return json_(run_(rq)); }
function doGet() { return json_(run_({ method: 'GET', path: '/api/catalog' })); }

/* ---------- primera vez: crea las pestañas con el stock inicial ---------- */
function setup() {
  var st = Core.fromSeed(SEED);
  st.products.forEach(function (p) { p.img = p.id + '.jpg'; });
  st.pinHash = hash_(INITIAL_PIN);
  ['Productos', 'Stock', 'Pedidos', 'Ajustes'].forEach(sheet_);
  save_(st);
  var first = ss_().getSheetByName('Hoja 1') || ss_().getSheetByName('Sheet1');
  if (first) ss_().deleteSheet(first);
  SpreadsheetApp.flush();
}
/* cambiar el PIN del vendedor: edita la línea y ejecuta esta función */
function cambiarPin() {
  var st = load_(); st.pinHash = hash_('NUEVO_PIN'); save_(st);
}
