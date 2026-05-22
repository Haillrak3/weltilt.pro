// @ts-check
'use strict';

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { spawn, execSync } = require('child_process');

// ── Mango SSE clients ──────────────────────────────────────────────────────────
/** @type {Set<import('http').ServerResponse>} */
const mangoSseClients = new Set();

const PORT = Number(process.env.DESK_API_PORT) || 3001;
const ROOT = __dirname;

// ── API-ключ ──────────────────────────────────────────────────────────────────
// Читаем .env вручную (без внешних зависимостей)
try {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* .env необязателен */ }

const API_KEY = process.env.DESK_API_KEY || '';

// ── Файлы ─────────────────────────────────────────────────────────────────────
const F_ORDERS         = path.join(ROOT, 'desk-orders.json');
const F_CLIENTS        = path.join(ROOT, 'src/clients.json');
const F_LOCAL          = path.join(ROOT, 'desk-local-products.json');
const F_WHITELIST      = path.join(ROOT, 'desk-whitelist.json');
const F_OPERATORS      = path.join(ROOT, 'desk-operator-names.json');
const F_MANGO_ACCOUNTS = path.join(ROOT, 'desk-mango-accounts.json');
const F_C2C            = path.join(ROOT, 'desk-mango-c2c.json');
const F_OP_SESSIONS    = path.join(ROOT, 'desk-operator-sessions.json');
const SIP_SCRIPT       = path.join(ROOT, 'mango-sip.py');

// ── Operator sessions (desk_sid → operatorPhone) ──────────────────────────────
/** @param {import('http').IncomingMessage} req @returns {string} */
function getSid(req) {
  const m = (req.headers.cookie ?? '').match(/(?:^|;)\s*desk_sid=([0-9a-f]{64})/);
  return m ? m[1] : '';
}
/** @returns {Record<string,string>} */
function readOpSessions() {
  try { return JSON.parse(fs.readFileSync(F_OP_SESSIONS, 'utf8')); } catch { return {}; }
}
/** @param {Record<string,string>} data */
function writeOpSessions(data) {
  fs.writeFileSync(F_OP_SESSIONS, JSON.stringify(data), 'utf8');
}
/** @param {import('http').IncomingMessage} req @returns {string} */
function getSessionOperator(req) {
  const sid = getSid(req);
  if (!sid) return '';
  return readOpSessions()[sid] ?? '';
}

// ── Mango SIP daemon manager ──────────────────────────────────────────────────
/** @type {Map<number, {proc: import('child_process').ChildProcess, account: object}>} */
const sipDaemons = new Map();

/** @param {{operatorPhone:string,sipUser:string,sipPassword:string}} account @param {number} port */
function startSipDaemon(account, port) {
  const env = Object.assign({}, process.env, {
    SIP_USER: account.sipUser,
    SIP_PASSWORD: account.sipPassword,
    LOCAL_BIND_PORT: String(port),
  });
  const proc = spawn('python3', [SIP_SCRIPT], { env, stdio: 'ignore' });
  sipDaemons.set(port, { proc, account });
  proc.on('exit', () => {
    if (sipDaemons.get(port)?.proc === proc)
      setTimeout(() => startSipDaemon(account, port), 5000);
  });
}

function stopAllSipDaemons() {
  for (const [port, entry] of sipDaemons) {
    entry.proc.removeAllListeners('exit');
    entry.proc.kill();
    sipDaemons.delete(port);
  }
}

function reloadSipDaemons() {
  stopAllSipDaemons();
  // убиваем любые внешние процессы mango-sip.py на тех же портах
  try { execSync('pkill -f mango-sip.py', { timeout: 3000 }); } catch {}
  const accounts = rj(F_MANGO_ACCOUNTS, []);
  accounts.forEach((acc, idx) => startSipDaemon(acc, 5060 + idx));
}

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

// ── Click-to-Call helpers ─────────────────────────────────────────────────────
/** @type {Map<string, {token:string, exp:number}>} */
const _c2cTokenCache = new Map();

/** @param {string} hostname @param {string} urlPath @param {object} payload @returns {Promise<any>} */
function httpsPost(hostname, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('invalid json: ' + d)); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** @param {{c2cLogin:string, c2cPassword:string}} acc @returns {Promise<string>} */
async function c2cGetToken(acc) {
  const cached = _c2cTokenCache.get(acc.c2cLogin);
  if (cached && Date.now() < cached.exp) return cached.token;
  const resp = await httpsPost('itg.mango-office.ru', '/plugins/chrome/auth/login',
    { login: acc.c2cLogin, password: acc.c2cPassword, token: null });
  if (!resp || resp.result?.code !== '0') {
    throw new Error((resp?.data?.[0]?.message) || 'Ошибка авторизации Mango');
  }
  _c2cTokenCache.set(acc.c2cLogin, { token: resp.data.token, exp: Date.now() + 50 * 60 * 1000 });
  return resp.data.token;
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

// ── MANGO ─────────────────────────────────────────────────────────────────────

// GET /api/mango/events — SSE поток входящих звонков (без API-key, только чтение)
on('GET', '/api/mango/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  mangoSseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { mangoSseClients.delete(res); clearInterval(ping); });
});

