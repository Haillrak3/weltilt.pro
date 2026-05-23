#!/usr/bin/env node
/**
 * Standalone desk-api server for production (SQLite backend).
 *
 * Usage:   node api-server.mjs [port]
 * Default port: 3002
 */

import http  from 'node:http';
import fs    from 'node:fs';
import path  from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const p    = (...parts) => path.join(ROOT, ...parts);
const PORT = parseInt(process.env.DESK_API_PORT ?? process.argv[2] ?? '3002', 10);

const COUNTRIES_FILE      = p('desk-countries.json');
const WHITELIST_FILE      = p('desk-whitelist.json');
const OPERATOR_NAMES_FILE = p('desk-operator-names.json');

// ── DB ────────────────────────────────────────────────────────────────────────

const db = new Database(p('desk.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id               TEXT PRIMARY KEY,
    created_at       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'created',
    store_id         TEXT NOT NULL DEFAULT '',
    order_method     TEXT NOT NULL DEFAULT 'phone',
    pay_method       TEXT NOT NULL DEFAULT 'cash',
    operator         TEXT NOT NULL DEFAULT '',
    total            REAL NOT NULL DEFAULT 0,
    seq_num          INTEGER,
    order_number     TEXT,
    delivery_price   REAL,
    order_amount     REAL,
    given            REAL,
    change_amt       REAL,
    deleted_at       TEXT,
    client_phone     TEXT NOT NULL DEFAULT '',
    client_name      TEXT NOT NULL DEFAULT '',
    client_street    TEXT NOT NULL DEFAULT '',
    client_house     TEXT NOT NULL DEFAULT '',
    client_entrance  TEXT NOT NULL DEFAULT '',
    client_floor     TEXT NOT NULL DEFAULT '',
    client_apartment TEXT NOT NULL DEFAULT '',
    client_intercom  TEXT NOT NULL DEFAULT '',
    client_notes     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created_at   ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_client_phone ON orders(client_phone);
  CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_store_id     ON orders(store_id);

  CREATE TABLE IF NOT EXISTS order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id      INTEGER,
    name         TEXT NOT NULL DEFAULT '',
    qty          REAL NOT NULL DEFAULT 1,
    price        REAL NOT NULL DEFAULT 0,
    product_type TEXT NOT NULL DEFAULT 'PIECE',
    details      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

  CREATE TABLE IF NOT EXISTS clients (
    phone     TEXT PRIMARY KEY,
    name      TEXT NOT NULL DEFAULT '',
    street    TEXT NOT NULL DEFAULT '',
    house     TEXT NOT NULL DEFAULT '',
    entrance  TEXT NOT NULL DEFAULT '',
    floor     TEXT NOT NULL DEFAULT '',
    apartment TEXT NOT NULL DEFAULT '',
    intercom  TEXT NOT NULL DEFAULT '',
    notes     TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS local_products (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    price        REAL NOT NULL DEFAULT 0,
    product_type TEXT NOT NULL DEFAULT 'PIECE',
    sort_order   INTEGER NOT NULL DEFAULT 0
  );
`);

// ── Migrations ───────────────────────────────────────────────────────────────
try { db.prepare("ALTER TABLE clients ADD COLUMN addresses_json TEXT NOT NULL DEFAULT '[]'").run(); } catch { /* already exists */ }

// ── Helpers ───────────────────────────────────────────────────────────────────

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
      try { resolve(raw ? JSON.parse(raw) : {}); }
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

// ── Order serialization ───────────────────────────────────────────────────────

const stmtItems = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');

function rowToOrder(row) {
  if (!row) return null;
  const items = stmtItems.all(row.id).map(item => ({
    ...(item.item_id != null ? { id: item.item_id } : {}),
    name:        item.name,
    qty:         item.qty,
    price:       item.price,
    productType: item.product_type,
    ...(item.details != null ? { details: item.details } : {}),
  }));

  const order = {
    id:          row.id,
    createdAt:   row.created_at,
    status:      row.status,
    storeId:     row.store_id,
    orderMethod: row.order_method,
    payMethod:   row.pay_method,
    operator:    row.operator,
    total:       row.total,
    items,
    client: {
      phone:     row.client_phone,
      name:      row.client_name,
      street:    row.client_street,
      house:     row.client_house,
      entrance:  row.client_entrance,
      floor:     row.client_floor,
      apartment: row.client_apartment,
      intercom:  row.client_intercom,
      notes:     row.client_notes,
    },
  };

  if (row.seq_num     != null) order.seqNum       = row.seq_num;
  if (row.order_number!= null) order.orderNumber  = row.order_number;
  if (row.delivery_price!=null)order.deliveryPrice = row.delivery_price;
  if (row.order_amount!= null) order.orderAmount  = row.order_amount;
  if (row.given       != null) order.given        = row.given;
  if (row.change_amt  != null) order.change       = row.change_amt;
  if (row.deleted_at  != null) order.deletedAt    = row.deleted_at;

  return order;
}

// ── Prepared statements: orders ───────────────────────────────────────────────

const stmtInsertOrder = db.prepare(`
  INSERT OR IGNORE INTO orders (
    id, created_at, status, store_id, order_method, pay_method, operator,
    total, seq_num, order_number, delivery_price, order_amount, given, change_amt,
    deleted_at,
    client_phone, client_name, client_street, client_house, client_entrance,
    client_floor, client_apartment, client_intercom, client_notes
  ) VALUES (
    @id, @created_at, @status, @store_id, @order_method, @pay_method, @operator,
    @total, @seq_num, @order_number, @delivery_price, @order_amount, @given, @change_amt,
    @deleted_at,
    @client_phone, @client_name, @client_street, @client_house, @client_entrance,
    @client_floor, @client_apartment, @client_intercom, @client_notes
  )
`);

const stmtInsertItem = db.prepare(`
  INSERT INTO order_items (order_id, item_id, name, qty, price, product_type, details)
  VALUES (@order_id, @item_id, @name, @qty, @price, @product_type, @details)
`);

const stmtDeleteItems = db.prepare('DELETE FROM order_items WHERE order_id = ?');

const stmtUpsertClient = db.prepare(`
  INSERT INTO clients (phone, name, street, house, entrance, floor, apartment, intercom, notes)
  VALUES (@phone, @name, @street, @house, @entrance, @floor, @apartment, @intercom, @notes)
  ON CONFLICT(phone) DO NOTHING
`);

function insertOrderWithItems(o) {
  const c     = o.client ?? {};
  const phone = normPhone(c.phone ?? '');

  stmtInsertOrder.run({
    id:              o.id,
    created_at:      o.createdAt,
    status:          o.status      ?? 'created',
    store_id:        o.storeId     ?? '',
    order_method:    o.orderMethod ?? 'phone',
    pay_method:      o.payMethod   ?? 'cash',
    operator:        o.operator    ?? '',
    total:           o.total       ?? 0,
    seq_num:         o.seqNum      ?? null,
    order_number:    o.orderNumber ?? null,
    delivery_price:  o.deliveryPrice ?? null,
    order_amount:    o.orderAmount ?? null,
    given:           o.given       ?? null,
    change_amt:      o.change      ?? null,
    deleted_at:      o.deletedAt   ?? null,
    client_phone:    phone,
    client_name:     c.name       ?? '',
    client_street:   c.street     ?? '',
    client_house:    c.house      ?? '',
    client_entrance: c.entrance   ?? '',
    client_floor:    c.floor      ?? '',
    client_apartment:c.apartment  ?? '',
    client_intercom: c.intercom   ?? '',
    client_notes:    c.notes      ?? '',
  });

  const alreadyHasItems = db.prepare('SELECT 1 FROM order_items WHERE order_id = ?').get(o.id);
  if (!alreadyHasItems) {
    for (const item of (o.items ?? [])) {
      stmtInsertItem.run({
        order_id:     o.id,
        item_id:      item.id    ?? null,
        name:         item.name  ?? '',
        qty:          item.qty   ?? 1,
        price:        item.price ?? 0,
        product_type: item.productType ?? 'PIECE',
        details:      item.details ?? null,
      });
    }
  }

  if (phone.length >= 7) {
    stmtUpsertClient.run({
      phone,
      name:      c.name      ?? '',
      street:    c.street    ?? '',
      house:     c.house     ?? '',
      entrance:  c.entrance  ?? '',
      floor:     c.floor     ?? '',
      apartment: c.apartment ?? '',
      intercom:  c.intercom  ?? '',
      notes:     c.notes     ?? '',
    });
  }
}

function buildOrderRow(b, id, createdAt) {
  const c = b.client ?? {};
  return {
    id,
    created_at:      createdAt,
    status:          b.status      ?? 'created',
    store_id:        b.storeId     ?? '',
    order_method:    b.orderMethod ?? 'phone',
    pay_method:      b.payMethod   ?? 'cash',
    operator:        b.operator    ?? 'API',
    total:           b.total ?? (b.items ?? []).reduce((s, i) => s + (i.price ?? 0) * (i.qty ?? 0), 0),
    seq_num:         b.seqNum      ?? null,
    order_number:    b.orderNumber ?? null,
    delivery_price:  b.deliveryPrice ?? null,
    order_amount:    b.orderAmount ?? null,
    given:           b.given       ?? null,
    change_amt:      b.change      ?? null,
    deleted_at:      b.deletedAt   ?? null,
    client_phone:    normPhone(c.phone ?? ''),
    client_name:     c.name       ?? '',
    client_street:   c.street     ?? '',
    client_house:    c.house      ?? '',
    client_entrance: c.entrance   ?? '',
    client_floor:    c.floor      ?? '',
    client_apartment:c.apartment  ?? '',
    client_intercom: c.intercom   ?? '',
    client_notes:    c.notes      ?? '',
  };
}

function rowToClient(row) {
  const c = {
    phone: row.phone, name: row.name, street: row.street, house: row.house,
    entrance: row.entrance, floor: row.floor, apartment: row.apartment,
    intercom: row.intercom, notes: row.notes,
  };
  if (row.addresses_json) try { c.addresses = JSON.parse(row.addresses_json); } catch { /* */ }
  if (row.phones_json)    try { c.phones    = JSON.parse(row.phones_json);    } catch { /* */ }
  return c;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleOrders(req, res, url, pathname) {
  const method = req.method;

  if (method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      return row ? respond(res, rowToOrder(row)) : fail(res, 'Заказ не найден', 404);
    }

    let sql  = 'SELECT * FROM orders WHERE 1=1';
    const params = [];

    const phone    = url.searchParams.get('phone');
    const status   = url.searchParams.get('status');
    const operator = url.searchParams.get('operator');
    const storeId  = url.searchParams.get('store_id');
    const dateFrom = url.searchParams.get('date_from');
    const dateTo   = url.searchParams.get('date_to');

    if (phone)    { sql += ' AND client_phone = ?';      params.push(normPhone(phone)); }
    if (status)   { sql += ' AND status = ?';            params.push(status); }
    if (operator) { sql += ' AND operator = ?';          params.push(operator); }
    if (storeId)  { sql += ' AND store_id = ?';          params.push(storeId); }
    if (dateFrom) { sql += ' AND created_at >= ?';       params.push(dateFrom); }
    if (dateTo)   { sql += ' AND created_at <= ?';       params.push(dateTo + 'T23:59:59.999Z'); }

    sql += ' ORDER BY created_at DESC';

    const rows   = db.prepare(sql).all(...params);
    const total  = rows.length;
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const lp     = url.searchParams.get('limit');
    const limit  = lp ? parseInt(lp, 10) : total;
    const data   = rows.slice(offset, offset + limit).map(rowToOrder);
    return res.end(JSON.stringify({ ok: true, data, total, offset, limit: data.length }));
  }

  // POST /desk-api/orders/create — create single order via API
  if (method === 'POST' && pathname.endsWith('/create')) {
    let b; try { b = await readBody(req); } catch (e) { return fail(res, e.message); }
    if (!b.client?.phone)                              return fail(res, 'client.phone обязателен');
    if (!Array.isArray(b.items) || !b.items.length)   return fail(res, 'items обязателен (непустой массив)');

    const id        = Date.now().toString();
    const createdAt = new Date().toISOString();
    const row       = buildOrderRow(b, id, createdAt);

    db.transaction(() => {
      db.prepare(`INSERT INTO orders (
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
      for (const item of (b.items ?? [])) {
        stmtInsertItem.run({ order_id:row.id, item_id:item.id??null, name:item.name??'',
          qty:item.qty??1, price:item.price??0, product_type:item.productType??'PIECE', details:item.details??null });
      }
      if (row.client_phone.length >= 7) stmtUpsertClient.run({
        phone:row.client_phone, name:row.client_name, street:row.client_street, house:row.client_house,
        entrance:row.client_entrance, floor:row.client_floor, apartment:row.client_apartment,
        intercom:row.client_intercom, notes:row.client_notes,
      });
    })();

    return respond(res, rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)), 201);
  }

  // POST /desk-api/orders — browser sync (bulk upsert)
  if (method === 'POST') {
    let incoming; try { incoming = await readBody(req); } catch (e) { return fail(res, e.message); }
    if (!Array.isArray(incoming)) return fail(res, 'Ожидается массив заказов');

    const syncOrders = db.transaction((orders) => {
      for (const o of orders) {
        const exists = db.prepare('SELECT id FROM orders WHERE id = ?').get(o.id);
        if (exists) {
          // Update mutable fields (status, client, items, totals, flags)
          db.prepare(`UPDATE orders SET
            status=@status, store_id=@store_id, order_method=@order_method, pay_method=@pay_method,
            operator=@operator, total=@total, seq_num=@seq_num, order_number=@order_number,
            delivery_price=@delivery_price, order_amount=@order_amount, given=@given,
            change_amt=@change_amt, deleted_at=@deleted_at,
            client_phone=@client_phone, client_name=@client_name, client_street=@client_street,
            client_house=@client_house, client_entrance=@client_entrance, client_floor=@client_floor,
            client_apartment=@client_apartment, client_intercom=@client_intercom, client_notes=@client_notes
          WHERE id=@id`).run(buildOrderRow(o, o.id, o.createdAt));
          // Replace items
          stmtDeleteItems.run(o.id);
          for (const item of (o.items ?? [])) {
            stmtInsertItem.run({ order_id:o.id, item_id:item.id??null, name:item.name??'',
              qty:item.qty??1, price:item.price??0, product_type:item.productType??'PIECE', details:item.details??null });
          }
        } else {
          insertOrderWithItems(o);
        }
      }
    });
    syncOrders(incoming);
    return res.end('{"ok":true}');
  }

  // PATCH
  if (method === 'PATCH') {
    const id = url.searchParams.get('id');
    if (!id) return fail(res, 'Укажите ?id=...');
    let patch; try { patch = await readBody(req); } catch (e) { return fail(res, e.message); }

    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!row) return fail(res, 'Заказ не найден', 404);

    const allowed = ['status','store_id','order_method','pay_method','operator','total',
                     'seq_num','order_number','delivery_price','order_amount','given','change_amt',
                     'deleted_at','client_phone','client_name','client_street','client_house',
                     'client_entrance','client_floor','client_apartment','client_intercom','client_notes'];

    // Map camelCase patch fields to snake_case columns
    const camelToSnake = {
      storeId:'store_id', orderMethod:'order_method', payMethod:'pay_method', seqNum:'seq_num',
      orderNumber:'order_number', deliveryPrice:'delivery_price', orderAmount:'order_amount',
      change:'change_amt', deletedAt:'deleted_at',
    };

    const setClauses = [];
    const runParams  = { id };

    // Handle client sub-object
    if (patch.client) {
      const c = patch.client;
      const fields = { client_phone:normPhone(c.phone??''), client_name:c.name??'',
        client_street:c.street??'', client_house:c.house??'', client_entrance:c.entrance??'',
        client_floor:c.floor??'', client_apartment:c.apartment??'',
        client_intercom:c.intercom??'', client_notes:c.notes??'' };
      for (const [k, v] of Object.entries(fields)) {
        setClauses.push(`${k} = @${k}`); runParams[k] = v;
      }
    }

    // Handle items replacement
    if (patch.items != null) {
      db.transaction(() => {
        stmtDeleteItems.run(id);
        for (const item of patch.items) {
          stmtInsertItem.run({ order_id:id, item_id:item.id??null, name:item.name??'',
            qty:item.qty??1, price:item.price??0, product_type:item.productType??'PIECE', details:item.details??null });
        }
      })();
    }

    for (const [key, val] of Object.entries(patch)) {
      if (key === 'id' || key === 'createdAt' || key === 'client' || key === 'items') continue;
      const col = camelToSnake[key] ?? key;
      if (!allowed.includes(col)) continue;
      setClauses.push(`${col} = @${col}`);
      runParams[col] = val;
    }

    if (setClauses.length) {
      db.prepare(`UPDATE orders SET ${setClauses.join(', ')} WHERE id = @id`).run(runParams);
    }

    return respond(res, rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)));
  }

  // DELETE
  if (method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return fail(res, 'Укажите ?id=...');
    const row = db.prepare('SELECT id FROM orders WHERE id = ?').get(id);
    if (!row) return fail(res, 'Заказ не найден', 404);
    db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    return respond(res, { deleted: 1 });
  }

  fail(res, 'Method Not Allowed', 405);
}

