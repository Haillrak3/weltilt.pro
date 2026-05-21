import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const p = (...parts: string[]) => path.join(ROOT, ...parts);

const COUNTRIES_FILE      = p('desk-countries.json');
const WHITELIST_FILE      = p('desk-whitelist.json');
const OPERATOR_NAMES_FILE = p('desk-operator-names.json');
const CATALOG_CACHE_FILE  = p('desk-cache-catalog.json');
const VENDOR_CACHE_FILE   = p('desk-cache-vendor.json');

const CATALOG_TTL = 60 * 60 * 1000;
const VENDOR_TTL  = 4 * 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────────

interface DbClientAddress {
  street: string; house: string; entrance: string;
  floor: string; apartment: string; intercom: string;
}
interface DbClient {
  name: string; phone: string; street: string; house: string;
  entrance: string; floor: string; apartment: string; intercom: string; notes: string;
  addresses?: DbClientAddress[];
  phones?: string[];
}
interface SavedOrderItem {
  id?: number; name: string; qty: number; price: number; productType: string; details?: string;
}
interface SavedOrderClient {
  phone: string; name: string; street: string; house: string;
  entrance: string; floor: string; apartment: string; intercom: string; notes: string;
}
interface SavedOrder {
  id: string; createdAt: string; status: 'created' | 'in_progress' | 'done';
  storeId: string; client: SavedOrderClient; orderMethod: 'phone' | 'app';
  payMethod: 'cash' | 'card'; operator: string; items: SavedOrderItem[]; total: number;
  orderNumber?: string; deliveryPrice?: number; orderAmount?: number; given?: number; change?: number;
}

// ── SQLite DB ─────────────────────────────────────────────────────────────────

const _db = new Database(p('desk.db'));
_db.pragma('journal_mode = WAL');
_db.pragma('foreign_keys = ON');
_db.pragma('busy_timeout = 5000');

function normPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  return d.length === 11 && d[0] === '7' ? '8' + d.slice(1) : d;
}

function rowToOrder(row: Record<string, unknown>) {
  const items = (_db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(row['id']) as Record<string, unknown>[])
    .map(item => ({
      ...(item['item_id'] != null ? { id: item['item_id'] } : {}),
      name: item['name'], qty: item['qty'], price: item['price'],
      productType: item['product_type'],
      ...(item['details'] != null ? { details: item['details'] } : {}),
    }));
  const order: Record<string, unknown> = {
    id: row['id'], createdAt: row['created_at'], status: row['status'],
    storeId: row['store_id'], orderMethod: row['order_method'], payMethod: row['pay_method'],
    operator: row['operator'], total: row['total'], items,
    client: {
      phone: row['client_phone'], name: row['client_name'], street: row['client_street'],
      house: row['client_house'], entrance: row['client_entrance'], floor: row['client_floor'],
      apartment: row['client_apartment'], intercom: row['client_intercom'], notes: row['client_notes'],
    },
  };
  if (row['seq_num']       != null) order['seqNum']        = row['seq_num'];
  if (row['order_number']  != null) order['orderNumber']   = row['order_number'];
  if (row['delivery_price']!= null) order['deliveryPrice'] = row['delivery_price'];
  if (row['order_amount']  != null) order['orderAmount']   = row['order_amount'];
  if (row['given']         != null) order['given']         = row['given'];
  if (row['change_amt']    != null) order['change']        = row['change_amt'];
  if (row['deleted_at']    != null) order['deletedAt']     = row['deleted_at'];
  return order;
}

function orderToRow(o: Record<string, unknown>, id: string, createdAt: string) {
  const c = (o['client'] as Record<string, unknown>) ?? {};
  return {
    id, created_at: createdAt,
    status:           o['status']        ?? 'created',
    store_id:         o['storeId']       ?? '',
    order_method:     o['orderMethod']   ?? 'phone',
    pay_method:       o['payMethod']     ?? 'cash',
    operator:         o['operator']      ?? '',
    total:            o['total']         ?? 0,
    seq_num:          o['seqNum']        ?? null,
    order_number:     o['orderNumber']   ?? null,
    delivery_price:   o['deliveryPrice'] ?? null,
    order_amount:     o['orderAmount']   ?? null,
    given:            o['given']         ?? null,
    change_amt:       o['change']        ?? null,
    deleted_at:       o['deletedAt']     ?? null,
    client_phone:     normPhone(String(c['phone'] ?? '')),
    client_name:      c['name']      ?? '',
    client_street:    c['street']    ?? '',
    client_house:     c['house']     ?? '',
    client_entrance:  c['entrance']  ?? '',
    client_floor:     c['floor']     ?? '',
    client_apartment: c['apartment'] ?? '',
    client_intercom:  c['intercom']  ?? '',
    client_notes:     c['notes']     ?? '',
  };
}

const _stmtInsertItem = _db.prepare(`
  INSERT INTO order_items (order_id,item_id,name,qty,price,product_type,details)
  VALUES (@order_id,@item_id,@name,@qty,@price,@product_type,@details)
`);
const _stmtDeleteItems = _db.prepare('DELETE FROM order_items WHERE order_id = ?');
const _stmtUpsertClient = _db.prepare(`
  INSERT INTO clients (phone,name,street,house,entrance,floor,apartment,intercom,notes)
  VALUES (@phone,@name,@street,@house,@entrance,@floor,@apartment,@intercom,@notes)
  ON CONFLICT(phone) DO NOTHING
`);

function rowToClient(row: Record<string, unknown>) {
  const c: Record<string, unknown> = {
    phone: row['phone'], name: row['name'], street: row['street'], house: row['house'],
    entrance: row['entrance'], floor: row['floor'], apartment: row['apartment'],
    intercom: row['intercom'], notes: row['notes'],
  };
  if (row['addresses_json']) try { c['addresses'] = JSON.parse(row['addresses_json'] as string); } catch { /* */ }
  if (row['phones_json'])    try { c['phones']    = JSON.parse(row['phones_json']    as string); } catch { /* */ }
  return c;
}

function insertItemsForOrder(orderId: string, items: unknown[]) {
  for (const item of items) {
    const i = item as Record<string, unknown>;
    _stmtInsertItem.run({ order_id: orderId, item_id: i['id'] ?? null, name: i['name'] ?? '',
      qty: i['qty'] ?? 1, price: i['price'] ?? 0, product_type: i['productType'] ?? 'PIECE', details: i['details'] ?? null });
  }
}

