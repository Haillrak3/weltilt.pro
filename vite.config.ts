import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const p = (...parts: string[]) => path.join(ROOT, ...parts);

const ORDERS_FILE        = p('desk-orders.json');
const LOCAL_PRODUCTS_FILE = p('desk-local-products.json');
const COUNTRIES_FILE     = p('desk-countries.json');
const WHITELIST_FILE     = p('desk-whitelist.json');
const OPERATOR_NAMES_FILE = p('desk-operator-names.json');
const CATALOG_CACHE_FILE = p('desk-cache-catalog.json');
const VENDOR_CACHE_FILE  = p('desk-cache-vendor.json');

const CATALOG_TTL = 60 * 60 * 1000;      // 1 ч
const VENDOR_TTL  = 4 * 60 * 60 * 1000;  // 4 ч

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

function makeOrdersEndpoint(file: string): Middleware {
  return (req, res, next) => {
    const r = req as IncomingMessage;
    const s = res as ServerResponse;
    s.setHeader('Content-Type', 'application/json');
    if (r.method === 'GET') {
      try {
        s.end(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]');
      } catch { s.end('[]'); }
    } else if (r.method === 'POST') {
      let body = '';
      r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      r.on('end', () => {
        let incoming: Array<{ id: string; createdAt: string }>;
        try { incoming = JSON.parse(body); } catch {
          s.statusCode = 400; s.end('{"error":"invalid json"}'); return;
        }
        try {
          let existing: Array<{ id: string; createdAt: string }> = [];
          try { existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []; } catch {}
          const incomingIds = new Set(incoming.map((o) => o.id));
          const serverOnly = existing.filter((o) => !incomingIds.has(o.id));
          const merged = [...incoming, ...serverOnly]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          try { if (existing.length > 0) fs.copyFileSync(file, file + '.bak'); } catch {}
          fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
          s.end('{"ok":true}');
        } catch (e) {
          s.statusCode = 500;
          s.end(JSON.stringify({ error: String(e) }));
        }
      });
    } else {
      (next as () => void)();
    }
  };
}

function attachMiddlewares(middlewares: { use: (p: string, h: Middleware) => void }): void {
  middlewares.use('/desk-api/orders',          makeOrdersEndpoint(ORDERS_FILE));
  middlewares.use('/desk-api/local-products',  makeJsonEndpoint(LOCAL_PRODUCTS_FILE));
  middlewares.use('/desk-api/countries',       makeJsonEndpoint(COUNTRIES_FILE));
  middlewares.use('/desk-api/whitelist',       makeJsonEndpoint(WHITELIST_FILE));
  middlewares.use('/desk-api/operator-names',  makeJsonEndpoint(OPERATOR_NAMES_FILE, '{}'));

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
