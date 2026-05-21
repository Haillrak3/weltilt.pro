#!/usr/bin/env node
// Cross-references vendor catalog availability vs public catalog available_qty
// for bottled goods across all "Еще парочку" stores.
// Looking for: OUT_OF_STOCK in vendor BUT available_qty >= 1 in public.

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySUQiOjEzLCJyb2xlIjoiTUFTVEVSX0FETUlOIiwiaW1wZXJzb25hdGVkVXNlcklEIjoyLCJjbGFpbXMiOnt9fQ.OSgC8UWeJzQjosaiZ6rjL3T6GJbtDYAapoh6iVSV8vI';
const BASE = 'https://api.0-5.ru';
const HEADERS = { 'X-Auth-Token': TOKEN, 'X-App': '2po2' };

const STORES = { 12: '#1', 7: '#2', 11: '#3', 10: '#4', 13: '#5', 6: '#6', 14: '#7', 15: '#8', 16: '#9' };
const BOTTLED_CAT = 2;

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const body = await res.json();
  // API wraps response: { success: true, data: { list, has_more, ... } }
  return body.data ?? body;
}

// Fetch ALL pages from vendor catalog for one store (bottled, including out-of-stock)
async function fetchVendorAll(storeId) {
  const items = [];
  let page = 1;
  while (true) {
    const data = await apiFetch(
      `/api/v1/vendor/catalog/products?store_id=${storeId}&category_id=${BOTTLED_CAT}&per_page=100&page=${page}`
    );
    const list = data.list ?? [];
    items.push(...list);
    if (!data.has_more) break;
    page++;
  }
  return items;
}

// Fetch ALL pages from public catalog for one store (bottled)
async function fetchPublicAll(storeId) {
  const items = [];
  let page = 1;
  while (true) {
    const data = await apiFetch(
      `/api/v1/catalog/products?store_id=${storeId}&category_id=${BOTTLED_CAT}&per_page=100&page=${page}`
    );
    const list = data.list ?? [];
    items.push(...list);
    if (!data.has_more) break;
    page++;
  }
  return items;
}

async function main() {
  const results = [];

  for (const [storeIdStr, label] of Object.entries(STORES)) {
    const storeId = Number(storeIdStr);
    process.stdout.write(`Магазин ${label} (id=${storeId})… `);

    let vendorItems, publicItems;
    try {
      [vendorItems, publicItems] = await Promise.all([
        fetchVendorAll(storeId),
        fetchPublicAll(storeId),
      ]);
    } catch (e) {
      console.log(`ОШИБКА: ${e.message}`);
      continue;
    }

    console.log(`vendor=${vendorItems.length}, public=${publicItems.length}`);

    // Build lookup: product_id → available_qty from public catalog
    const publicQty = new Map();
    for (const item of publicItems) {
      const id = item.product_id ?? item.id;
      const qty = item.available_qty ?? 0;
      if (id != null) publicQty.set(id, qty);
    }

    // Find vendor OUT_OF_STOCK items that have available_qty in public
    for (const item of vendorItems) {
      const id = item.product_id ?? item.id;
      if (item.availability !== 'OUT_OF_STOCK') continue;
      const qty = publicQty.get(id) ?? 0;
      if (qty >= 1) {
        results.push({
          store: label,
          storeId,
          id,
          name: item.name ?? item.title ?? '—',
          qty,
          vendorAvailability: item.availability,
        });
      }
    }

    // Also: vendor IN_STOCK but public has qty=0 (reverse discrepancy)
    // (not the primary question but interesting)
  }

  if (results.length === 0) {
    console.log('\n✓ Расхождений не найдено: нет бутылочных товаров с OUT_OF_STOCK + available_qty≥1');

    // Let's also show summary of what OUT_OF_STOCK items exist with any public qty
    console.log('\nПроверяем по-другому: ищем через public catalog товары с available_qty=1…');

    for (const [storeIdStr, label] of Object.entries(STORES)) {
      const storeId = Number(storeIdStr);
      try {
        const publicItems = await fetchPublicAll(storeId);
        const qty1 = publicItems.filter(i => (i.available_qty ?? 0) === 1);
        if (qty1.length > 0) {
          console.log(`\nМагазин ${label}: ${qty1.length} товар(ов) с available_qty=1`);
          for (const item of qty1) {
            console.log(`  id=${item.product_id ?? item.id} "${item.name ?? item.title}" qty=${item.available_qty} type=${item.product_type ?? '?'}`);
          }
        }
      } catch (e) {
        console.log(`Магазин ${label}: ОШИБКА ${e.message}`);
      }
    }
    return;
  }

  console.log(`\n=== НАЙДЕНО ${results.length} расхождений ===`);
  for (const r of results) {
    console.log(`Магазин ${r.store} | id=${r.id} | "${r.name}" | qty=${r.qty} | vendor=${r.vendorAvailability}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