const _syncOrders = _db.transaction((orders: unknown[]) => {
  const insertStmt = _db.prepare(`INSERT OR IGNORE INTO orders (
    id,created_at,status,store_id,order_method,pay_method,operator,total,seq_num,
    order_number,delivery_price,order_amount,given,change_amt,deleted_at,
    client_phone,client_name,client_street,client_house,client_entrance,
    client_floor,client_apartment,client_intercom,client_notes
  ) VALUES (
    @id,@created_at,@status,@store_id,@order_method,@pay_method,@operator,@total,@seq_num,
    @order_number,@delivery_price,@order_amount,@given,@change_amt,@deleted_at,
    @client_phone,@client_name,@client_street,@client_house,@client_entrance,
    @client_floor,@client_apartment,@client_intercom,@client_notes
  )`);
  const updateStmt = _db.prepare(`UPDATE orders SET
    status=@status,store_id=@store_id,order_method=@order_method,pay_method=@pay_method,
    operator=@operator,total=@total,seq_num=@seq_num,order_number=@order_number,
    delivery_price=@delivery_price,order_amount=@order_amount,given=@given,
    change_amt=@change_amt,deleted_at=@deleted_at,
    client_phone=@client_phone,client_name=@client_name,client_street=@client_street,
    client_house=@client_house,client_entrance=@client_entrance,client_floor=@client_floor,
    client_apartment=@client_apartment,client_intercom=@client_intercom,client_notes=@client_notes
    WHERE id=@id`);
  for (const o of orders) {
    const order = o as Record<string, unknown>;
    const row = orderToRow(order, String(order['id']), String(order['createdAt']));
    const exists = _db.prepare('SELECT id FROM orders WHERE id = ?').get(row.id);
    if (exists) {
      updateStmt.run(row);
      _stmtDeleteItems.run(row.id);
    } else {
      insertStmt.run(row);
    }
    insertItemsForOrder(String(row.id), (order['items'] as unknown[]) ?? []);
    if (String(row.client_phone).length >= 7) _stmtUpsertClient.run({
      phone: row.client_phone, name: row.client_name, street: row.client_street,
      house: row.client_house, entrance: row.client_entrance, floor: row.client_floor,
      apartment: row.client_apartment, intercom: row.client_intercom, notes: row.client_notes,
    });
  }
});

// ── Auth / Session ────────────────────────────────────────────────────────────

const _ADMIN_PASS   = process.env['DESK_ADMIN_PASSWORD'] ?? 'Nikifor1';
const _API_TOKEN    = process.env['DESK_API_TOKEN'] ?? '';   // static bearer token for scripts
const _SESSION_TTL  = 12 * 60 * 60 * 1000; // 12 h
const _sessions     = new Map<string, { phone: string; expires: number }>();

function _getSid(r: IncomingMessage): string | null {
  const m = (r.headers.cookie ?? '').match(/(?:^|;)\s*desk_sid=([0-9a-f]{64})/);
  return m?.[1] ?? null;
}

function _validSession(r: IncomingMessage): boolean {
  const sid = _getSid(r);
  if (!sid) return false;
  const s = _sessions.get(sid);
  if (!s) return false;
  if (Date.now() > s.expires) { _sessions.delete(sid); return false; }
  return true;
}

function _normWL(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') return '7' + d.slice(1);
  if (d.length === 10) return '7' + d;
  return d;
}

function _readWhitelist(): Set<string> {
  try {
    const raw = fs.existsSync(WHITELIST_FILE)
      ? JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8')) as string[]
      : [];
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}

function _makeSession(phone: string): string {
  const sid = randomBytes(32).toString('hex');
  _sessions.set(sid, { phone, expires: Date.now() + _SESSION_TTL });
  return sid;
}

function _sidCookie(sid: string): string {
  return `desk_sid=${sid}; Max-Age=${_SESSION_TTL / 1000}; Path=/; HttpOnly; SameSite=Strict`;
}

function _checkBearer(r: IncomingMessage): boolean {
  const auth = (r.headers['authorization'] as string | undefined) ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const tok = auth.slice(7).trim();
  if (!tok) return false;
  // When a dedicated API token is configured, only it is accepted
  if (_API_TOKEN) return tok === _API_TOKEN;
  // Fallback: accept admin password (useful during initial setup before token is configured)
  return tok === _ADMIN_PASS;
}

function requireAuth(handler: Middleware): Middleware {
  return (req, res, next) => {
    const r = req as IncomingMessage;
    if (_validSession(r) || _checkBearer(r)) return handler(req, res, next);
    const s = res as ServerResponse;
    s.statusCode = 401;
    s.setHeader('Content-Type', 'application/json');
    s.end('{"ok":false,"error":"Не авторизован"}');
  };
}

// ── Cache helpers ────────────────────────────────────────────────────────────

type CacheEntry = { ts: number; list: unknown[] };

function loadDiskCache(file: string): Map<string, CacheEntry> {
  const map = new Map<string, CacheEntry>();
  try {
    if (!fs.existsSync(file)) return map;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, CacheEntry>;
    for (const [k, v] of Object.entries(raw)) map.set(k, v);
  } catch { /* ignore */ }
  return map;
}

function saveDiskCache(file: string, map: Map<string, CacheEntry>): void {
  try {
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(map)), 'utf8');
  } catch { /* ignore */ }
}

const catalogCache = loadDiskCache(CATALOG_CACHE_FILE);
const vendorCache  = loadDiskCache(VENDOR_CACHE_FILE);

let warmupRunning = false;