// POST /api/mango/call — вызывается Python SIP-демоном (только localhost)
on('POST', '/api/mango/call', async (req, res) => {
  const remote = req.socket.remoteAddress || '';
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    return reply(res, 403, { error: 'local only' });
  }
  const b = await body(req);
  const data = JSON.stringify({ from: b.from || '', to: b.to || '', callId: b.callId || '', sipUser: b.sipUser || '', ts: Date.now() });
  for (const client of mangoSseClients) {
    try { client.write(`event: incoming_call\ndata: ${data}\n\n`); } catch {}
  }
  reply(res, 200, { ok: true, clients: mangoSseClients.size });
});

// GET /api/mango/accounts — список аккаунтов (пароли скрыты)
on('GET', '/api/mango/accounts', (_req, res) => {
  const accounts = rj(F_MANGO_ACCOUNTS, []);
  // eslint-disable-next-line no-unused-vars
  reply(res, 200, accounts.map(({ sipPassword: _sp, c2cPassword: _cp, ...rest }) => rest));
});

// POST /api/mango/accounts — сохранить и перезапустить SIP-демоны
on('POST', '/api/mango/accounts', async (req, res) => {
  const b = await body(req);
  if (!Array.isArray(b)) return reply(res, 400, { error: 'array expected' });
  for (const acc of b) {
    if (!acc.sipUser || !acc.sipPassword || !acc.operatorPhone)
      return reply(res, 400, { error: 'each account needs operatorPhone, sipUser, sipPassword' });
  }
  // Сохраняем c2cPassword из существующего файла если не передан (защита от затирания)
  const existing = rj(F_MANGO_ACCOUNTS, []);
  const merged = b.map(acc => {
    if (acc.c2cPassword) return acc; // новый пароль передан — используем его
    const prev = existing.find(e => e.operatorPhone === acc.operatorPhone);
    return prev?.c2cPassword ? { ...acc, c2cPassword: prev.c2cPassword } : acc;
  });
  wj(F_MANGO_ACCOUNTS, merged);
  _c2cTokenCache.clear();
  reloadSipDaemons();
  reply(res, 200, { ok: true });
});

// GET /api/mango/my-operator — телефон текущего оператора из серверной сессии
on('GET', '/api/mango/my-operator', (req, res) => {
  reply(res, 200, { phone: getSessionOperator(req) });
});

// POST /api/mango/bind-operator — привязать телефон оператора к сессии
on('POST', '/api/mango/bind-operator', async (req, res) => {
  const sid = getSid(req);
  if (!sid) return reply(res, 400, { error: 'Нет сессии' });
  const b = await body(req);
  const phone = String(b.phone || '').replace(/\D/g, '');
  if (phone.length < 10) return reply(res, 400, { error: 'Некорректный номер' });
  const sessions = readOpSessions();
  sessions[sid] = phone;
  writeOpSessions(sessions);
  reply(res, 200, { ok: true, phone });
});

// POST /api/mango/callback — инициировать обратный звонок клиенту
on('POST', '/api/mango/callback', async (req, res) => {
  const b = await body(req);
  const phone = String(b.phone || '').replace(/\D/g, '');
  if (phone.length < 7) return reply(res, 400, { error: 'phone required' });

  // operatorPhone: из тела запроса, либо из серверной сессии
  const operatorPhone = String(b.operatorPhone || '').replace(/\D/g, '') || getSessionOperator(req);
  const accounts = rj(F_MANGO_ACCOUNTS, []);

  const acc = operatorPhone
    ? accounts.find(a => a.operatorPhone.replace(/\D/g, '') === operatorPhone)
    : null;

  if (!acc) return reply(res, 400, { error: 'Аккаунт оператора не найден — выберите себя в списке операторов' });
  if (!acc.c2cLogin || !acc.c2cPassword) return reply(res, 400, { error: 'Click-to-Call не настроен для этого оператора' });

  try {
    const token = await c2cGetToken(acc);
    const userId = (acc.c2cUserId || acc.c2cLogin).trim();
    const result = await httpsPost('itg.mango-office.ru',
      `/plugins/chrome/callback?USER_ID=${encodeURIComponent(userId)}&DESTINATION_NUMBER=${encodeURIComponent(phone)}`,
      { token, phone });
    reply(res, 200, { ok: true, result });
  } catch (e) {
    _c2cTokenCache.delete(acc.c2cLogin);
    reply(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
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

  if (API_KEY) {
    const reqPath = (req.url || '').split('?')[0];
    const noAuthPaths = ['/api/mango/events', '/api/mango/call', '/api/mango/accounts', '/api/mango/c2c', '/api/mango/callback', '/api/mango/my-operator', '/api/mango/bind-operator'];
    if (!noAuthPaths.includes(reqPath)) {
      const auth = req.headers['authorization'] || '';
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-api-key'] || '');
      if (provided !== API_KEY) {
        reply(res, 401, { error: 'unauthorized' });
        return;
      }
    }
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
  reloadSipDaemons();
});
