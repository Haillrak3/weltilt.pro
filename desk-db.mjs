/**
 * Shared SQLite layer for vite.config.ts middleware and api-server.mjs.
 * Imported as ESM; better-sqlite3 is synchronous so no async needed.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DB_PATH = path.join(ROOT, 'desk.db');

export const db = new Database(DB_PATH);
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

// ── Helpers ───────────────────────────────────────────────────────────────────

export function normPhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '7' ? '8' + d.slice(1) : d;
}

const stmtItems = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');

export function rowToOrder(row) {
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
  if (row.seq_num      != null) order.seqNum        = row.seq_num;
  if (row.order_number != null) order.orderNumber   = row.order_number;
  if (row.delivery_price!=null) order.deliveryPrice = row.delivery_price;
  if (row.order_amount != null) order.orderAmount   = row.order_amount;
  if (row.given        != null) order.given         = row.given;
  if (row.change_amt   != null) order.change        = row.change_amt;
  if (row.deleted_at   != null) order.deletedAt     = row.deleted_at;
  return order;
}

const stmtInsertOrder = db.prepare(`
  INSERT OR IGNORE INTO orders (
    id,created_at,status,store_id,order_method,pay_method,operator,total,seq_num,
    order_number,delivery_price,order_amount,given,change_amt,deleted_at,
    client_phone,client_name,client_street,client_house,client_entrance,
    client_floor,client_apartment,client_intercom,client_notes
  ) VALUES (
    @id,@created_at,@status,@store_id,@order_method,@pay_method,@operator,@total,@seq_num,
    @order_number,@delivery_price,@order_amount,@given,@change_amt,@deleted_at,
    @client_phone,@client_name,@client_street,@client_house,@client_entrance,
    @client_floor,@client_apartment,@client_intercom,@client_notes
  )
`);

const stmtInsertItem = db.prepare(`
  INSERT INTO order_items (order_id,item_id,name,qty,price,product_type,details)
  VALUES (@order_id,@item_id,@name,@qty,@price,@product_type,@details)
`);

const stmtDeleteItems = db.prepare('DELETE FROM order_items WHERE order_id = ?');

const stmtUpsertClient = db.prepare(`
  INSERT INTO clients (phone,name,street,house,entrance,floor,apartment,intercom,notes)
  VALUES (@phone,@name,@street,@house,@entrance,@floor,@apartment,@intercom,@notes)
  ON CONFLICT(phone) DO NOTHING
`);

export function orderToRow(o, id, createdAt) {
  const c = o.client ?? {};
  return {
    id,
    created_at:       createdAt,
    status:           o.status        ?? 'created',
    store_id:         o.storeId       ?? '',
    order_method:     o.orderMethod   ?? 'phone',
    pay_method:       o.payMethod     ?? 'cash',
    operator:         o.operator      ?? '',
    total:            o.total         ?? 0,
    seq_num:          o.seqNum        ?? null,
    order_number:     o.orderNumber   ?? null,
    delivery_price:   o.deliveryPrice ?? null,
    order_amount:     o.orderAmount   ?? null,
    given:            o.given         ?? null,
    change_amt:       o.change        ?? null,
    deleted_at:       o.deletedAt     ?? null,
    client_phone:     normPhone(c.phone ?? ''),
    client_name:      c.name      ?? '',
    client_street:    c.street    ?? '',
    client_house:     c.house     ?? '',
    client_entrance:  c.entrance  ?? '',
    client_floor:     c.floor     ?? '',
    client_apartment: c.apartment ?? '',
    client_intercom:  c.intercom  ?? '',
    client_notes:     c.notes     ?? '',
  };
}

export function insertOrderWithItems(o) {
  const row = orderToRow(o, o.id, o.createdAt);
  stmtInsertOrder.run(row);
  const alreadyHasItems = db.prepare('SELECT 1 FROM order_items WHERE order_id = ?').get(o.id);
  if (!alreadyHasItems) {
    for (const item of (o.items ?? [])) {
      stmtInsertItem.run({
        order_id: o.id, item_id: item.id ?? null, name: item.name ?? '',
        qty: item.qty ?? 1, price: item.price ?? 0,
        product_type: item.productType ?? 'PIECE', details: item.details ?? null,
      });
    }
  }
  if (row.client_phone.length >= 7) stmtUpsertClient.run({
    phone: row.client_phone, name: row.client_name, street: row.client_street,
    house: row.client_house, entrance: row.client_entrance, floor: row.client_floor,
    apartment: row.client_apartment, intercom: row.client_intercom, notes: row.client_notes,
  });
}

export const syncOrders = db.transaction((orders) => {
  for (const o of orders) {
    const exists = db.prepare('SELECT id FROM orders WHERE id = ?').get(o.id);
    if (exists) {
      const row = orderToRow(o, o.id, o.createdAt);
      db.prepare(`UPDATE orders SET
        status=@status,store_id=@store_id,order_method=@order_method,pay_method=@pay_method,
        operator=@operator,total=@total,seq_num=@seq_num,order_number=@order_number,
        delivery_price=@delivery_price,order_amount=@order_amount,given=@given,
        change_amt=@change_amt,deleted_at=@deleted_at,
        client_phone=@client_phone,client_name=@client_name,client_street=@client_street,
        client_house=@client_house,client_entrance=@client_entrance,client_floor=@client_floor,
        client_apartment=@client_apartment,client_intercom=@client_intercom,client_notes=@client_notes
        WHERE id=@id`).run(row);
      stmtDeleteItems.run(o.id);
      for (const item of (o.items ?? [])) {
        stmtInsertItem.run({
          order_id: o.id, item_id: item.id ?? null, name: item.name ?? '',
          qty: item.qty ?? 1, price: item.price ?? 0,
          product_type: item.productType ?? 'PIECE', details: item.details ?? null,
        });
      }
    } else {
      insertOrderWithItems(o);
    }
  }
});

// ── Orders queries ────────────────────────────────────────────────────────────

export function queryOrders(params) {
  const { phone, status, operator, storeId, dateFrom, dateTo } = params;
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const args = [];
  if (phone)    { sql += ' AND client_phone = ?'; args.push(normPhone(phone)); }
  if (status)   { sql += ' AND status = ?';       args.push(status); }
  if (operator) { sql += ' AND operator = ?';     args.push(operator); }
  if (storeId)  { sql += ' AND store_id = ?';     args.push(storeId); }
  if (dateFrom) { sql += ' AND created_at >= ?';  args.push(dateFrom); }
  if (dateTo)   { sql += ' AND created_at <= ?';  args.push(dateTo + 'T23:59:59.999Z'); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...args);
}

export function createOrderInDb(b, operator = 'API') {
  const id = Date.now().toString();
  const createdAt = new Date().toISOString();
  const row = orderToRow({ ...b, operator: b.operator ?? operator }, id, createdAt);
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
      stmtInsertItem.run({
        order_id: id, item_id: item.id ?? null, name: item.name ?? '',
        qty: item.qty ?? 1, price: item.price ?? 0,
        product_type: item.productType ?? 'PIECE', details: item.details ?? null,
      });
    }
    if (row.client_phone.length >= 7) stmtUpsertClient.run({
      phone: row.client_phone, name: row.client_name, street: row.client_street,
      house: row.client_house, entrance: row.client_entrance, floor: row.client_floor,
      apartment: row.client_apartment, intercom: row.client_intercom, notes: row.client_notes,
    });
  })();
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

// ── Local products queries ────────────────────────────────────────────────────

export function getLocalProducts() {
  return db.prepare('SELECT * FROM local_products ORDER BY sort_order').all()
    .map(r => ({ id: r.id, name: r.name, price: r.price, productType: r.product_type }));
}