// ── Clients ───────────────────────────────────────────────────────────────────

async function handleClients(req, res, url) {
  const method = req.method;

  if (method === 'GET') {
    const phone  = url.searchParams.get('phone')  ?? '';
    const search = url.searchParams.get('search') ?? '';
    const exact  = url.searchParams.get('exact') !== 'false';

    if (phone) {
      const d = normPhone(phone);
      if (exact) {
        const row = db.prepare('SELECT * FROM clients WHERE phone = ?').get(d);
        return row ? respond(res, rowToClient(row)) : fail(res, "Клиент не найден", 404);
      }
      if (d.length < 3) return respond(res, []);
      const rows = db.prepare("SELECT * FROM clients WHERE phone LIKE ? LIMIT 20").all(`%${d}%`);
      return respond(res, rows);
    }

    if (search) {
      const q = `%${search.toLowerCase()}%`;
      const d = normPhone(search);
      const rows = db.prepare(
        "SELECT * FROM clients WHERE LOWER(name) LIKE ? OR phone LIKE ? LIMIT 20"
      ).all(q, `%${d}%`);
      return respond(res, rows);
    }

    const total  = db.prepare('SELECT COUNT(*) as n FROM clients').get().n;
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const lp     = url.searchParams.get('limit');
    const limit  = lp ? parseInt(lp, 10) : total;
    const data   = db.prepare('SELECT * FROM clients ORDER BY name LIMIT ? OFFSET ?').all(limit, offset);
    return respond(res, { data, total, offset, limit });
  }

  if (method === 'POST') {
    let input; try { input = await readBody(req); } catch (e) { return fail(res, e.message); }
    const d = normPhone(input.phone ?? '');
    if (d.length < 7) return fail(res, 'Некорректный номер телефона (минимум 7 цифр)');
    const entry = { phone:d, name:input.name??'', street:input.street??'', house:input.house??'',
      entrance:input.entrance??'', floor:input.floor??'', apartment:input.apartment??'',
      intercom:input.intercom??'', notes:input.notes??'' };
    const exists = db.prepare('SELECT phone FROM clients WHERE phone = ?').get(d);
    if (exists) {
      db.prepare(`UPDATE clients SET name=@name,street=@street,house=@house,entrance=@entrance,
        floor=@floor,apartment=@apartment,intercom=@intercom,notes=@notes WHERE phone=@phone`).run(entry);
      return respond(res, rowToClient(db.prepare('SELECT * FROM clients WHERE phone = ?').get(d)));
    }
    db.prepare(`INSERT INTO clients (phone,name,street,house,entrance,floor,apartment,intercom,notes)
      VALUES (@phone,@name,@street,@house,@entrance,@floor,@apartment,@intercom,@notes)`).run(entry);
    return respond(res, rowToClient(db.prepare('SELECT * FROM clients WHERE phone = ?').get(d)), 201);
  }

  if (method === 'DELETE') {
    const phone = url.searchParams.get('phone') ?? '';
    if (!phone) return fail(res, 'Укажите ?phone=...');
    const d      = normPhone(phone);
    const result = db.prepare('DELETE FROM clients WHERE phone = ?').run(d);
    return respond(res, { deleted: result.changes });
  }

  fail(res, 'Method Not Allowed', 405);
}

