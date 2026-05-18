// @ts-check
'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const PORT = Number(process.env.DESK_API_PORT) || 3001;
const ROOT = __dirname;

// ── Файлы ─────────────────────────────────────────────────────────────────────
const F_ORDERS    = path.join(ROOT, 'desk-orders.json');
const F_CLIENTS   = path.join(ROOT, 'src/clients.json');
const F_LOCAL     = path.join(ROOT, 'desk-local-products.json');
const F_WHITELIST = path.join(ROOT, 'desk-whitelist.json');
const F_OPERATORS = path.join(ROOT, 'desk-operator-names.json');

// ── Утилиты ───────────────────────────────────────────────────────────────────
/** @param {string} file @param {any} def */
function rj(file, def) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : def; }
  catch { return def; }
}
/** @param {string} file @param {any} data */
function wj(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }

/** @param {http.IncomingMessage} req */
function body(req) {
  return new Promise((ok, fail) => {
    let s = '';
    req.on('data', c => (s += c));
    req.on('end',  () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
    req.on('error', fail);
  });
}

/**
 * @param {http.ServerResponse} res
 * @param {number} code
 * @param {any} data
 */
function reply(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data, null, 2));
}

/** @param {import('./src/types').SavedOrder} order */
function recalc(order) {
  const sum = order.items.reduce((s, i) => s + i.price * i.qty, 0);
  order.total = order.orderMethod === 'app'
    ? (order.orderAmount || 0) + (order.deliveryPrice || 0) + sum
    : sum;
}

// ── Мини-роутер ───────────────────────────────────────────────────────────────
/** @type {Array<{method:string, re:RegExp, keys:string[], fn:Function}>} */
const routes = [];

/**
 * @param {string} method
 * @param {string} pattern  — поддерживает :param
 * @param {Function} fn
 */
function on(method, pattern, fn) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
}

/**
 * @param {string} method
 * @param {string} url
 */
function match(method, url) {
  const [pathname] = url.split('?');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    /** @type {Record<string,string>} */
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return { fn: r.fn, params };
  }
  return null;
}

// ── ЗАКАЗЫ ────────────────────────────────────────────────────────────────────

// GET /api/orders — список всех заказов
on('GET', '/api/orders', (_req, res) => {
  reply(res, 200, rj(F_ORDERS, []));
});

// GET /api/orders/:id — один заказ
on('GET', '/api/orders/:id', (_req, res, { id }) => {
  const order = rj(F_ORDERS, []).find(o => o.id === id);
  order ? reply(res, 200, order) : reply(res, 404, { error: 'not found' });
});

// POST /api/orders — создать заказ
// Body: { storeId, client, items, orderMethod, payMethod, operator,
//         orderNumber?, deliveryPrice?, orderAmount? }
on('POST', '/api/orders', async (req, res) => {
  const b = await body(req);
  const order = {
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
    status:       b.status      || 'created',
    storeId:      b.storeId     || '',
    client:       b.client      || { phone:'', name:'', street:'', house:'', entrance:'', floor:'', apartment:'', intercom:'', notes:'' },
    orderMethod:  b.orderMethod || 'phone',
    payMethod:    b.payMethod   || 'cash',
    operator:     b.operator    || '',
    items:        b.items       || [],
    total:        b.total       || 0,
    ...(b.orderNumber   != null ? { orderNumber:   b.orderNumber }   : {}),
    ...(b.deliveryPrice != null ? { deliveryPrice: b.deliveryPrice } : {}),
    ...(b.orderAmount   != null ? { orderAmount:   b.orderAmount }   : {}),
  };
  if (!order.total) recalc(order);
  const list = rj(F_ORDERS, []);
  list.unshift(order);
  wj(F_ORDERS, list);
  reply(res, 201, order);
});