async function warmCatalogInBackground(token: string, storeIds: string[]): Promise<void> {
  if (warmupRunning) return;
  warmupRunning = true;
  try {
    for (const storeId of storeIds) {
      let catList: { id: number }[] = [];
      try {
        const r = await fetch(
          `https://api.0-5.ru/api/v1/catalog/categories?store_id=${storeId}&per_page=100`,
          { headers: { 'X-Auth-Token': token, 'X-App': '2po2', Accept: 'application/json' } },
        );
        const j = await r.json() as { data?: { list?: { id: number }[] } };
        catList = j.data?.list ?? [];
      } catch { continue; }

      const subLists = await Promise.all(catList.map(async (cat) => {
        try {
          const r = await fetch(
            `https://api.0-5.ru/api/v1/catalog/categories?store_id=${storeId}&parent_id=${cat.id}&per_page=100`,
            { headers: { 'X-Auth-Token': token, 'X-App': '2po2', Accept: 'application/json' } },
          );
          const j = await r.json() as { data?: { list?: { id: number }[] } };
          return j.data?.list ?? [];
        } catch { return []; }
      }));

      const allIds = [...catList.map((c) => c.id), ...subLists.flat().map((s) => s.id)];
      const now = Date.now();

      await Promise.all(allIds.map(async (catId) => {
        const key = `${storeId}_${catId}`;
        const cached = catalogCache.get(key);
        if (cached && now - cached.ts < CATALOG_TTL) return;
        try {
          const list = await fetchAllPages(
            `https://api.0-5.ru/api/v1/catalog/products?store_id=${storeId}&category_id=${catId}`,
            token,
          );
          catalogCache.set(key, { ts: now, list });
        } catch { /* skip */ }
      }));

      saveDiskCache(CATALOG_CACHE_FILE, catalogCache);
    }
  } finally {
    warmupRunning = false;
  }
}

