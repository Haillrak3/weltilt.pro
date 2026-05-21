#!/usr/bin/env node
// Показывает товары в стоп-листе (OUT_OF_STOCK) по всем магазинам "Еще парочку"

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySUQiOjEzLCJyb2xlIjoiTUFTVEVSX0FETUlOIiwiaW1wZXJzb25hdGVkVXNlcklEIjoyLCJjbGFpbXMiOnt9fQ.OSgC8UWeJzQjosaiZ6rjL3T6GJbtDYAapoh6iVSV8vI';
const BASE = 'https://api.0-5.ru';
const HEADERS = { 'X-Auth-Token': TOKEN, 'X-App': '2po2' };

const STORES = { 12: '#1', 7: '#2', 11: '#3', 10: '#4', 13: '#5', 6: '#6', 14: '#7', 15: '#8', 16: '#9' };

async function fetchAllVendor(storeId) {
  const items = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${BASE}/api/v1/vendor/catalog/products?store_id=${storeId}&per_page=100&page=${page}`, { headers: HEADERS });
    const body = await res.json();
    const data = body.data ?? body;
    items.push(...(data.list ?? []));
    if (!data.has_more) break;
    page++;
  }
  return items;
}

async function main() {
  // Собираем стоп-лист по каждому магазину
  const byStore = {};

  for (const [storeIdStr, label] of Object.entries(STORES)) {
    const storeId = Number(storeIdStr);
    process.stdout.write(`Загружаю магазин ${label}… `);
    let items;
    try {
      items = await fetchAllVendor(storeId);
    } catch (e) {
      console.log(`ОШИБКА: ${e.message}`);
      continue;
    }

    const stopped = items.filter(i => i.is_blocked);
    console.log(`всего ${items.length}, в стопе: ${stopped.length}`);
    byStore[label] = stopped;
  }

  // Итог по каждому магазину
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('СТОП-ЛИСТ ПО МАГАЗИНАМ');
  console.log('═══════════════════════════════════════════════════════\n');

  for (const [label, stopped] of Object.entries(byStore)) {
    if (!stopped.length) { console.log(`Магазин ${label}: стоп-лист пуст\n`); continue; }
    console.log(`Магазин ${label} — ${stopped.length} позиций в стопе:`);
    for (const item of stopped) {
      const type = item.type === 'DRAFT' ? 'разл.' : item.type === 'BOTTLE' ? 'бут.' : item.type ?? '?';
      console.log(`  [${type}] ${item.name}`);
    }
    console.log();
  }

  // Сводка: какие товары в стопе сразу в нескольких магазинах
  const nameCount = {};
  for (const stopped of Object.values(byStore)) {
    for (const item of stopped) {
      nameCount[item.name] = (nameCount[item.name] ?? 0) + 1;
    }
  }
  const common = Object.entries(nameCount).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  if (common.length) {
    console.log('═══════════════════════════════════════════════════════');
    console.log('В СТОПЕ В НЕСКОЛЬКИХ МАГАЗИНАХ:');
    console.log('═══════════════════════════════════════════════════════');
    for (const [name, count] of common) {
      console.log(`  ${count} маг. — ${name}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
