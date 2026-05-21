#!/usr/bin/env node
/**
 * One-time migration: desk-orders.json + desk-local-products.json → desk.db
 * Safe to re-run: uses INSERT OR IGNORE, won't duplicate data.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const p    = (...parts) => path.join(ROOT, ...parts);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function normPhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '7' ? '8' + d.slice(1) : d;
}

const db = new Database(p('desk.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id              TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'created',
    store_id        TEXT NOT NULL DEFAULT '',
    order_method    TEXT NOT NULL DEFAULT 'phone',
    pay_method      TEXT NOT NULL DEFAULT 'cash',
    operator        TEXT NOT NULL DEFAULT '',
    total           REAL NOT NULL DEFAULT 0,
    seq_num         INTEGER,
    order_number    TEXT,
    delivery_price  REAL,
    order_amount    REAL,
    given           REAL,
    change_amt      REAL,
    deleted_at      TEXT,
    client_phone    TEXT NOT NULL DEFAULT '',
    client_name     TEXT NOT NULL DEFAULT '',
    client_street   TEXT NOT NULL DEFAULT '',
    client_house    TEXT NOT NULL DEFAULT '',
    client_entrance TEXT NOT NULL DEFAULT '',
    client_floor    TEXT NOT NULL DEFAULT '',
    client_apartment TEXT NOT NULL DEFAULT '',
    client_intercom TEXT NOT NULL DEFAULT '',
    client_notes    TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_orders_created_at   ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_client_phone ON orders(client_phone);
  CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_store_id     ON orders(store_id);
  CREATE INDEX IF NOT EXISTS idx_orders_deleted_at   ON orders(deleted_at);

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

// ── Migrate orders ────────────────────────────────────────────────────────────

const insertOrder = db.prepare(`
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

const insertItem = db.prepare(`
  INSERT INTO order_items (order_id, item_id, name, qty, price, product_type, details)
  VALUES (@order_id, @item_id, @name, @qty, @price, @product_type, @details)
`);

const upsertClient = db.prepare(`
  INSERT OR IGNORE INTO clients (phone, name, street, house, entrance, floor, apartment, intercom, notes)
  VALUES (@phone, @name, @street, @house, @entrance, @floor, @apartment, @intercom, @notes)
`);

const orders = readJson(p('desk-orders.json'), []);
console.log(`Migrating ${orders.length} orders...`);

const migrateOrders = db.transaction((orders) => {
  for (const o of orders) {
    const c = o.client ?? {};
    const phone = normPhone(c.phone ?? '');

    insertOrder.run({
      id:             o.id,
      created_at:     o.createdAt,
      status:         o.status ?? 'created',
      store_id:       o.storeId ?? '',
      order_method:   o.orderMethod ?? 'phone',
      pay_method:     o.payMethod ?? 'cash',
      operator:       o.operator ?? '',
      total:          o.total ?? 0,
      seq_num:        o.seqNum ?? null,
      order_number:   o.orderNumber ?? null,
      delivery_price: o.deliveryPrice ?? null,
      order_amount:   o.orderAmount ?? null,
      given:          o.given ?? null,
      change_amt:     o.change ?? null,
      deleted_at:     o.deletedAt ?? null,
      client_phone:   phone,
      client_name:    c.name      ?? '',
      client_street:  c.street    ?? '',
      client_house:   c.house     ?? '',
      client_entrance:c.entrance  ?? '',
      client_floor:   c.floor     ?? '',
      client_apartment:c.apartment ?? '',
      client_intercom:c.intercom  ?? '',
      client_notes:   c.notes     ?? '',
    });

    if (phone.length >= 7) {
      upsertClient.run({
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

    // Only insert items if this order wasn't already in DB (INSERT OR IGNORE above)
    const exists = db.prepare('SELECT 1 FROM order_items WHERE order_id = ?').get(o.id);
    if (!exists) {
      for (const item of (o.items ?? [])) {
        insertItem.run({
          order_id:     o.id,
          item_id:      item.id ?? null,
          name:         item.name ?? '',
          qty:          item.qty ?? 1,
          price:        item.price ?? 0,
          product_type: item.productType ?? 'PIECE',
          details:      item.details ?? null,
        });
      }
    }
  }
});

migrateOrders(orders);
console.log(`Orders migrated: ${db.prepare('SELECT COUNT(*) as n FROM orders').get().n}`);
console.log(`Items migrated:  ${db.prepare('SELECT COUNT(*) as n FROM order_items').get().n}`);
console.log(`Clients:         ${db.prepare('SELECT COUNT(*) as n FROM clients').get().n}`);

// ── Migrate clients from src/clients.json ────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    phone     TEXT PRIMARY KEY,
    name      TEXT NOT NULL DEFAULT '',
    street    TEXT NOT NULL DEFAULT '',
    house     TEXT NOT NULL DEFAULT '',
    entrance  TEXT NOT NULL DEFAULT '',
    floor     TEXT NOT NULL DEFAULT '',
    apartment TEXT NOT NULL DEFAULT '',
    intercom  TEXT NOT NULL DEFAULT '',
    notes     TEXT NOT NULL DEFAULT '',
    addresses_json TEXT,
    phones_json    TEXT
  );
`);
// Add columns if migrating an existing DB
try { db.exec('ALTER TABLE clients ADD COLUMN addresses_json TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE clients ADD COLUMN phones_json TEXT');    } catch { /* already exists */ }

