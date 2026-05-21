#!/usr/bin/env node
/**
 * Fix concatenated phone numbers in clients table.
 * E.g. "8916060333989153964825" -> primary "89160603339", extra ["89153964825"]
 *
 * Run: node fix-bad-phones.mjs [--dry-run]
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const db   = new Database(path.join(ROOT, 'desk.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // temporarily for UPDATE of PK

const DRY = process.argv.includes('--dry-run');
if (DRY) console.log('=== DRY RUN ===\n');

// Разбиваем длинный номер на 11-значные части
function splitPhones(raw) {
  const d = raw.replace(/\D/g, '');
  const parts = [];
  let i = 0;
  while (i < d.length) {
    if ((d[i] === '7' || d[i] === '8') && i + 11 <= d.length) {
      parts.push(d.slice(i, i + 11));
      i += 11;
    } else {
      const tail = d.slice(i);
      if (tail.length >= 10) parts.push(tail);
      break;
    }
  }
  return parts.filter(p => p.length >= 10);
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function mergeAddresses(aJson, bJson) {
  const addrKey = a =>
    [a.street, a.house, a.entrance, a.floor, a.apartment, a.intercom]
      .map(s => (s ?? '').trim().toLowerCase()).join('|');
  const a = tryParse(aJson) ?? [];
  const b = tryParse(bJson) ?? [];
  const seen = new Set(a.map(addrKey));
  const merged = [...a];
  for (const addr of b) if (!seen.has(addrKey(addr))) merged.push(addr);
  return merged.length ? JSON.stringify(merged) : null;
}

function tryParse(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

function bestName(a, b) {
  if (!a || a === 'Клиент') return b ?? '';
  if (!b || b === 'Клиент') return a ?? '';
  return a.length >= b.length ? a : b;
}

const bad = db.prepare('SELECT * FROM clients').all()
  .filter(c => c.phone.replace(/\D/g, '').length > 11);

console.log(`Кривых записей: ${bad.length}\n`);

let fixed = 0, merged = 0, skipped = 0;

const run = db.transaction(() => {
  for (const rec of bad) {
    const parts = splitPhones(rec.phone);
    if (!parts.length) {
      console.log(`  [ПРОПУЩЕН] ${rec.phone} - не удалось разбить`);
      skipped++;
      continue;
    }

    const primary   = parts[0];
    const extraFromSplit = parts.slice(1);

    // Собираем все доп. номера: из разбивки + из phones_json
    const existingExtra = tryParse(rec.phones_json) ?? [];
    const allExtra = dedupe([...extraFromSplit, ...existingExtra]).filter(p => p !== primary);
    const newPhonesJson = allExtra.length ? JSON.stringify(allExtra) : null;

    // Проверяем: существует ли запись с primary в базе
    const conflict = db.prepare('SELECT * FROM clients WHERE phone = ?').get(primary);

    if (conflict && conflict.phone === rec.phone) {
      // Не должно случиться, но на всякий случай
      console.log(`  [ПРОПУЩЕН] ${rec.phone} - конфликт сам с собой`);
      skipped++;
      continue;
    }

    console.log(`  ${rec.phone} -> [${primary}]${allExtra.length ? ' extra: ' + allExtra.join(', ') : ''} | "${rec.name}"`);

    if (conflict) {
      // Есть клиент с таким номером — мержим данные в него, удаляем кривую запись
      console.log(`    MERGE с существующим "${conflict.name}"`);
      const mergedName     = bestName(conflict.name, rec.name);
      const mergedAddrJson = mergeAddresses(conflict.addresses_json, rec.addresses_json);
      const mergedExtra    = dedupe([
        ...(tryParse(conflict.phones_json) ?? []),
        ...allExtra,
      ]).filter(p => p !== primary);

      if (!DRY) {
        db.prepare(`UPDATE clients SET
          name = @name, addresses_json = @addresses_json, phones_json = @phones_json
          WHERE phone = @phone`).run({
          phone: primary,
          name: mergedName,
          addresses_json: mergedAddrJson,
          phones_json: mergedExtra.length ? JSON.stringify(mergedExtra) : null,
        });
        db.prepare('DELETE FROM clients WHERE phone = ?').run(rec.phone);
        // Обновляем orders чтобы ссылки не сломались
        db.prepare('UPDATE orders SET client_phone = ? WHERE client_phone = ?').run(primary, rec.phone);
      }
      merged++;
    } else {
      // Просто обновляем номер (нет конфликта)
      if (!DRY) {
        db.prepare(`UPDATE clients SET phone = @primary, phones_json = @phones_json WHERE phone = @old`).run({
          primary, phones_json: newPhonesJson, old: rec.phone,
        });
        db.prepare('UPDATE orders SET client_phone = ? WHERE client_phone = ?').run(primary, rec.phone);
      }
      fixed++;
    }
  }
});

run();

console.log(`\nИтог: исправлено ${fixed}, смержено с дублем ${merged}, пропущено ${skipped}`);
db.close();