// ── Local Products ────────────────────────────────────────────────────────────

async function handleLocalProducts(req, res, url) {
  const method = req.method;
  const id     = url.searchParams.get('id');

  if (method === 'GET') {
    return respond(res, db.prepare('SELECT * FROM local_products ORDER BY sort_order').all()
      .map(r => ({ id:r.id, name:r.name, price:r.price, productType:r.product_type })));
  }

  if (method === 'POST') {
    let b; try { b = await readBody(req); } catch (e) { return fail(res, e.message); }
    if (!b.name) return fail(res, 'name обязателен');
    const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM local_products').get().m ?? -1;
    const item = { id:`local_${Date.now()}`, name:String(b.name).trim(),
      price:Math.max(0, parseFloat(b.price)||0), product_type:b.productType||'PIECE', sort_order:maxSort+1 };
    db.prepare('INSERT INTO local_products (id,name,price,product_type,sort_order) VALUES (@id,@name,@price,@product_type,@sort_order)').run(item);
    return respond(res, { id:item.id, name:item.name, price:item.price, productType:item.product_type }, 201);
  }

  if (method === 'PATCH') {
    if (!id) return fail(res, 'Укажите ?id=...');
    let b; try { b = await readBody(req); } catch (e) { return fail(res, e.message); }
    const row = db.prepare('SELECT * FROM local_products WHERE id = ?').get(id);
    if (!row) return fail(res, 'Товар не найден', 404);
    if (b.name        != null) db.prepare('UPDATE local_products SET name=? WHERE id=?').run(String(b.name).trim(), id);
    if (b.price       != null) db.prepare('UPDATE local_products SET price=? WHERE id=?').run(Math.max(0,parseFloat(b.price)||0), id);
    if (b.productType != null) db.prepare('UPDATE local_products SET product_type=? WHERE id=?').run(b.productType, id);
    if (b.sortOrder   != null) db.prepare('UPDATE local_products SET sort_order=? WHERE id=?').run(b.sortOrder, id);
    const updated = db.prepare('SELECT * FROM local_products WHERE id = ?').get(id);
    return respond(res, { id:updated.id, name:updated.name, price:updated.price, productType:updated.product_type });
  }

  if (method === 'DELETE') {
    if (!id) return fail(res, 'Укажите ?id=...');
    const result = db.prepare('DELETE FROM local_products WHERE id = ?').run(id);
    if (!result.changes) return fail(res, 'Товар не найден', 404);
    return respond(res, { deleted: 1 });
  }

  fail(res, 'Method Not Allowed', 405);
}

