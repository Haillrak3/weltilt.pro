#!/usr/bin/env node
/**
 * Standalone desk-api server for production.
 *
 * Usage:   node api-server.mjs [port]
 * Default port: 3002
 *
 * Nginx config:
 *   location /desk-api/ {
 *       proxy_pass http://127.0.0.1:3002;
 *   }
 */

import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const p    = (...parts) => path.join(ROOT, ...parts);
const PORT = parseInt(process.env.DESK_API_PORT ?? process.argv[2] ?? '3002', 10);

const ORDERS_FILE         = p('desk-orders.json');
const LOCAL_PRODUCTS_FILE = p('desk-local-products.json');
const COUNTRIES_FILE      = p('desk-countries.json');
const WHITELIST_FILE      = p('desk-whitelist.json');
const OPERATOR_NAMES_FILE = p('desk-operator-names.json');
const EXTRA_CLIENTS_FILE  = p('desk-extra-clients.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

const respond = (res, data, status = 200) => {
  res.statusCode = status;
  res.end(JSON.stringify({ ok: true, data }));
};
const fail = (res, msg, status = 400) => {
  res.statusCode = status;
  res.end(JSON.stringify({ ok: false, error: msg }));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Невалидный JSON')); }
    });
    req.on('error', reject);
  });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function normPhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '7' ? '8' + d.slice(1) : d;
}

// ── Clients ──────────────────────────────────────────────────────────────────

function getAllClients() {
  const extra = readJson(EXTRA_CLIENTS_FILE, []);
  const db    = readJson(p('clients.json'), []);
  const seen  = new Set(extra.map(c => normPhone(c.phone)));
  return [...extra, ...db.filter(c => !seen.has(normPhone(c.phone)))];
}

function persistExtra(list) {
  writeJson(EXTRA_CLIENTS_FILE, list);
}

async function handleClients(req, res, url) {
  // GET
  if (req.method === 'GET') {
    const phone  = url.searchParams.get('phone')  ?? '';
    const search = url.searchParams.get('search') ?? '';
    const exact  = url.searchParams.get('exact') !== 'false';

    if (phone) {
      const d = normPhone(phone);
      if (exact) {
        const client = getAllClients().find(c => normPhone(c.phone) === d);
        return client ? respond(res, client) : fail(res, 'Клиент не найден', 404);
      }
      const results = d.length >= 3
        ? getAllClients().filter(c => normPhone(c.phone).includes(d)).slice(0, 20)
        : [];
      return respond(res, results);
    }

    if (search) {
      const q = search.toLowerCase();
      const results = getAllClients()
        .filter(c =>
          c.name.toLowerCase().includes(q) ||
          normPhone(c.phone).includes(normPhone(search)),
        )
        .slice(0, 20);
      return respond(res, results);
    }

    const all    = getAllClients();
    const total  = all.length;
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const lp     = url.searchParams.get('limit');
    const limit  = lp ? parseInt(lp, 10) : total;
    return respond(res, { data: all.slice(offset, offset + limit), total, offset, limit });
  }

  // POST — upsert
  if (req.method === 'POST') {
    let input;
    try { input = await readBody(req); } catch (e) { return fail(res, e.message); }
    const digits = String(input.phone ?? '').replace(/\D/g, '');
    if (digits.length < 7) return fail(res, 'Некорректный номер телефона (минимум 7 цифр)');

    const list  = readJson(EXTRA_CLIENTS_FILE, []);
    const d     = normPhone(input.phone);
    const idx   = list.findIndex(c => normPhone(c.phone) === d);
    const entry = {
      name: '', street: '', house: '', entrance: '',
      floor: '', apartment: '', intercom: '', notes: '',
      ...input,
    };

    if (idx >= 0) {
      list[idx] = { ...list[idx], ...entry };
      persistExtra(list);
      return respond(res, list[idx]);
    }
    list.push(entry);
    persistExtra(list);
    return respond(res, list[list.length - 1], 201);
  }

  // DELETE
  if (req.method === 'DELETE') {
    const phone = url.searchParams.get('phone') ?? '';
    if (!phone) return fail(res, 'Укажите ?phone=...');
    const list     = readJson(EXTRA_CLIENTS_FILE, []);
    const d        = normPhone(phone);
    const filtered = list.filter(c => normPhone(c.phone) !== d);
    persistExtra(filtered);
    return respond(res, { deleted: list.length - filtered.length });
  }

  fail(res, 'Method Not Allowed', 405);
}

// ── Orders ───────────────────────────────────────────────────────────────────

function readOrders()     { return readJson(ORDERS_FILE, []); }
function writeOrders(arr) {
  try { if (readOrders().length > 0) fs.copyFileSync(ORDERS_FILE, ORDERS_FILE + '.bak'); } catch {}
  writeJson(ORDERS_FILE, arr);
}

