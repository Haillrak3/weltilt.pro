import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const p = (...parts: string[]) => path.join(ROOT, ...parts);

const ORDERS_FILE         = p('desk-orders.json');
const LOCAL_PRODUCTS_FILE = p('desk-local-products.json');
const COUNTRIES_FILE      = p('desk-countries.json');
const WHITELIST_FILE      = p('desk-whitelist.json');
const OPERATOR_NAMES_FILE = p('desk-operator-names.json');
const CATALOG_CACHE_FILE  = p('desk-cache-catalog.json');
const VENDOR_CACHE_FILE   = p('desk-cache-vendor.json');
const EXTRA_CLIENTS_FILE  = p('desk-extra-clients.json');

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

// ── Client helpers ───────────────────────────────────────────────────────────

function normPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  return d.length === 11 && d[0] === '7' ? '8' + d.slice(1) : d;
}

function loadClientsDb(): DbClient[] {
  try {
    const file = p('clients.json');
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8')) as DbClient[];
  } catch { return []; }
}

function loadExtraClients(): DbClient[] {
  try {
    if (!fs.existsSync(EXTRA_CLIENTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(EXTRA_CLIENTS_FILE, 'utf8')) as DbClient[];
  } catch { return []; }
}

function persistExtraClients(list: DbClient[]): void {
  fs.writeFileSync(EXTRA_CLIENTS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function getAllClients(): DbClient[] {
  const extra = loadExtraClients();
  const db = loadClientsDb();
  const extraDigits = new Set(extra.map(c => normPhone(c.phone)));
  return [...extra, ...db.filter(c => !extraDigits.has(normPhone(c.phone)))];
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

function makeOrdersEndpoint(file: string): Middleware {
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
    const readOrders = (): SavedOrder[] => {
      try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []; }
      catch { return []; }
    };
    const writeOrders = (orders: SavedOrder[]): void => {
      fs.writeFileSync(file, JSON.stringify(orders, null, 2), 'utf8');
    };

    // ── GET /desk-api/orders ─────────────────────────────────────────────────
    if (r.method === 'GET') {
      const orders = readOrders();
      const id = url.searchParams.get('id');

      if (id) {
        const order = orders.find(o => o.id === id);
        if (order) ok(order); else err('Заказ не найден', 404);
        return;
      }

      let result = orders;
      const phone = url.searchParams.get('phone');
      const status = url.searchParams.get('status');
      const operator = url.searchParams.get('operator');
      const storeId = url.searchParams.get('store_id');
      const dateFrom = url.searchParams.get('date_from');
      const dateTo = url.searchParams.get('date_to');
      const limitParam = url.searchParams.get('limit');
      const offsetParam = url.searchParams.get('offset');

      if (phone) {
        const d = normPhone(phone);
        result = result.filter(o => normPhone(o.client?.phone ?? '') === d);
      }
      if (status) result = result.filter(o => o.status === status);
      if (operator) result = result.filter(o => o.operator === operator);
      if (storeId) result = result.filter(o => o.storeId === storeId);
      if (dateFrom) result = result.filter(o => o.createdAt >= dateFrom);
      if (dateTo) result = result.filter(o => o.createdAt <= dateTo);

      const total = result.length;
      const offset = offsetParam ? parseInt(offsetParam, 10) : 0;
      const limit = limitParam ? parseInt(limitParam, 10) : total;
      result = result.slice(offset, offset + limit);

      s.end(JSON.stringify({ ok: true, data: result, total, offset, limit: result.length }));
      return;
    }

    // ── POST /desk-api/orders/create — create single order ───────────────────
    if (r.method === 'POST' && pathname === '/create') {
      let body = '';
      r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      r.on('end', () => {
        let input: Partial<SavedOrder>;
        try { input = JSON.parse(body) as Partial<SavedOrder>; }
        catch { err('Невалидный JSON'); return; }

        if (!input.client?.phone) { err('client.phone обязателен'); return; }
        if (!Array.isArray(input.items) || input.items.length === 0) {
          err('items обязателен (непустой массив)'); return;
        }

        const calcTotal = input.items.reduce((sum, i) => sum + i.price * i.qty, 0);

        const order: SavedOrder = {
          id: Date.now().toString(),
          createdAt: new Date().toISOString(),
          status: input.status ?? 'created',
          storeId: input.storeId ?? '',
          client: {
            phone: input.client.phone,
            name: input.client.name ?? '',
            street: input.client.street ?? '',
            house: input.client.house ?? '',
            entrance: input.client.entrance ?? '',
            floor: input.client.floor ?? '',
            apartment: input.client.apartment ?? '',
            intercom: input.client.intercom ?? '',
            notes: input.client.notes ?? '',
          },
          orderMethod: input.orderMethod ?? 'phone',
          payMethod: input.payMethod ?? 'cash',
          operator: input.operator ?? 'API',
          items: input.items,
          total: input.total ?? calcTotal,
          ...(input.orderNumber !== undefined ? { orderNumber: input.orderNumber } : {}),
          ...(input.deliveryPrice !== undefined ? { deliveryPrice: input.deliveryPrice } : {}),
          ...(input.orderAmount !== undefined ? { orderAmount: input.orderAmount } : {}),
        };

        try {
          const orders = readOrders();
          try { if (orders.length > 0) fs.copyFileSync(file, file + '.bak'); } catch { /* ignore */ }
          writeOrders([order, ...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
          ok(order, 201);
        } catch (e) { err(String(e), 500); }
      });
      return;
    }

    // ── POST /desk-api/orders — sync (existing internal mechanism) ────────────
    if (r.method === 'POST') {
      let body = '';
      r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      r.on('end', () => {
        let incoming: SavedOrder[];
        try { incoming = JSON.parse(body) as SavedOrder[]; } catch {
          s.statusCode = 400; s.end('{"error":"invalid json"}'); return;
        }
        try {
          const existing = readOrders();
          const incomingIds = new Set(incoming.map(o => o.id));
          const serverOnly = existing.filter(o => !incomingIds.has(o.id));
          const merged = [...incoming, ...serverOnly]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          try { if (existing.length > 0) fs.copyFileSync(file, file + '.bak'); } catch { /* ignore */ }
          writeOrders(merged);
          s.end('{"ok":true}');
        } catch (e) {
          s.statusCode = 500;
          s.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }

    // ── PATCH /desk-api/orders?id=... — update order fields ──────────────────
    if (r.method === 'PATCH') {
      const id = url.searchParams.get('id');
      if (!id) { err('Укажите ?id=...'); return; }
      let body = '';
      r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      r.on('end', () => {
        let patch: Partial<SavedOrder>;
        try { patch = JSON.parse(body) as Partial<SavedOrder>; }
        catch { err('Невалидный JSON'); return; }
        try {
          const orders = readOrders();
          const idx = orders.findIndex(o => o.id === id);
          if (idx < 0) { err('Заказ не найден', 404); return; }
          orders[idx] = { ...orders[idx], ...patch, id: orders[idx].id };
          writeOrders(orders);
          ok(orders[idx]);
        } catch (e) { err(String(e), 500); }
      });
      return;
    }

    // ── DELETE /desk-api/orders?id=... — delete order ─────────────────────────
    if (r.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) { err('Укажите ?id=...'); return; }
      try {
        const orders = readOrders();
        const before = orders.length;
        const filtered = orders.filter(o => o.id !== id);
        writeOrders(filtered);
        ok({ deleted: before - filtered.length });
      } catch (e) { err(String(e), 500); }
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

    const ok = (data: unknown, status = 200): void => {
      s.statusCode = status;
      s.end(JSON.stringify({ ok: true, data }));
    };
    const err = (msg: string, status = 400): void => {
      s.statusCode = status;
      s.end(JSON.stringify({ ok: false, error: msg }));
    };

    // ── GET /desk-api/clients ─────────────────────────────────────────────────
    if (r.method === 'GET') {
      const phone = url.searchParams.get('phone') ?? '';
      const search = url.searchParams.get('search') ?? '';
      const exact = url.searchParams.get('exact') !== 'false';

      if (phone) {
        if (exact) {
          const d = normPhone(phone);
          const client = getAllClients().find(c => normPhone(c.phone) === d);
          if (client) ok(client); else err('Клиент не найден', 404);
        } else {
          const d = normPhone(phone);
          const results = d.length >= 3
            ? getAllClients().filter(c => normPhone(c.phone).includes(d)).slice(0, 20)
            : [];
          ok(results);
        }
        return;
      }

      if (search) {
        const q = search.toLowerCase();
        const results = getAllClients()
          .filter(c =>
            c.name.toLowerCase().includes(q) ||
            normPhone(c.phone).includes(normPhone(search)),
          )
          .slice(0, 20);
        ok(results);
        return;
      }

      const limitParam = url.searchParams.get('limit');
      const offsetParam = url.searchParams.get('offset');
      const all = getAllClients();
      const total = all.length;
      const offset = offsetParam ? parseInt(offsetParam, 10) : 0;
      const limit = limitParam ? parseInt(limitParam, 10) : total;
      ok({ data: all.slice(offset, offset + limit), total, offset, limit });
      return;
    }

    // ── POST /desk-api/clients — upsert client ────────────────────────────────
    if (r.method === 'POST') {
      let body = '';
      r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      r.on('end', () => {
        let input: Partial<DbClient>;
        try { input = JSON.parse(body) as Partial<DbClient>; }
        catch { err('Невалидный JSON'); return; }

        const digits = (input.phone ?? '').replace(/\D/g, '');
        if (digits.length < 7) { err('Некорректный номер телефона (минимум 7 цифр)'); return; }

        const list = loadExtraClients();
        const d = normPhone(input.phone!);
        const idx = list.findIndex(c => normPhone(c.phone) === d);

        const entry: DbClient = {
          name: '', street: '', house: '', entrance: '',
          floor: '', apartment: '', intercom: '', notes: '',
          ...input as DbClient,
        };

        if (idx >= 0) {
          list[idx] = { ...list[idx], ...entry };
          persistExtraClients(list);
          ok(list[idx]);
        } else {
          list.push(entry);
          persistExtraClients(list);
          ok(list[list.length - 1], 201);
        }
      });
      return;
    }

    // ── DELETE /desk-api/clients?phone=... — remove from extra clients ─────────
    if (r.method === 'DELETE') {
      const phone = url.searchParams.get('phone') ?? '';
      if (!phone) { err('Укажите ?phone=...'); return; }
      const list = loadExtraClients();
      const d = normPhone(phone);
      const before = list.length;
      const filtered = list.filter(c => normPhone(c.phone) !== d);
      persistExtraClients(filtered);
      ok({ deleted: before - filtered.length });
      return;
    }

    (next as () => void)();
  };
}

// ── Attach all middlewares ───────────────────────────────────────────────────

function attachMiddlewares(middlewares: { use: (p: string, h: Middleware) => void }): void {
  middlewares.use('/desk-api/orders',         makeOrdersEndpoint(ORDERS_FILE));
  middlewares.use('/desk-api/clients',        makeClientsEndpoint());
  middlewares.use('/desk-api/local-products', makeJsonEndpoint(LOCAL_PRODUCTS_FILE));
  middlewares.use('/desk-api/countries',      makeJsonEndpoint(COUNTRIES_FILE));
  middlewares.use('/desk-api/whitelist',      makeJsonEndpoint(WHITELIST_FILE));
  middlewares.use('/desk-api/operator-names', makeJsonEndpoint(OPERATOR_NAMES_FILE, '{}'));

  middlewares.use('/desk-api/warm-cache', (req, res, next) => {
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
  });

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