// ── V1 API (stable, versioned) ────────────────────────────────────────────────

async function handleV1(req, res, pathname, url) {
  const method = req.method;

  if (method === 'GET' && pathname === '/desk-api/v1/') {
    return respond(res, {
      version: 'v1',
      endpoints: [
        'GET    /desk-api/v1/orders',
        'GET    /desk-api/v1/orders/:id',
        'POST   /desk-api/v1/orders',
        'PATCH  /desk-api/v1/orders/:id',
        'DELETE /desk-api/v1/orders/:id',
        'GET    /desk-api/v1/clients',
        'GET    /desk-api/v1/clients/:phone',
        'POST   /desk-api/v1/clients',
        'PATCH  /desk-api/v1/clients/:phone',
        'DELETE /desk-api/v1/clients/:phone',
        'GET    /desk-api/v1/local-products',
        'POST   /desk-api/v1/local-products',
        'PATCH  /desk-api/v1/local-products/:id',
        'DELETE /desk-api/v1/local-products/:id',
      ],
    });
  }

  const orderIdMatch    = pathname.match(/^\/desk-api\/v1\/orders\/([^/]+)$/);
  const clientIdMatch   = pathname.match(/^\/desk-api\/v1\/clients\/([^/]+)$/);
  const clientAddrMatch = pathname.match(/^\/desk-api\/v1\/clients\/([^/]+)\/addresses(?:\/(\d+))?$/);
  const localIdMatch    = pathname.match(/^\/desk-api\/v1\/local-products\/([^/]+)$/);

  // ── Orders ────────────────────────────────────────────────────────────────

  if (method === 'GET' && orderIdMatch) {
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderIdMatch[1]);
    return row ? respond(res, rowToOrder(row)) : fail(res, 'Заказ не найден', 404);
  }

  if (method === 'GET' && pathname === '/desk-api/v1/orders') {
    let sql = 'SELECT * FROM orders WHERE 1=1';
    const params = [];
    const phone    = url.searchParams.get('phone');
    const status   = url.searchParams.get('status');
    const operator = url.searchParams.get('operator');
    const storeId  = url.searchParams.get('store_id');
    const dateFrom = url.searchParams.get('date_from');
    const dateTo   = url.searchParams.get('date_to');
    if (phone)    { sql += ' AND client_phone = ?'; params.push(normPhone(phone)); }
    if (status)   { sql += ' AND status = ?';       params.push(status); }
    if (operator) { sql += ' AND operator = ?';     params.push(operator); }
    if (storeId)  { sql += ' AND store_id = ?';     params.push(storeId); }
    if (dateFrom) { sql += ' AND created_at >= ?';  params.push(dateFrom); }
    if (dateTo)   { sql += ' AND created_at <= ?';  params.push(dateTo + 'T23:59:59.999Z'); }
    sql += ' ORDER BY created_at DESC';
    const rows   = db.prepare(sql).all(...params);
    const total  = rows.length;
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const lp     = url.searchParams.get('limit');
    const limit  = lp ? parseInt(lp, 10) : total;
    return respond(res, { data: rows.slice(offset, offset + limit).map(rowToOrder), total, offset, limit });
  }

  if (method === 'POST' && pathname === '/desk-api/v1/orders') {
    let b; try { b = await readBody(req); } catch (e) { return fail(res, e.message); }
    if (!b.client?.phone)                            return fail(res, 'client.phone обязателен');
    if (!Array.isArray(b.items) || !b.items.length)  return fail(res, 'items обязателен');
    const id = Date.now().toString();
    const row = buildOrderRow(b, id, new Date().toISOString());
    db.transaction(() => {
      db.prepare(`INSERT INTO orders (
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
      for (const item of b.items) {
        stmtInsertItem.run({ order_id:id, item_id:item.id??null, name:item.name??'', qty:item.qty??1,
          price:item.price??0, product_type:item.productType??'PIECE', details:item.details??null });
      }
      if (row.client_phone.length >= 7) stmtUpsertClient.run({
        phone:row.client_phone, name:row.client_name, street:row.client_street, house:row.client_house,
        entrance:row.client_entrance, floor:row.client_floor, apartment:row.client_apartment,
        intercom:row.client_intercom, notes:row.client_notes,
      });
    })();
    return respond(res, rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)), 201);
  }

  if (method === 'PATCH' && orderIdMatch) {
    let b; try { b = await readBody(req); } catch (e) { return fail(res, e.message); }
    const id  = orderIdMatch[1];
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!row) return fail(res, 'Заказ не найден', 404);

    const camelToSnake = { storeId:'store_id', orderMethod:'order_method', payMethod:'pay_method',
      seqNum:'seq_num', orderNumber:'order_number', deliveryPrice:'delivery_price',
      orderAmount:'order_amount', change:'change_amt', deletedAt:'deleted_at' };
    const allowed = ['status','store_id','order_method','pay_method','operator','total','seq_num',
      'order_number','delivery_price','order_amount','given','change_amt','deleted_at'];

    const setClauses = [];
    const runParams  = { id };

    if (b.client) {
      const c = b.client;
      Object.assign(runParams, { client_phone:normPhone(c.phone??''), client_name:c.name??'',
        client_street:c.street??'', client_house:c.house??'', client_entrance:c.entrance??'',
        client_floor:c.floor??'', client_apartment:c.apartment??'',
        client_intercom:c.intercom??'', client_notes:c.notes??'' });
      setClauses.push('client_phone=@client_phone','client_name=@client_name','client_street=@client_street',
        'client_house=@client_house','client_entrance=@client_entrance','client_floor=@client_floor',
        'client_apartment=@client_apartment','client_intercom=@client_intercom','client_notes=@client_notes');
    }
    if (b.items != null) {
      db.transaction(() => {
        stmtDeleteItems.run(id);
        for (const item of b.items) {
          stmtInsertItem.run({ order_id:id, item_id:item.id??null, name:item.name??'',
            qty:item.qty??1, price:item.price??0, product_type:item.productType??'PIECE', details:item.details??null });
        }
      })();
    }
    for (const [key, val] of Object.entries(b)) {
      if (['id','createdAt','client','items'].includes(key)) continue;
      const col = camelToSnake[key] ?? key;
      if (!allowed.includes(col)) continue;
      setClauses.push(`${col}=@${col}`);
      runParams[col] = val;
    }
    if (setClauses.length) {
      db.prepare(`UPDATE orders SET ${setClauses.join(',')} WHERE id=@id`).run(runParams);
    }
    return respond(res, rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)));
  }

  if (method === 'DELETE' && orderIdMatch) {
    const id = orderIdMatch[1];
    if (!db.prepare('SELECT id FROM orders WHERE id = ?').get(id)) return fail(res, 'Заказ не найден', 404);
    db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    return respond(res, { deleted: 1 });
  }

  // ── Client addresses ─────────────────────────────────────────────────────

  if (clientAddrMatch) {
    const d = normPhone(decodeURIComponent(clientAddrMatch[1]));
    const row = db.prepare('SELECT * FROM clients WHERE phone = ?').get(d);
    if (!row) return fail(res, 'Клиент не найден', 404);

    const parseAddrs = (r) => { try { return JSON.parse(r.addresses_json || '[]'); } catch { return []; } };
    const addrKey = (a) => [a.street,a.house,a.entrance,a.floor,a.apartment,a.intercom].map(s=>(s||'').trim().toLowerCase()).join('|');

    if (method === 'POST' && !clientAddrMatch[2]) {
      let b; try { b = await readBody(req); } catch (e) { return fail(res, e.message); }
      const addresses = parseAddrs(row);
      const newAddr = { street:b.street??'', house:b.house??'', entrance:b.entrance??'', floor:b.floor??'', apartment:b.apartment??'', intercom:b.intercom??'' };
      if (!addresses.some(a => addrKey(a) === addrKey(newAddr))) addresses.push(newAddr);
      db.prepare('UPDATE clients SET addresses_json=? WHERE phone=?').run(JSON.stringify(addresses), d);
      return respond(res, rowToClient(db.prepare('SELECT * FROM clients WHERE phone=?').get(d)));
    }

    if (method === 'PATCH' && clientAddrMatch[2] !== undefined) {
      let b; try { b = await readBody(req); } catch (e) { return fail(res, e.message); }
      const idx = parseInt(clientAddrMatch[2], 10);
      const addresses = parseAddrs(row);
      if (idx < 0 || idx >= addresses.length) return fail(res, 'Индекс адреса вне диапазона', 400);
      addresses[idx] = { street:b.street??addresses[idx].street, house:b.house??addresses[idx].house, entrance:b.entrance??addresses[idx].entrance, floor:b.floor??addresses[idx].floor, apartment:b.apartment??addresses[idx].apartment, intercom:b.intercom??addresses[idx].intercom };
      db.prepare('UPDATE clients SET addresses_json=? WHERE phone=?').run(JSON.stringify(addresses), d);
      return respond(res, rowToClient(db.prepare('SELECT * FROM clients WHERE phone=?').get(d)));
    }
  }

  // ── Clients ───────────────────────────────────────────────────────────────

  if (method === 'GET' && clientIdMatch) {
    const d = normPhone(decodeURIComponent(clientIdMatch[1]));
    const row = db.prepare('SELECT * FROM clients WHERE phone = ?').get(d);
    return row ? respond(res, rowToClient(row)) : fail(res, "Клиент не найден", 404);
  }

  if (method === 'GET' && pathname === '/desk-api/v1/clients') {
    const phone  = url.searchParams.get('phone')  ?? '';
    const search = url.searchParams.get('search') ?? '';
    if (phone) {
      const d = normPhone(phone);
      if (d.length < 3) return respond(res, []);
      return respond(res, db.prepare("SELECT * FROM clients WHERE phone LIKE ? LIMIT 20").all(`%${d}%`).map(rowToClient));
    }
    if (search) {
      const q = `%${search.toLowerCase()}%`;
      return respond(res, db.prepare("SELECT * FROM clients WHERE LOWER(name) LIKE ? OR phone LIKE ? LIMIT 20")
        .all(q, `%${normPhone(search)}%`).map(rowToClient));
    }
    const total  = db.prepare('SELECT COUNT(*) as n FROM clients').get().n;
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const lp     = url.searchParams.get('limit');
    const limit  = lp ? parseInt(lp, 10) : total;
    return respond(res, { data: db.prepare('SELECT * FROM clients ORDER BY name LIMIT ? OFFSET ?').all(limit, offset).map(rowToClient), total, offset, limit });
  }

  if (method === 'POST' && pathname === '/desk-api/v1/clients') {
    let input; try { input = await readBody(req); } catch (e) { return fail(res, e.message); }
    const d = normPhone(input.phone ?? '');
    if (d.length < 7) return fail(res, 'Некорректный номер телефона');
    const entry = { phone:d, name:input.name??'', street:input.street??'', house:input.house??'',
      entrance:input.entrance??'', floor:input.floor??'', apartment:input.apartment??'',
      intercom:input.intercom??'', notes:input.notes??'' };
    const exists = db.prepare('SELECT phone FROM clients WHERE phone = ?').get(d);
    if (exists) {
      db.prepare(`UPDATE clients SET name=@name,street=@street,house=@house,entrance=@entrance,
        floor=@floor,apartment=@apartment,intercom=@intercom,notes=@notes WHERE phone=@phone`).run(entry);
    } else {
      db.prepare(`INSERT INTO clients (phone,name,street,house,entrance,floor,apartment,intercom,notes)
        VALUES (@phone,@name,@street,@house,@entrance,@floor,@apartment,@intercom,@notes)`).run(entry);
    }
    return respond(res, rowToClient(db.prepare('SELECT * FROM clients WHERE phone = ?').get(d)), exists ? 200 : 201);
  }

  if (method === 'PATCH' && clientIdMatch) {
    let b; try { b = await readBody(req); } catch (e) { return fail(res, e.message); }
    const d = normPhone(decodeURIComponent(clientIdMatch[1]));
    const row = db.prepare('SELECT * FROM clients WHERE phone = ?').get(d);
    if (!row) return fail(res, 'Клиент не найден', 404);
    const fields = ['name','street','house','entrance','floor','apartment','intercom','notes'];
    const setClauses = [];
    const params = { phone: d };
    for (const f of fields) {
      if (b[f] != null) { setClauses.push(`${f}=@${f}`); params[f] = b[f]; }
    }
    if (setClauses.length) db.prepare(`UPDATE clients SET ${setClauses.join(',')} WHERE phone=@phone`).run(params);
    return respond(res, rowToClient(db.prepare('SELECT * FROM clients WHERE phone = ?').get(d)));
  }

  if (method === 'DELETE' && clientIdMatch) {
    const d = normPhone(decodeURIComponent(clientIdMatch[1]));
    const result = db.prepare('DELETE FROM clients WHERE phone = ?').run(d);
    return respond(res, { deleted: result.changes });
  }

  // ── Local Products ────────────────────────────────────────────────────────

  if (method === 'GET' && pathname === '/desk-api/v1/local-products') {
    return respond(res, db.prepare('SELECT * FROM local_products ORDER BY sort_order').all()
      .map(r => ({ id:r.id, name:r.name, price:r.price, productType:r.product_type })));
  }

  if (method === 'POST' && pathname === '/desk-api/v1/local-products') {
    let b; try { b = await readBody(req); } catch (e) { return fail(res, e.message); }
    if (!b.name) return fail(res, 'name обязателен');
    const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM local_products').get().m ?? -1;
    const item = { id:`local_${Date.now()}`, name:String(b.name).trim(),
      price:Math.max(0,parseFloat(b.price)||0), product_type:b.productType||'PIECE', sort_order:maxSort+1 };
    db.prepare('INSERT INTO local_products (id,name,price,product_type,sort_order) VALUES (@id,@name,@price,@product_type,@sort_order)').run(item);
    return respond(res, { id:item.id, name:item.name, price:item.price, productType:item.product_type }, 201);
  }

  if (method === 'PATCH' && localIdMatch) {
    let b; try { b = await readBody(req); } catch (e) { return fail(res, e.message); }
    const row = db.prepare('SELECT * FROM local_products WHERE id = ?').get(localIdMatch[1]);
    if (!row) return fail(res, 'Товар не найден', 404);
    if (b.name        != null) db.prepare('UPDATE local_products SET name=? WHERE id=?').run(String(b.name).trim(), localIdMatch[1]);
    if (b.price       != null) db.prepare('UPDATE local_products SET price=? WHERE id=?').run(Math.max(0,parseFloat(b.price)||0), localIdMatch[1]);
    if (b.productType != null) db.prepare('UPDATE local_products SET product_type=? WHERE id=?').run(b.productType, localIdMatch[1]);
    const updated = db.prepare('SELECT * FROM local_products WHERE id = ?').get(localIdMatch[1]);
    return respond(res, { id:updated.id, name:updated.name, price:updated.price, productType:updated.product_type });
  }

  if (method === 'DELETE' && localIdMatch) {
    const result = db.prepare('DELETE FROM local_products WHERE id = ?').run(localIdMatch[1]);
    if (!result.changes) return fail(res, 'Товар не найден', 404);
    return respond(res, { deleted: 1 });
  }

  return null;
}

// ── Generic JSON-file endpoint ────────────────────────────────────────────────

async function handleJsonFile(req, res, file, fallback) {
  if (req.method === 'GET') {
    return res.end(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback);
  }
  if (req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return fail(res, e.message); }
    writeJson(file, body);
    return res.end('{"ok":true}');
  }
  fail(res, 'Method Not Allowed', 405);
}

// ── Main server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token');

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const url      = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader('Content-Type', 'application/json');

  try {
    if (pathname.startsWith('/desk-api/v1/'))    return await handleV1(req, res, pathname, url) ?? fail(res, 'Not found', 404);
    if (pathname.startsWith('/desk-api/clients'))return await handleClients(req, res, url);
    if (pathname.startsWith('/desk-api/orders')) return await handleOrders(req, res, url, pathname);
    if (pathname === '/desk-api/local-products') return await handleLocalProducts(req, res, url);
    if (pathname === '/desk-api/countries')      return await handleJsonFile(req, res, COUNTRIES_FILE,      '[]');
    if (pathname === '/desk-api/whitelist')      return await handleJsonFile(req, res, WHITELIST_FILE,      '[]');
    if (pathname === '/desk-api/operator-names') return await handleJsonFile(req, res, OPERATOR_NAMES_FILE, '{}');
    fail(res, 'Not found', 404);
  } catch (e) {
    console.error(e);
    fail(res, String(e), 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[desk-api] SQLite backend — http://127.0.0.1:${PORT}`);
  console.log(`[desk-api] DB: ${p('desk.db')}`);
});