async function handleOrders(req, res, url, pathname) {
  // GET
  if (req.method === 'GET') {
    const orders = readOrders();
    const id = url.searchParams.get('id');
    if (id) {
      const o = orders.find(o => o.id === id);
      return o ? respond(res, o) : fail(res, 'Заказ не найден', 404);
    }

    let result = orders;
    const phone    = url.searchParams.get('phone');
    const status   = url.searchParams.get('status');
    const operator = url.searchParams.get('operator');
    const storeId  = url.searchParams.get('store_id');
    const dateFrom = url.searchParams.get('date_from');
    const dateTo   = url.searchParams.get('date_to');

    if (phone)    result = result.filter(o => normPhone(o.client?.phone ?? '') === normPhone(phone));
    if (status)   result = result.filter(o => o.status === status);
    if (operator) result = result.filter(o => o.operator === operator);
    if (storeId)  result = result.filter(o => o.storeId === storeId);
    if (dateFrom) result = result.filter(o => o.createdAt >= dateFrom);
    if (dateTo)   result = result.filter(o => o.createdAt <= dateTo);

    const total  = result.length;
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const lp     = url.searchParams.get('limit');
    const limit  = lp ? parseInt(lp, 10) : total;
    result = result.slice(offset, offset + limit);
    return res.end(JSON.stringify({ ok: true, data: result, total, offset, limit: result.length }));
  }

  // POST /desk-api/orders/create
  if (req.method === 'POST' && pathname.endsWith('/create')) {
    let input;
    try { input = await readBody(req); } catch (e) { return fail(res, e.message); }
    if (!input.client?.phone)                                      return fail(res, 'client.phone обязателен');
    if (!Array.isArray(input.items) || input.items.length === 0)   return fail(res, 'items обязателен (непустой массив)');

    const order = {
      id:          Date.now().toString(),
      createdAt:   new Date().toISOString(),
      status:      input.status      ?? 'created',
      storeId:     input.storeId     ?? '',
      orderMethod: input.orderMethod ?? 'phone',
      payMethod:   input.payMethod   ?? 'cash',
      operator:    input.operator    ?? 'API',
      items:       input.items,
      total:       input.total ?? input.items.reduce((s, i) => s + i.price * i.qty, 0),
      client: {
        phone:     input.client.phone,
        name:      input.client.name      ?? '',
        street:    input.client.street    ?? '',
        house:     input.client.house     ?? '',
        entrance:  input.client.entrance  ?? '',
        floor:     input.client.floor     ?? '',
        apartment: input.client.apartment ?? '',
        intercom:  input.client.intercom  ?? '',
        notes:     input.client.notes     ?? '',
      },
      ...(input.orderNumber   !== undefined ? { orderNumber:   input.orderNumber }   : {}),
      ...(input.deliveryPrice !== undefined ? { deliveryPrice: input.deliveryPrice } : {}),
      ...(input.orderAmount   !== undefined ? { orderAmount:   input.orderAmount }   : {}),
    };

    writeOrders([order, ...readOrders()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    return respond(res, order, 201);
  }

  // POST /desk-api/orders — internal browser sync
  if (req.method === 'POST') {
    let incoming;
    try { incoming = await readBody(req); } catch (e) { return fail(res, e.message); }
    const existing    = readOrders();
    const incomingIds = new Set(incoming.map(o => o.id));
    const merged      = [...incoming, ...existing.filter(o => !incomingIds.has(o.id))]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    writeOrders(merged);
    return res.end('{"ok":true}');
  }

  // PATCH
  if (req.method === 'PATCH') {
    const id = url.searchParams.get('id');
    if (!id) return fail(res, 'Укажите ?id=...');
    let patch;
    try { patch = await readBody(req); } catch (e) { return fail(res, e.message); }
    const orders = readOrders();
    const idx    = orders.findIndex(o => o.id === id);
    if (idx < 0) return fail(res, 'Заказ не найден', 404);
    orders[idx] = { ...orders[idx], ...patch, id: orders[idx].id };
    writeOrders(orders);
    return respond(res, orders[idx]);
  }

  // DELETE
  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return fail(res, 'Укажите ?id=...');
    const orders   = readOrders();
    const before   = orders.length;
    const filtered = orders.filter(o => o.id !== id);
    writeOrders(filtered);
    return respond(res, { deleted: before - filtered.length });
  }

  fail(res, 'Method Not Allowed', 405);
}

// ── Generic JSON-file endpoint ────────────────────────────────────────────────

async function handleJsonFile(req, res, file, fallback) {
  if (req.method === 'GET') {
    return res.end(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback);
  }
  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return fail(res, e.message); }
    writeJson(file, body);
    return res.end('{"ok":true}');
  }
  fail(res, 'Method Not Allowed', 405);
}

// ── Main server ───────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const url      = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/desk-api/clients'))        return await handleClients(req, res, url);
    if (pathname.startsWith('/desk-api/orders'))         return await handleOrders(req, res, url, pathname);
    if (pathname === '/desk-api/local-products')         return await handleJsonFile(req, res, LOCAL_PRODUCTS_FILE, '[]');
    if (pathname === '/desk-api/countries')              return await handleJsonFile(req, res, COUNTRIES_FILE, '[]');
    if (pathname === '/desk-api/whitelist')              return await handleJsonFile(req, res, WHITELIST_FILE, '[]');
    if (pathname === '/desk-api/operator-names')         return await handleJsonFile(req, res, OPERATOR_NAMES_FILE, '{}');
    fail(res, 'Not found', 404);
  } catch (e) {
    fail(res, String(e), 500);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[desk-api] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[desk-api] Data dir: ${ROOT}`);
});