const upsertClient = db.prepare(`
  INSERT INTO clients (phone,name,street,house,entrance,floor,apartment,intercom,notes,addresses_json,phones_json)
  VALUES (@phone,@name,@street,@house,@entrance,@floor,@apartment,@intercom,@notes,@addresses_json,@phones_json)
  ON CONFLICT(phone) DO UPDATE SET
    name=excluded.name, street=excluded.street, house=excluded.house,
    entrance=excluded.entrance, floor=excluded.floor, apartment=excluded.apartment,
    intercom=excluded.intercom, notes=excluded.notes,
    addresses_json=excluded.addresses_json, phones_json=excluded.phones_json
`);

const srcClients = readJson(p('src/clients.json'), []);
console.log(`\nMigrating ${srcClients.length} clients from src/clients.json...`);

const migrateClients = db.transaction((clients) => {
  for (const c of clients) {
    const phone = normPhone(c.phone ?? '');
    if (phone.length < 7) continue;
    upsertClient.run({
      phone, name: c.name ?? '', street: c.street ?? '', house: c.house ?? '',
      entrance: c.entrance ?? '', floor: c.floor ?? '', apartment: c.apartment ?? '',
      intercom: c.intercom ?? '', notes: c.notes ?? '',
      addresses_json: c.addresses?.length ? JSON.stringify(c.addresses) : null,
      phones_json:    c.phones?.length    ? JSON.stringify(c.phones)    : null,
    });
  }
});
migrateClients(srcClients);
console.log(`Clients migrated: ${db.prepare('SELECT COUNT(*) as n FROM clients').get().n}`);

// ── Migrate local products ────────────────────────────────────────────────────

const insertProduct = db.prepare(`
  INSERT OR IGNORE INTO local_products (id, name, price, product_type, sort_order)
  VALUES (@id, @name, @price, @product_type, @sort_order)
`);

const products = readJson(p('desk-local-products.json'), []);
console.log(`\nMigrating ${products.length} local products...`);

const migrateProducts = db.transaction((products) => {
  products.forEach((pr, i) => {
    insertProduct.run({
      id:           pr.id,
      name:         pr.name,
      price:        pr.price ?? 0,
      product_type: pr.productType ?? 'PIECE',
      sort_order:   i,
    });
  });
});

migrateProducts(products);
console.log(`Products migrated: ${db.prepare('SELECT COUNT(*) as n FROM local_products').get().n}`);

db.close();
console.log('\nDone! desk.db is ready.');
