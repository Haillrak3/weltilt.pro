import { state } from '../state';
import { escapeHtml, formatPrice, formatQty, isOutOfStock, fuzzyMatch, formatProductName, getCountry } from '../utils';
import { storeDisplayNum, renderPendingTiles } from './products-panel';
import { formatShopOptionLabel } from '../utils/shop';
import type { Product } from '../types';

interface StoreProduct {
  product: Product;          // версия товара (предпочтительно в наличии)
  storesInStock: string[];   // склады где товар В НАЛИЧИИ
  hasStock: boolean;         // есть хотя бы в одном складе
}

export function buildStoreNumMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const shop of state.storesList) {
    const id = String(shop.id);
    map.set(id, storeDisplayNum(formatShopOptionLabel(shop)) ?? id);
  }
  return map;
}

function mergeResults(query: string): StoreProduct[] {
  const storeNumMap = buildStoreNumMap();
  const byId = new Map<number, StoreProduct>();

  state.allStoresProducts.forEach((products, storeId) => {
    const num = storeNumMap.get(storeId) ?? storeId;
    for (const p of products) {
      if (!fuzzyMatch(p.name, query)) continue;
      if (!byId.has(p.id)) {
        byId.set(p.id, { product: p, storesInStock: [], hasStock: false });
      }
      const entry = byId.get(p.id)!;
      const inStock = !isOutOfStock(p);
      if (inStock) {
        if (!entry.storesInStock.includes(num)) entry.storesInStock.push(num);
        if (!entry.hasStock || storeId === state.activeStoreId) entry.product = p;
        entry.hasStock = true;
      }
    }
  });

  return [...byId.values()].sort((a, b) =>
    (a.product.name ?? '').localeCompare(b.product.name ?? '', 'ru'),
  );
}

function renderStatus(): string {
  const loaded = state.allStoresProducts.size;
  const total = state.storesList.length;
  if (state.allStoresLoading) {
    return `<div class="search-all-status"><span class="search-spinner"></span>Загружаем склады: ${loaded} / ${total}…</div>`;
  }
  if (total > 0 && loaded < total) {
    return `<div class="search-all-status search-all-status--warn">Загружено ${loaded} из ${total} складов</div>`;
  }
  if (total > 0) {
    return `<div class="search-all-status search-all-status--ok">✓ Все ${total} склада загружены</div>`;
  }
  return '';
}

function renderResults(): string {
  const q = state.searchAllQuery.trim();
  if (q.length < 2) {
    return q.length === 1
      ? '<p class="panel-status">Введите хотя бы 2 символа</p>'
      : '<p class="panel-status">Начните вводить название товара</p>';
  }

  const results = mergeResults(q);
  const pendingMatches = state.pendingProducts.filter((p) => fuzzyMatch(p.name.trim(), q));

  if (!results.length && !pendingMatches.length) {
    return `<p class="panel-status">Ничего не найдено по «${escapeHtml(q)}»</p>`;
  }

  const pendingSection = pendingMatches.length
    ? `<div class="moderated-search-section"><div class="moderated-search-title">На модерации</div>${renderPendingTiles(pendingMatches)}</div>`
    : '';

  if (!results.length) return pendingSection;

  return `<div class="product-grid">${results.map(({ product: p, storesInStock, hasStock }) => {
    const oos = !hasStock;
    const isBeerType = p.product_type === 'DRAFT' || p.product_type === 'BOTTLED';
    const stil = isBeerType ? p.properties?.find((pr) => pr.code === 'STIL')?.value : undefined;
    const country = isBeerType ? getCountry(p) : '';
    const showCountry = Boolean(country) && !/россия|россий/i.test(country);
    const stilHtml = (stil || showCountry)
      ? `<div class="tile-stil">${stil ? escapeHtml(stil) : ''}${stil && showCountry ? ' · ' : ''}${showCountry ? escapeHtml(country) : ''}</div>`
      : '';
    const storeBadges = storesInStock
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((n) => `<span class="search-store-badge">№${escapeHtml(n)}</span>`)
      .join('');
    const cartQty = state.cart.filter((i) => i.product.id === p.id).reduce((s, i) => s + i.qty, 0);
    const cartBadge = cartQty > 0 ? `<div class="tile-cart-badge">${escapeHtml(formatQty(cartQty))}</div>` : '';
    const tileClass = oos ? ' tile-oos' : ' tile-instock';
    return `
      <div class="product-tile${tileClass}" data-add-id="${p.id}">
        ${cartBadge}
        <button type="button" class="tile-stock-btn" data-stock-id="${p.id}" title="Остатки по магазинам">≡</button>
        <div class="tile-name">${formatProductName(p)}</div>
        ${stilHtml}
        <div class="tile-price">${oos ? '<span class="oos-label">Нет в наличии</span>' : escapeHtml(formatPrice(p))}</div>
        <div class="search-store-badges">${storeBadges}</div>
      </div>`;
  }).join('')}</div>${pendingSection}`;
}

export function renderSearchPage(): string {
  return `
    <div class="search-all-page">
      <div class="search-all-header">
        <input type="search" id="search-all-input" class="search-input search-all-input"
          placeholder="Поиск по всем складам…" value="${escapeHtml(state.searchAllQuery)}" />
        <div id="search-all-status">${renderStatus()}</div>
      </div>
      <div id="search-all-results">${renderResults()}</div>
    </div>`;
}

/** Обновляет только статус и результаты, не трогая инпут */
export function updateSearchDOM(): void {
  const statusEl = document.getElementById('search-all-status');
  if (statusEl) statusEl.innerHTML = renderStatus();
  const resultsEl = document.getElementById('search-all-results');
  if (resultsEl) resultsEl.innerHTML = renderResults();
}
