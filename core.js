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