async function fetchAllPages(baseUrl: string, token: string): Promise<unknown[]> {
  const all: unknown[] = [];
  let page = 1;
  for (;;) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${baseUrl}${sep}page=${page}&per_page=100`, {
      headers: { 'X-Auth-Token': token, 'X-App': '2po2', 'Accept': 'application/json' },
    });
    if (!res.ok) break;
    const json = await res.json() as { data?: { list?: unknown[]; has_more?: boolean } };
    all.push(...(json.data?.list ?? []));
    if (!json.data?.has_more) break;
    page++;
  }
  return all;
}

type Middleware = (req: unknown, res: unknown, next: unknown) => void;

// ── Proxy handler for catalog cache ─────────────────────────────────────────

function makeProxyHandler(
  getApiUrl: (qs: URLSearchParams) => string,
  getCacheKey: (qs: URLSearchParams) => string,
  cache: Map<string, CacheEntry>,
  cacheFile: string,
  ttl: number,
): Middleware {
  return (req, res, _next) => {
    const r = req as IncomingMessage;
    const s = res as ServerResponse;
    s.setHeader('Content-Type', 'application/json');

    if (r.method !== 'GET') {
      s.statusCode = 405;
      s.end('{"success":false,"message":"method not allowed"}');
      return;
    }

    const qs = new URL(r.url ?? '', 'http://localhost').searchParams;
    const key = getCacheKey(qs);
    const token = (r.headers['x-auth-token'] as string | undefined) ?? '';
    const now = Date.now();

    const cached = cache.get(key);
    if (cached && now - cached.ts < ttl) {
      const maxAge = Math.floor((ttl - (now - cached.ts)) / 1000);
      s.setHeader('Cache-Control', `private, max-age=${maxAge}`);
      s.end(JSON.stringify({
        success: true,
        data: { list: cached.list, has_more: false, total_count: cached.list.length },
      }));
      return;
    }

    if (!token) {
      s.statusCode = 401;
      s.end('{"success":false,"message":"no auth token"}');
      return;
    }

    const apiUrl = getApiUrl(qs);
    fetchAllPages(apiUrl, token)
      .then((list) => {
        cache.set(key, { ts: now, list });
        saveDiskCache(cacheFile, cache);
        s.setHeader('Cache-Control', `private, max-age=${Math.floor(ttl / 1000)}`);
        s.end(JSON.stringify({
          success: true,
          data: { list, has_more: false, total_count: list.length },
        }));
      })
      .catch((e) => {
        s.statusCode = 502;
        s.end(JSON.stringify({ success: false, message: String(e) }));
      });
  };
}

// ── Simple JSON file endpoint ────────────────────────────────────────────────

function makeJsonEndpoint(file: string, defaultValue = '[]'): Middleware {
  return (req, res, next) => {
    const r = req as IncomingMessage;
    const s = res as ServerResponse;
    s.setHeader('Content-Type', 'application/json');
    if (r.method === 'GET') {
      try {
        s.end(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : defaultValue);
      } catch {
        s.end(defaultValue);
      }
    } else if (r.method === 'POST') {
      let body = '';
      r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      r.on('end', () => {
        let incoming: unknown;
        try { incoming = JSON.parse(body); } catch {
          s.statusCode = 400; s.end('{"error":"invalid json"}'); return;
        }
        try {
          fs.writeFileSync(file, body, 'utf8');
          s.end('{"ok":true}');
        } catch (e) {
          s.statusCode = 500;
          s.end(JSON.stringify({ error: String(e) }));
        }
        void incoming;
      });
    } else {
      (next as () => void)();
    }
  };
}

// ── Orders endpoint (with extended REST API) ─────────────────────────────────

function makeOrdersEndpoint(): Middleware {
  return (req, res, next) => {
    const r = req as IncomingMessage;
    const s = res as ServerResponse;
    s.setHeader('Content-Type', 'application/json');

    const url = new URL(r.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    const ok = (data: unknown, status = 200): void => {
      s.statusCode = status;
      s.end(JSON.stringify({ ok: true, data }));
    };
    const err = (msg: string, status = 400): void => {
      s.statusCode = status;
      s.end(JSON.stringify({ ok: false, error: msg }));
    };

    // ── GET /desk-api/orders ─────────────────────────────────────────────────
    if (r.method === 'GET') {
      const id = url.searchParams.get('id');
      if (id) {
        const row = _db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row ? ok(rowToOrder(row)) : err('Заказ не найден', 404);
      }
      let sql = 'SELECT * FROM orders WHERE 1=1';
      const args: unknown[] = [];
      const phone    = url.searchParams.get('phone');
      const status   = url.searchParams.get('status');
      const operator = url.searchParams.get('operator');
      const storeId  = url.searchParams.get('store_id');
      const dateFrom = url.searchParams.get('date_from');
      const dateTo   = url.searchParams.get('date_to');
      if (phone)    { sql += ' AND client_phone = ?'; args.push(normPhone(phone)); }
      if (status)   { sql += ' AND status = ?';       args.push(status); }
      if (operator) { sql += ' AND operator = ?';     args.push(operator); }
      if (storeId)  { sql += ' AND store_id = ?';     args.push(storeId); }
      if (dateFrom) { sql += ' AND created_at >= ?';  args.push(dateFrom); }
      if (dateTo)   { sql += ' AND created_at <= ?';  args.push(dateTo + 'T23:59:59.999Z'); }
      sql += ' ORDER BY created_at DESC';
      const rows  = (_db.prepare(sql).all(...args) as Record<string, unknown>[]);
      const total = rows.length;
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const lp     = url.searchParams.get('limit');
      const limit  = lp ? parseInt(lp, 10) : total;
      const data   = rows.slice(offset, offset + limit).map(rowToOrder);
      s.end(JSON.stringify({ ok: true, data, total, offset, limit: data.length }));
      return;
    }

    // ── POST /desk-api/orders/create ─────────────────────────────────────────
    if (r.method === 'POST' && pathname === '/create') {
      let body = '';
      r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      r.on('end', () => {
        let input: Record<string, unknown>;
        try { input = JSON.parse(body); } catch { err('Невалидный JSON'); return; }
        const client = input['client'] as Record<string, unknown> | undefined;
        if (!client?.['phone']) { err('client.phone обязателен'); return; }
        const items = input['items'] as unknown[];
        if (!Array.isArray(items) || !items.length) { err('items обязателен'); return; }
        const id = Date.now().toString();
        const createdAt = new Date().toISOString();
        const row = orderToRow({ ...input, operator: input['operator'] ?? 'API' }, id, createdAt);
        try {
          _db.transaction(() => {
            _db.prepare(`INSERT INTO orders (
              id,created_at,status,store_id,order_method,pay_method,operator,total,seq_num,
              order_number,delivery_price,order_amount,given,change_amt,deleted_at,
              client_phone,client_name,client_street,client_house,client_entrance,
              client_floor,client_apartment,client_intercom,client_notes
            ) VALUES (
              @id,@created_at,@status,@store_id,@order_method,@pay_method,@operator,@total,@seq_num,
              @order_number,@delivery_price,@order_amount,@given,@change_amt,@deleted_at,
              @client_phone,@client_name,@client_street,@client_house,@client_entrance,
              @client_floor,@client_apartment,@client_intercom,@client_notes
            )`).run(row);
            insertItemsForOrder(id, items);
          })();
          ok(rowToOrder(_db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown>), 201);
        } catch (e) { err(String(e), 500); }
      });
      return;
    }

    // ── POST /desk-api/orders — browser sync ─────────────────────────────────
    if (r.method === 'POST') {
      let body = '';
      r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      r.on('end', () => {
        let incoming: unknown[];
        try { incoming = JSON.parse(body); } catch { s.statusCode = 400; s.end('{"error":"invalid json"}'); return; }
        try { _syncOrders(incoming); s.end('{"ok":true}'); }
        catch (e) { s.statusCode = 500; s.end(JSON.stringify({ error: String(e) })); }
      });
      return;
    }

    // ── PATCH /desk-api/orders?id=... ────────────────────────────────────────
    if (r.method === 'PATCH') {
      const id = url.searchParams.get('id');
      if (!id) { err('Укажите ?id=...'); return; }
      let body = '';
      r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      r.on('end', () => {
        let patch: Record<string, unknown>;
        try { patch = JSON.parse(body); } catch { err('Невалидный JSON'); return; }
        const row = _db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        if (!row) { err('Заказ не найден', 404); return; }
        try {
          const camel: Record<string, string> = { storeId:'store_id', orderMethod:'order_method',
            payMethod:'pay_method', seqNum:'seq_num', orderNumber:'order_number',
            deliveryPrice:'delivery_price', orderAmount:'order_amount', change:'change_amt', deletedAt:'deleted_at' };
          const allowed = ['status','store_id','order_method','pay_method','operator','total','seq_num',
            'order_number','delivery_price','order_amount','given','change_amt','deleted_at'];
          const setClauses: string[] = [];
          const params: Record<string, unknown> = { id };
          if (patch['client']) {
            const c = patch['client'] as Record<string, unknown>;
            Object.assign(params, { client_phone:normPhone(String(c['phone']??'')), client_name:c['name']??'',
              client_street:c['street']??'', client_house:c['house']??'', client_entrance:c['entrance']??'',
              client_floor:c['floor']??'', client_apartment:c['apartment']??'',
              client_intercom:c['intercom']??'', client_notes:c['notes']??'' });
            setClauses.push('client_phone=@client_phone','client_name=@client_name','client_street=@client_street',
              'client_house=@client_house','client_entrance=@client_entrance','client_floor=@client_floor',
              'client_apartment=@client_apartment','client_intercom=@client_intercom','client_notes=@client_notes');
          }
          if (patch['items'] != null) {
            _db.transaction(() => {
              _stmtDeleteItems.run(id);
              insertItemsForOrder(id, patch['items'] as unknown[]);
            })();
          }
          for (const [key, val] of Object.entries(patch)) {
            if (['id','createdAt','client','items'].includes(key)) continue;
            const col = camel[key] ?? key;
            if (!allowed.includes(col)) continue;
            setClauses.push(`${col}=@${col}`); params[col] = val;
          }
          if (setClauses.length) _db.prepare(`UPDATE orders SET ${setClauses.join(',')} WHERE id=@id`).run(params);
          ok(rowToOrder(_db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown>));
        } catch (e) { err(String(e), 500); }
      });
      return;
    }

    // ── DELETE /desk-api/orders?id=... ───────────────────────────────────────
    if (r.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) { err('Укажите ?id=...'); return; }
      const row = _db.prepare('SELECT id FROM orders WHERE id = ?').get(id);
      if (!row) { err('Заказ не найден', 404); return; }
      _db.prepare('DELETE FROM orders WHERE id = ?').run(id);
      ok({ deleted: 1 });
      return;
    }

    (next as () => void)();
  };
}

// ── Clients endpoint ─────────────────────────────────────────────────────────

function makeClientsEndpoint(): Middleware {
  return (req, res, next) => {
    const r = req as IncomingMessage;
    const s = res as ServerResponse;
    s.setHeader('Content-Type', 'application/json');
    const url = new URL(r.url ?? '/', 'http://localhost');
    const ok = (data: unknown, status = 200) => { s.statusCode = status; s.end(JSON.stringify({ ok: true, data })); };
    const err = (msg: string, status = 400) => { s.statusCode = status; s.end(JSON.stringify({ ok: false, error: msg })); };

    if (r.method === 'GET') {
      const phone  = url.searchParams.get('phone')  ?? '';
      const search = url.searchParams.get('search') ?? '';
      const exact  = url.searchParams.get('exact') !== 'false';
      if (phone) {
        const d = normPhone(phone);
        if (exact) {
          const row = _db.prepare('SELECT * FROM clients WHERE phone = ?').get(d) as Record<string, unknown> | undefined;
          return row ? ok(rowToClient(row)) : err('Клиент не найден', 404);
        }
        if (d.length < 3) return ok([]);
        return ok((_db.prepare("SELECT * FROM clients WHERE phone LIKE ? LIMIT 20").all(`%${d}%`) as Record<string, unknown>[]).map(rowToClient));
      }
      if (search) {
        const q = `%${search.toLowerCase()}%`;
        return ok((_db.prepare("SELECT * FROM clients WHERE LOWER(name) LIKE ? OR phone LIKE ? LIMIT 20")
          .all(q, `%${normPhone(search)}%`) as Record<string, unknown>[]).map(rowToClient));
      }
      const total  = (_db.prepare('SELECT COUNT(*) as n FROM clients').get() as { n: number }).n;
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const lp     = url.searchParams.get('limit');
      const limit  = lp ? parseInt(lp, 10) : total;
      return ok({ data: (_db.prepare('SELECT * FROM clients ORDER BY name LIMIT ? OFFSET ?').all(limit, offset) as Record<string, unknown>[]).map(rowToClient), total, offset, limit });
    }

    if (r.method === 'POST') {
      let body = '';
      r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      r.on('end', () => {
        let input: Record<string, unknown>;
        try { input = JSON.parse(body); } catch { err('Невалидный JSON'); return; }
        const d = normPhone(String(input['phone'] ?? ''));
        if (d.length < 7) { err('Некорректный номер телефона (минимум 7 цифр)'); return; }
        const addresses_json = Array.isArray(input['addresses']) && (input['addresses'] as unknown[]).length
          ? JSON.stringify(input['addresses']) : null;
        const phones_json = Array.isArray(input['phones']) && (input['phones'] as unknown[]).length
          ? JSON.stringify(input['phones']) : null;
        const entry = { phone:d, name:input['name']??'', street:input['street']??'', house:input['house']??'',
          entrance:input['entrance']??'', floor:input['floor']??'', apartment:input['apartment']??'',
          intercom:input['intercom']??'', notes:input['notes']??'', addresses_json, phones_json };
        const exists = _db.prepare('SELECT phone FROM clients WHERE phone = ?').get(d);
        if (exists) {
          _db.prepare(`UPDATE clients SET name=@name,street=@street,house=@house,entrance=@entrance,
            floor=@floor,apartment=@apartment,intercom=@intercom,notes=@notes,
            addresses_json=@addresses_json,phones_json=@phones_json WHERE phone=@phone`).run(entry);
          return ok(rowToClient(_db.prepare('SELECT * FROM clients WHERE phone = ?').get(d) as Record<string, unknown>));
        }
        _db.prepare(`INSERT INTO clients (phone,name,street,house,entrance,floor,apartment,intercom,notes,addresses_json,phones_json)
          VALUES (@phone,@name,@street,@house,@entrance,@floor,@apartment,@intercom,@notes,@addresses_json,@phones_json)`).run(entry);
        return ok(rowToClient(_db.prepare('SELECT * FROM clients WHERE phone = ?').get(d) as Record<string, unknown>), 201);
      });
      return;
    }

    if (r.method === 'DELETE') {
      const phone = url.searchParams.get('phone') ?? '';
      if (!phone) { err('Укажите ?phone=...'); return; }
      const result = _db.prepare('DELETE FROM clients WHERE phone = ?').run(normPhone(phone));
      ok({ deleted: result.changes });
      return;
    }

    (next as () => void)();
  };
}

// ── REST v1 endpoint (/desk-api/v1/*) ────────────────────────────────────────
// Vite strips the prefix, so req.url inside handler is already relative:
//   /desk-api/v1/clients/89001234567  →  pathname = /clients/89001234567

function makeV1Endpoint(): Middleware {
  return (req, res, next) => {
    const r   = req as IncomingMessage;
    const s   = res as ServerResponse;
    const mtd = r.method ?? 'GET';
    s.setHeader('Content-Type', 'application/json');
    const url  = new URL(r.url ?? '/', 'http://localhost');
    const path = url.pathname;

    const ok  = (data: unknown, status = 200): void => { s.statusCode = status; s.end(JSON.stringify({ ok: true, data })); };
    const err = (msg: string, status = 400): void   => { s.statusCode = status; s.end(JSON.stringify({ ok: false, error: msg })); };
    const body = (): Promise<Record<string, unknown>> => new Promise((res, rej) => {
      let b = '';
      r.on('data', (c: Buffer) => { b += c.toString(); });
      r.on('end', () => { try { res(JSON.parse(b)); } catch { rej(new Error('Невалидный JSON')); } });
    });

    if (mtd === 'OPTIONS') { s.statusCode = 204; s.end(); return; }

    if (mtd === 'GET' && path === '/') {
      s.end(JSON.stringify({ ok: true, version: 'v1', endpoints: [
        'GET    /desk-api/v1/orders', 'GET    /desk-api/v1/orders/:id',
        'POST   /desk-api/v1/orders', 'PATCH  /desk-api/v1/orders/:id', 'DELETE /desk-api/v1/orders/:id',
        'GET    /desk-api/v1/clients', 'GET    /desk-api/v1/clients/:phone',
        'POST   /desk-api/v1/clients', 'PATCH  /desk-api/v1/clients/:phone', 'DELETE /desk-api/v1/clients/:phone',
        'GET    /desk-api/v1/local-products', 'POST   /desk-api/v1/local-products',
        'PATCH  /desk-api/v1/local-products/:id', 'DELETE /desk-api/v1/local-products/:id',
      ]}));
      return;
    }

    const orderId  = path.match(/^\/orders\/([^/]+)$/)?.[1];
    const clientId = path.match(/^\/clients\/([^/]+)$/)?.[1];
    const localId  = path.match(/^\/local-products\/([^/]+)$/)?.[1];

    // ── Orders ────────────────────────────────────────────────────────────────

    if (mtd === 'GET' && orderId) {
      const row = _db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined;
      return row ? ok(rowToOrder(row)) : err('Заказ не найден', 404);
    }

    if (mtd === 'GET' && path === '/orders') {
      let sql = 'SELECT * FROM orders WHERE 1=1';
      const args: unknown[] = [];
      const phone = url.searchParams.get('phone'), status = url.searchParams.get('status'),
            operator = url.searchParams.get('operator'), storeId = url.searchParams.get('store_id'),
            dateFrom = url.searchParams.get('date_from'), dateTo = url.searchParams.get('date_to');
      if (phone)    { sql += ' AND client_phone = ?'; args.push(normPhone(phone)); }
      if (status)   { sql += ' AND status = ?';       args.push(status); }
      if (operator) { sql += ' AND operator = ?';     args.push(operator); }
      if (storeId)  { sql += ' AND store_id = ?';     args.push(storeId); }
      if (dateFrom) { sql += ' AND created_at >= ?';  args.push(dateFrom); }
      if (dateTo)   { sql += ' AND created_at <= ?';  args.push(dateTo + 'T23:59:59.999Z'); }
      sql += ' ORDER BY created_at DESC';
      const rows = _db.prepare(sql).all(...args) as Record<string, unknown>[];
      const total = rows.length;
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const lim = url.searchParams.get('limit');
      const limit = lim ? parseInt(lim, 10) : total;
      return ok({ data: rows.slice(offset, offset + limit).map(rowToOrder), total, offset, limit });
    }

    if (mtd === 'POST' && path === '/orders') {
      void body().then(b => {
        const client = b['client'] as Record<string, unknown> | undefined;
        if (!client?.['phone']) { err('client.phone обязателен'); return; }
        const items = b['items'] as unknown[];
        if (!Array.isArray(items) || !items.length) { err('items обязателен'); return; }
        const id = Date.now().toString();
        const row = orderToRow({ ...b, operator: b['operator'] ?? 'API' }, id, new Date().toISOString());
        try {
          _db.transaction(() => {
            _db.prepare(`INSERT INTO orders (id,created_at,status,store_id,order_method,pay_method,operator,total,seq_num,order_number,delivery_price,order_amount,given,change_amt,deleted_at,client_phone,client_name,client_street,client_house,client_entrance,client_floor,client_apartment,client_intercom,client_notes) VALUES (@id,@created_at,@status,@store_id,@order_method,@pay_method,@operator,@total,@seq_num,@order_number,@delivery_price,@order_amount,@given,@change_amt,@deleted_at,@client_phone,@client_name,@client_street,@client_house,@client_entrance,@client_floor,@client_apartment,@client_intercom,@client_notes)`).run(row);
            insertItemsForOrder(id, items);
          })();
          ok(rowToOrder(_db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown>), 201);
        } catch (e) { err(String(e), 500); }
      }).catch(e => err(String(e)));
      return;
    }

    if (mtd === 'PATCH' && orderId) {
      void body().then(patch => {
        const row = _db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined;
        if (!row) { err('Заказ не найден', 404); return; }
        try {
          const camel: Record<string, string> = { storeId:'store_id', orderMethod:'order_method', payMethod:'pay_method',
            seqNum:'seq_num', orderNumber:'order_number', deliveryPrice:'delivery_price', orderAmount:'order_amount',
            change:'change_amt', deletedAt:'deleted_at' };
          const allowed = ['status','store_id','order_method','pay_method','operator','total','seq_num',
            'order_number','delivery_price','order_amount','given','change_amt','deleted_at'];
          const setClauses: string[] = [];
          const params: Record<string, unknown> = { id: orderId };
          if (patch['client']) {
            const c = patch['client'] as Record<string, unknown>;
            Object.assign(params, { client_phone:normPhone(String(c['phone']??'')), client_name:c['name']??'',
              client_street:c['street']??'', client_house:c['house']??'', client_entrance:c['entrance']??'',
              client_floor:c['floor']??'', client_apartment:c['apartment']??'',
              client_intercom:c['intercom']??'', client_notes:c['notes']??'' });
            setClauses.push('client_phone=@client_phone','client_name=@client_name','client_street=@client_street',
              'client_house=@client_house','client_entrance=@client_entrance','client_floor=@client_floor',
              'client_apartment=@client_apartment','client_intercom=@client_intercom','client_notes=@client_notes');
          }
          if (patch['items'] != null) _db.transaction(() => { _stmtDeleteItems.run(orderId); insertItemsForOrder(orderId, patch['items'] as unknown[]); })();
          for (const [key, val] of Object.entries(patch)) {
            if (['id','createdAt','client','items'].includes(key)) continue;
            const col = camel[key] ?? key;
            if (!allowed.includes(col)) continue;
            setClauses.push(`${col}=@${col}`); params[col] = val;
          }
          if (setClauses.length) _db.prepare(`UPDATE orders SET ${setClauses.join(',')} WHERE id=@id`).run(params);
          ok(rowToOrder(_db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>));
        } catch (e) { err(String(e), 500); }
      }).catch(e => err(String(e)));
      return;
    }

    if (mtd === 'DELETE' && orderId) {
      if (!_db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId)) { err('Заказ не найден', 404); return; }
      _db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
      return ok({ deleted: 1 });
    }

    // ── Clients ────────────────────────────────────────────────────────────────

    if (mtd === 'GET' && clientId) {
      const d = normPhone(decodeURIComponent(clientId));
      const row = _db.prepare('SELECT * FROM clients WHERE phone = ?').get(d) as Record<string, unknown> | undefined;
      return row ? ok(rowToClient(row)) : err('Клиент не найден', 404);
    }

    if (mtd === 'GET' && path === '/clients') {
      const phone = url.searchParams.get('phone') ?? '', search = url.searchParams.get('search') ?? '';
      if (phone) {
        const d = normPhone(phone);
        if (d.length < 3) return ok([]);
        return ok((_db.prepare("SELECT * FROM clients WHERE phone LIKE ? LIMIT 20").all(`%${d}%`) as Record<string, unknown>[]).map(rowToClient));
      }
      if (search) {
        const q = `%${search.toLowerCase()}%`;
        return ok((_db.prepare("SELECT * FROM clients WHERE LOWER(name) LIKE ? OR phone LIKE ? LIMIT 20")
          .all(q, `%${normPhone(search)}%`) as Record<string, unknown>[]).map(rowToClient));
      }
      const total  = (_db.prepare('SELECT COUNT(*) as n FROM clients').get() as { n: number }).n;
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const lim    = url.searchParams.get('limit');
      const limit  = lim ? parseInt(lim, 10) : total;
      return ok({ data: (_db.prepare('SELECT * FROM clients ORDER BY name LIMIT ? OFFSET ?').all(limit, offset) as Record<string, unknown>[]).map(rowToClient), total, offset, limit });
    }

    if (mtd === 'POST' && path === '/clients') {
      void body().then(input => {
        const d = normPhone(String(input['phone'] ?? ''));
        if (d.length < 7) { err('Некорректный номер телефона'); return; }
        const entry = { phone:d, name:input['name']??'', street:input['street']??'', house:input['house']??'',
          entrance:input['entrance']??'', floor:input['floor']??'', apartment:input['apartment']??'',
          intercom:input['intercom']??'', notes:input['notes']??'' };
        const exists = _db.prepare('SELECT phone FROM clients WHERE phone = ?').get(d);
        if (exists) {
          _db.prepare(`UPDATE clients SET name=@name,street=@street,house=@house,entrance=@entrance,floor=@floor,apartment=@apartment,intercom=@intercom,notes=@notes WHERE phone=@phone`).run(entry);
          ok(rowToClient(_db.prepare('SELECT * FROM clients WHERE phone = ?').get(d) as Record<string, unknown>));
        } else {
          _db.prepare(`INSERT INTO clients (phone,name,street,house,entrance,floor,apartment,intercom,notes) VALUES (@phone,@name,@street,@house,@entrance,@floor,@apartment,@intercom,@notes)`).run(entry);
          ok(rowToClient(_db.prepare('SELECT * FROM clients WHERE phone = ?').get(d) as Record<string, unknown>), 201);
        }
      }).catch(e => err(String(e)));
      return;
    }

    if (mtd === 'PATCH' && clientId) {
      void body().then(b => {
        const d = normPhone(decodeURIComponent(clientId));
        const row = _db.prepare('SELECT * FROM clients WHERE phone = ?').get(d) as Record<string, unknown> | undefined;
        if (!row) { err('Клиент не найден', 404); return; }
        const fields = ['name','street','house','entrance','floor','apartment','intercom','notes'];
        const setClauses: string[] = [];
        const params: Record<string, unknown> = { phone: d };
        for (const f of fields) { if (b[f] != null) { setClauses.push(`${f}=@${f}`); params[f] = b[f]; } }
        if (setClauses.length) _db.prepare(`UPDATE clients SET ${setClauses.join(',')} WHERE phone=@phone`).run(params);
        ok(rowToClient(_db.prepare('SELECT * FROM clients WHERE phone = ?').get(d) as Record<string, unknown>));
      }).catch(e => err(String(e)));
      return;
    }

    if (mtd === 'DELETE' && clientId) {
      const d = normPhone(decodeURIComponent(clientId));
      return ok({ deleted: _db.prepare('DELETE FROM clients WHERE phone = ?').run(d).changes });
    }

    // ── Local Products ─────────────────────────────────────────────────────────

    if (mtd === 'GET' && path === '/local-products') {
      return ok((_db.prepare('SELECT * FROM local_products ORDER BY sort_order').all() as Record<string, unknown>[])
        .map(x => ({ id:x['id'], name:x['name'], price:x['price'], productType:x['product_type'] })));
    }

    if (mtd === 'POST' && path === '/local-products') {
      void body().then(b => {
        if (!b['name']) { err('name обязателен'); return; }
        const maxSort = ((_db.prepare('SELECT MAX(sort_order) as m FROM local_products').get() as { m: number | null }).m ?? -1);
        const item = { id:`local_${Date.now()}`, name:String(b['name']).trim(),
          price:Math.max(0, parseFloat(String(b['price'] ?? 0)) || 0),
          product_type:String(b['productType'] ?? 'PIECE'), sort_order:maxSort + 1 };
        _db.prepare('INSERT INTO local_products (id,name,price,product_type,sort_order) VALUES (@id,@name,@price,@product_type,@sort_order)').run(item);
        ok({ id:item.id, name:item.name, price:item.price, productType:item.product_type }, 201);
      }).catch(e => err(String(e)));
      return;
    }

    if (mtd === 'PATCH' && localId) {
      void body().then(b => {
        const row = _db.prepare('SELECT * FROM local_products WHERE id = ?').get(localId) as Record<string, unknown> | undefined;
        if (!row) { err('Товар не найден', 404); return; }
        if (b['name']        != null) _db.prepare('UPDATE local_products SET name=? WHERE id=?').run(String(b['name']).trim(), localId);
        if (b['price']       != null) _db.prepare('UPDATE local_products SET price=? WHERE id=?').run(Math.max(0, parseFloat(String(b['price'])) || 0), localId);
        if (b['productType'] != null) _db.prepare('UPDATE local_products SET product_type=? WHERE id=?').run(String(b['productType']), localId);
        const u = _db.prepare('SELECT * FROM local_products WHERE id = ?').get(localId) as Record<string, unknown>;
        ok({ id:u['id'], name:u['name'], price:u['price'], productType:u['product_type'] });
      }).catch(e => err(String(e)));
      return;
    }

    if (mtd === 'DELETE' && localId) {
      const result = _db.prepare('DELETE FROM local_products WHERE id = ?').run(localId);
      if (!result.changes) { err('Товар не найден', 404); return; }
      return ok({ deleted: 1 });
    }

    (next as () => void)();
  };
}

// ── Attach all middlewares ───────────────────────────────────────────────────

function attachMiddlewares(middlewares: { use: (p: string, h: Middleware) => void }): void {

  // ── Auth session endpoint (always open) ────────────────────────────────────
  middlewares.use('/desk-api/auth/session', ((req, res, _next) => {
    const r = req as IncomingMessage;
    const s = res as ServerResponse;
    s.setHeader('Content-Type', 'application/json');

    if (r.method === 'GET') {
      const sid  = _getSid(r);
      const sess = sid ? _sessions.get(sid) : null;
      if (!sess || Date.now() > sess.expires) { s.statusCode = 401; s.end('{"ok":false}'); return; }
      s.end(JSON.stringify({ ok: true, phone: sess.phone }));
      return;
    }

    if (r.method === 'DELETE') {
      const sid = _getSid(r);
      if (sid) _sessions.delete(sid);
      s.setHeader('Set-Cookie', 'desk_sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict');
      s.end('{"ok":true}');
      return;
    }

    if (r.method !== 'POST') { s.statusCode = 405; s.end('{"ok":false}'); return; }

    let body = '';
    r.on('data', (c: Buffer) => { body += c.toString(); });
    r.on('end', () => {
      let input: Record<string, unknown>;
      try { input = JSON.parse(body); } catch { s.statusCode = 400; s.end('{"ok":false}'); return; }

      const phone     = String(input['phone']         ?? '');
      const adminPass = String(input['adminPassword'] ?? '');
      const authToken = String(input['authToken']     ?? '');

      if (adminPass === _ADMIN_PASS) {
        const sid = _makeSession('admin');
        s.setHeader('Set-Cookie', _sidCookie(sid));
        s.end('{"ok":true}');
        return;
      }

      if (phone) {
        const norm = _normWL(phone);
        if (_readWhitelist().has(norm)) {
          const sid = _makeSession(norm);
          s.setHeader('Set-Cookie', _sidCookie(sid));
          s.end('{"ok":true}');
          return;
        }
        s.statusCode = 403;
        s.end('{"ok":false,"error":"Не авторизован"}');
        return;
      }

      if (authToken) {
        fetch('https://api.0-5.ru/api/v1/catalog/categories?per_page=1', {
          headers: { 'X-Auth-Token': authToken, 'X-App': '2po2', Accept: 'application/json' },
        })
          .then(resp => {
            if (resp.status !== 401 && resp.status !== 403) {
              const sid = _makeSession('authtoken');
              s.setHeader('Set-Cookie', _sidCookie(sid));
              s.end('{"ok":true}');
            } else {
              s.statusCode = 403;
              s.end('{"ok":false,"error":"Не авторизован"}');
            }
          })
          .catch(() => { s.statusCode = 403; s.end('{"ok":false}'); });
        return;
      }

      s.statusCode = 403;
      s.end('{"ok":false,"error":"Не авторизован"}');
    });
  }) as Middleware);

  middlewares.use('/desk-api/v1', requireAuth(makeV1Endpoint()));

  // ── Whitelist (GET open for auth flow, POST requires session) ──────────────
  const _whitelistMw = makeJsonEndpoint(WHITELIST_FILE);
  middlewares.use('/desk-api/whitelist', ((req, res, next) => {
    if ((req as IncomingMessage).method === 'GET') return _whitelistMw(req, res, next);
    return requireAuth(_whitelistMw)(req, res, next);
  }) as Middleware);

  middlewares.use('/desk-api/orders',   requireAuth(makeOrdersEndpoint()));
  middlewares.use('/desk-api/clients',  requireAuth(makeClientsEndpoint()));
  middlewares.use('/desk-api/local-products', requireAuth(((req, res, next) => {
    const r = req as IncomingMessage;
    const s = res as ServerResponse;
    s.setHeader('Content-Type', 'application/json');
    if (r.method === 'GET') {
      const list = (_db.prepare('SELECT * FROM local_products ORDER BY sort_order').all() as Record<string,unknown>[])
        .map(x => ({ id:x['id'], name:x['name'], price:x['price'], productType:x['product_type'] }));
      s.end(JSON.stringify(list));
      return;
    }
    if (r.method === 'POST') {
      let body = '';
      r.on('data', (c: Buffer) => { body += c.toString(); });
      r.on('end', () => {
        let b: unknown[];
        try { b = JSON.parse(body); } catch { s.statusCode = 400; s.end('{"error":"invalid json"}'); return; }
        if (!Array.isArray(b)) { s.statusCode = 400; s.end('{"error":"expected array"}'); return; }
        _db.transaction(() => {
          _db.prepare('DELETE FROM local_products').run();
          (b as Record<string,unknown>[]).forEach((x, i) => {
            _db.prepare('INSERT OR REPLACE INTO local_products (id,name,price,product_type,sort_order) VALUES (@id,@name,@price,@product_type,@sort_order)')
              .run({ id:x['id'], name:x['name'], price:x['price'], product_type:x['productType'], sort_order:i });
          });
        })();
        s.end('{"ok":true}');
      });
      return;
    }
    (next as () => void)();
  }) as Middleware));
  middlewares.use('/desk-api/countries',      makeJsonEndpoint(COUNTRIES_FILE));
  middlewares.use('/desk-api/operator-names', requireAuth(makeJsonEndpoint(OPERATOR_NAMES_FILE, '{}')));
  middlewares.use('/desk-api/warm-cache',     requireAuth(((req, res, next) => {
    const r = req as IncomingMessage;
    const s = res as ServerResponse;
    s.setHeader('Content-Type', 'application/json');
    if (r.method !== 'POST') { (next as () => void)(); return; }
    let body = '';
    r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    r.on('end', () => {
      try {
        const { token, storeIds } = JSON.parse(body) as { token?: string; storeIds?: unknown };
        if (!token || !Array.isArray(storeIds)) { s.statusCode = 400; s.end('{"ok":false}'); return; }
        void warmCatalogInBackground(token, storeIds as string[]);
        s.end('{"ok":true}');
      } catch { s.statusCode = 400; s.end('{"ok":false}'); }
    });
  }) as Middleware));

  middlewares.use('/desk-api/catalog', makeProxyHandler(
    (qs) => `https://api.0-5.ru/api/v1/catalog/products?store_id=${qs.get('store_id')}&category_id=${qs.get('category_id')}`,
    (qs) => `${qs.get('store_id')}_${qs.get('category_id')}`,
    catalogCache, CATALOG_CACHE_FILE, CATALOG_TTL,
  ));

  middlewares.use('/desk-api/vendor-catalog', makeProxyHandler(
    (qs) => `https://api.0-5.ru/api/v1/vendor/catalog/products?store_id=${qs.get('store_id')}`,
    (qs) => qs.get('store_id') ?? '',
    vendorCache, VENDOR_CACHE_FILE, VENDOR_TTL,
  ));
}

// ── Vite plugin & config ─────────────────────────────────────────────────────

const deskApi: Plugin = {
  name: 'desk-api',
  configureServer(server) { attachMiddlewares(server.middlewares); },
  configurePreviewServer(server) { attachMiddlewares(server.middlewares); },
};

const apiProxy = {
  '/api': {
    target: 'https://api.0-5.ru',
    changeOrigin: true,
    secure: true,
  },
  '/desk-api/mango': {
    target: 'http://127.0.0.1:3001',
    changeOrigin: false,
    rewrite: (p: string) => p.replace('/desk-api/mango', '/api/mango'),
  },
};

export default defineConfig({
  plugins: [deskApi],
  server: { host: true, proxy: apiProxy },
  preview: { host: true, proxy: apiProxy, allowedHosts: ['weltilt.pro', 'www.weltilt.pro'] },
});