// PATCH /api/orders/:id — обновить поля заказа
// Body: любые поля из SavedOrder (status, storeId, client, payMethod, operator, items, …)
on('PATCH', '/api/orders/:id', async (req, res, { id }) => {
  const b = await body(req);
  const list = rj(F_ORDERS, []);
  const order = list.find(o => o.id === id);
  if (!order) return reply(res, 404, { error: 'not found' });
  const allowed = ['status','storeId','client','payMethod','operator','orderMethod',
                   'orderNumber','deliveryPrice','orderAmount','items','given','change'];
  for (const k of allowed) if (k in b) order[k] = b[k];
  if ('items' in b || 'deliveryPrice' in b || 'orderAmount' in b) recalc(order);
  wj(F_ORDERS, list);
  reply(res, 200, order);
});

// DELETE /api/orders/:id — удалить заказ
on('DELETE', '/api/orders/:id', (_req, res, { id }) => {
  const list = rj(F_ORDERS, []);
  if (!list.some(o => o.id === id)) return reply(res, 404, { error: 'not found' });
  wj(F_ORDERS, list.filter(o => o.id !== id));
  reply(res, 200, { ok: true });
});

// ── ПОЗИЦИИ ЗАКАЗА ────────────────────────────────────────────────────────────

// POST /api/orders/:id/items — добавить позицию
// Body: { id?, name, qty, price, productType, details? }
on('POST', '/api/orders/:id/items', async (req, res, { id }) => {
  const b = await body(req);
  const list = rj(F_ORDERS, []);
  const order = list.find(o => o.id === id);
  if (!order) return reply(res, 404, { error: 'order not found' });
  order.items.push({
    id:          b.id,
    name:        b.name        || '',
    qty:         b.qty         || 1,
    price:       b.price       || 0,
    productType: b.productType || 'PIECE',
    ...(b.details ? { details: b.details } : {}),
  });
  recalc(order);
  wj(F_ORDERS, list);
  reply(res, 201, order);
});

// PATCH /api/orders/:id/items/:idx — изменить позицию (qty, price, name)
on('PATCH', '/api/orders/:id/items/:idx', async (req, res, { id, idx }) => {
  const b = await body(req);
  const list = rj(F_ORDERS, []);
  const order = list.find(o => o.id === id);
  if (!order) return reply(res, 404, { error: 'order not found' });
  const item = order.items[Number(idx)];
  if (!item) return reply(res, 404, { error: 'item not found' });
  if (b.qty   != null) item.qty   = Math.max(0.001, b.qty);
  if (b.price != null) item.price = b.price;
  if (b.name  != null) item.name  = b.name;
  recalc(order);
  wj(F_ORDERS, list);
  reply(res, 200, order);
});

// DELETE /api/orders/:id/items/:idx — удалить позицию
on('DELETE', '/api/orders/:id/items/:idx', (_req, res, { id, idx }) => {
  const list = rj(F_ORDERS, []);
  const order = list.find(o => o.id === id);
  if (!order) return reply(res, 404, { error: 'order not found' });
  if (!order.items[Number(idx)]) return reply(res, 404, { error: 'item not found' });
  order.items.splice(Number(idx), 1);
  recalc(order);
  wj(F_ORDERS, list);
  reply(res, 200, order);
});

// ── КЛИЕНТЫ ───────────────────────────────────────────────────────────────────

// GET /api/clients — все клиенты
on('GET', '/api/clients', (_req, res) => {
  reply(res, 200, rj(F_CLIENTS, []));
});

// GET /api/clients/:phone — клиент по телефону
on('GET', '/api/clients/:phone', (_req, res, { phone }) => {
  const c = rj(F_CLIENTS, []).find(x => x.phone === phone);
  c ? reply(res, 200, c) : reply(res, 404, { error: 'not found' });
});

// POST /api/clients — создать или обновить клиента (по phone)
on('POST', '/api/clients', async (req, res) => {
  const b = await body(req);
  const list = rj(F_CLIENTS, []);
  const i = list.findIndex(x => x.phone === b.phone);
  if (i >= 0) { Object.assign(list[i], b); wj(F_CLIENTS, list); return reply(res, 200, list[i]); }
  list.push(b); wj(F_CLIENTS, list); reply(res, 201, b);
});

