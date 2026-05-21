#!/usr/bin/env node
/**
 * Sync client addresses from orders into clients table.
 * - If address from order not in client.addresses_json → add it
 * - If client missing name but orders have name → update name
 * Run: node sync-client-addresses.mjs [--dry-run]
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const db   = new Database(path.join(ROOT, 'desk.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const DRY = process.argv.includes('--dry-run');
if (DRY) console.log('=== DRY RUN — ничего не будет изменено ===\n');

function addrKey(a) {
  return [a.street, a.house, a.entrance, a.floor, a.apartment, a.intercom]
    .map(s => (s ?? '').trim().toLowerCase()).join('|');
}

function hasAddr(a) {
  return !!(a.street?.trim() || a.house?.trim());
}

// Загружаем все заказы с адресами, группируем по телефону
const orders = db.prepare(`
  SELECT client_phone, client_name, client_street, client_house,
         client_entrance, client_floor, client_apartment, client_intercom, client_notes
  FROM orders
  WHERE client_phone != '' AND (client_street != '' OR client_house != '')
  ORDER BY created_at ASC
`).all();

// Группировка: phone → { name, addresses[] }
const byPhone = new Map();
for (const o of orders) {
  const phone = o.client_phone;
  if (!byPhone.has(phone)) byPhone.set(phone, { name: '', addresses: [] });
  const entry = byPhone.get(phone);

  // Берём имя из заказа если ещё нет или текущее пустое
  if (o.client_name?.trim() && !entry.name) entry.name = o.client_name.trim();

  const addr = {
    street:    o.client_street    ?? '',
    house:     o.client_house     ?? '',
    entrance:  o.client_entrance  ?? '',
    floor:     o.client_floor     ?? '',
    apartment: o.client_apartment ?? '',
    intercom:  o.client_intercom  ?? '',
  };
  if (hasAddr(addr) && !entry.addresses.some(a => addrKey(a) === addrKey(addr))) {
    entry.addresses.push(addr);
  }
}

console.log(`Уникальных клиентов из заказов: ${byPhone.size}`);

const stmtUpdateClient = db.prepare(`
  UPDATE clients
  SET addresses_json = @addresses_json,
      name = CASE WHEN name = '' AND @name != '' THEN @name ELSE name END
  WHERE phone = @phone
`);

const stmtInsertClient = db.prepare(`
  INSERT INTO clients (phone, name, street, house, entrance, floor, apartment, intercom, notes, addresses_json)
  VALUES (@phone, @name, @street, @house, @entrance, @floor, @apartment, @intercom, '', @addresses_json)
`);

let updated = 0, created = 0, skipped = 0;

const process_ = db.transaction(() => {
  for (const [phone, fromOrders] of byPhone) {
    const existing = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);

    if (!existing) {
      // Новый клиент
      const first = fromOrders.addresses[0] ?? {};
      const row = {
        phone,
        name:          fromOrders.name,
        street:        first.street    ?? '',
        house:         first.house     ?? '',
        entrance:      first.entrance  ?? '',
        floor:         first.floor     ?? '',
        apartment:     first.apartment ?? '',
        intercom:      first.intercom  ?? '',
        addresses_json: fromOrders.addresses.length > 0 ? JSON.stringify(fromOrders.addresses) : null,
      };
      console.log(`  [СОЗДАН] ${phone} "${fromOrders.name}" ${fromOrders.addresses.length} адр.`);
      if (!DRY) stmtInsertClient.run(row);
      created++;
      continue;
    }

    // Клиент существует — дополняем адреса
    let existingAddrs = [];
    try { existingAddrs = existing.addresses_json ? JSON.parse(existing.addresses_json) : []; } catch { existingAddrs = []; }

    // Добавляем основной адрес клиента в список если его ещё нет
    const mainAddr = {
      street:    existing.street    ?? '',
      house:     existing.house     ?? '',
      entrance:  existing.entrance  ?? '',
      floor:     existing.floor     ?? '',
      apartment: existing.apartment ?? '',
      intercom:  existing.intercom  ?? '',
    };
    if (hasAddr(mainAddr) && !existingAddrs.some(a => addrKey(a) === addrKey(mainAddr))) {
      existingAddrs.unshift(mainAddr);
    }

    // Добавляем новые адреса из заказов
    let added = 0;
    for (const addr of fromOrders.addresses) {
      if (!existingAddrs.some(a => addrKey(a) === addrKey(addr))) {
        existingAddrs.push(addr);
        added++;
      }
    }

    if (added === 0 && existing.addresses_json !== null) {
      skipped++;
      continue;
    }

    const newJson = existingAddrs.length > 0 ? JSON.stringify(existingAddrs) : null;
    console.log(`  [ОБНОВЛЁН] ${phone} "${existing.name || fromOrders.name}" +${added} адр. (итого: ${existingAddrs.length})`);
    if (!DRY) stmtUpdateClient.run({ phone, addresses_json: newJson, name: fromOrders.name });
    updated++;
  }
});

process_();

console.log(`\nИтог: создано ${created}, обновлено ${updated}, без изменений ${skipped}`);
db.close();