// PATCH /api/clients/:phone — обновить поля клиента
on('PATCH', '/api/clients/:phone', async (req, res, { phone }) => {
  const b = await body(req);
  const list = rj(F_CLIENTS, []);
  const c = list.find(x => x.phone === phone);
  if (!c) return reply(res, 404, { error: 'not found' });
  Object.assign(c, b);
  wj(F_CLIENTS, list);
  reply(res, 200, c);
});

// DELETE /api/clients/:phone — удалить клиента
on('DELETE', '/api/clients/:phone', (_req, res, { phone }) => {
  const list = rj(F_CLIENTS, []);
  if (!list.some(x => x.phone === phone)) return reply(res, 404, { error: 'not found' });
  wj(F_CLIENTS, list.filter(x => x.phone !== phone));
  reply(res, 200, { ok: true });
});

// ── СВОИ ТОВАРЫ ───────────────────────────────────────────────────────────────

// GET /api/local-products — список
on('GET', '/api/local-products', (_req, res) => {
  reply(res, 200, rj(F_LOCAL, []));
});

// POST /api/local-products — добавить товар
// Body: { name, price, productType? }
on('POST', '/api/local-products', async (req, res) => {
  const b = await body(req);
  if (!b.name) return reply(res, 400, { error: 'name required' });
  const item = {
    id: `local_${Date.now()}`,
    name: String(b.name).trim(),
    price: Math.max(0, parseFloat(b.price) || 0),
    productType: b.productType || 'PIECE',
  };
  const list = rj(F_LOCAL, []);
  list.push(item);
  wj(F_LOCAL, list);
  reply(res, 201, item);
});

// PATCH /api/local-products/:id — редактировать товар
on('PATCH', '/api/local-products/:id', async (req, res, { id }) => {
  const b = await body(req);
  const list = rj(F_LOCAL, []);
  const item = list.find(x => x.id === id);
  if (!item) return reply(res, 404, { error: 'not found' });
  if (b.name  != null) item.name  = String(b.name).trim();
  if (b.price != null) item.price = Math.max(0, parseFloat(b.price) || 0);
  if (b.productType) item.productType = b.productType;
  wj(F_LOCAL, list);
  reply(res, 200, item);
});

// DELETE /api/local-products/:id — удалить товар
on('DELETE', '/api/local-products/:id', (_req, res, { id }) => {
  const list = rj(F_LOCAL, []);
  if (!list.some(x => x.id === id)) return reply(res, 404, { error: 'not found' });
  wj(F_LOCAL, list.filter(x => x.id !== id));
  reply(res, 200, { ok: true });
});

// ── СПРАВОЧНИКИ ───────────────────────────────────────────────────────────────

// GET /api/whitelist — список разрешённых номеров
on('GET', '/api/whitelist', (_req, res) => {
  reply(res, 200, rj(F_WHITELIST, []));
});

// POST /api/whitelist — заменить список
on('POST', '/api/whitelist', async (req, res) => {
  const b = await body(req);
  if (!Array.isArray(b)) return reply(res, 400, { error: 'array expected' });
  wj(F_WHITELIST, b);
  reply(res, 200, { ok: true });
});

// GET /api/operator-names — имена операторов
on('GET', '/api/operator-names', (_req, res) => {
  reply(res, 200, rj(F_OPERATORS, {}));
});

// POST /api/operator-names — сохранить имена
on('POST', '/api/operator-names', async (req, res) => {
  const b = await body(req);
  wj(F_OPERATORS, b);
  reply(res, 200, { ok: true });
});

// ── ОСНОВНОЙ СЕРВЕР ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
    res.end();
    return;
  }

  const hit = match(req.method || 'GET', req.url || '/');
  if (!hit) {
    reply(res, 404, { error: 'unknown route', method: req.method, url: req.url });
    return;
  }

  try {
    await hit.fn(req, res, hit.params);
  } catch (e) {
    console.error(e);
    reply(res, 500, { error: String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OrderDesk API  →  http://127.0.0.1:${PORT}`);
  console.log('Routes:');
  for (const r of routes) console.log(` ${r.method.padEnd(7)} ${r.re.source.replace(/\(\[\^\/\]\+\)/g, ':x').replace(/^\^|\$$/g, '')}`);
});
