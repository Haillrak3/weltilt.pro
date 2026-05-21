import { state } from '../state';
import { escapeHtml, formatProductName, formatPrice, formatQty, isOutOfStock, fuzzyMatch, getCountry, isImport } from '../utils';
import { NO_CATEGORY_ID, PENDING_ID, LOCAL_CATEGORY_ID } from '../types';
import { localToProduct, moderatedToProduct } from '../data/vendor';
import { isConfigured } from '../config/settings';
import { formatShopOptionLabel } from '../utils/shop';
import { DELIVERY_ZONES } from '../data/zones';
import type { Product } from '../types';
import type { ModeratedProduct } from '../api/types';

// Кэш дедублированного списка всех товаров для поиска.
// Продукты мутируются in-place при обновлении остатков, поэтому ссылки всегда актуальны.
// Инвалидируется при изменении числа загруженных категорий или своих товаров.
let _searchAllCache: Product[] | null = null;
let _searchAllCacheSize = 0;

function getSearchAllProducts(): Product[] {
  const cacheSize = state.productsCache.size + state.localProducts.length;
  if (_searchAllCache && _searchAllCacheSize === cacheSize) return _searchAllCache;
  const seen = new Set<number>();
  const all: Product[] = [];
  state.productsCache.forEach((list) => {
    list.forEach((p) => { if (!seen.has(p.id)) { seen.add(p.id); all.push(p); } });
  });
  state.localProducts.forEach((lp) => {
    const p = localToProduct(lp);
    if (!seen.has(p.id)) { seen.add(p.id); all.push(p); }
  });
  _searchAllCache = all;
  _searchAllCacheSize = cacheSize;
  return all;
}

// Подстрока из API (адрес или название) → отображаемый номер
// Поправь подстроки под реальные названия из API
const PINNED_NUMS = ['2', '4', '5', '6', '7', '9'];

const STORE_LABELS: Array<{ match: string; num: string }> = [
  { match: 'Новомарьинская',  num: '1' },
  { match: 'Краснодонская',   num: '2' },
  { match: 'Братиславская, 13', num: '3' },
  { match: 'Братиславская, 29', num: '4' },
  { match: 'Новочеркасский', num: '5' },
  { match: 'Домодедовская',   num: '6' },
  { match: 'Паромная',        num: '7' },
  { match: 'Перерва',         num: '8' },
  { match: 'Кантемировская',  num: '9' },
];

export function storeDisplayNum(label: string): string | null {
  const lower = label.toLowerCase();
  const entry = STORE_LABELS.find((e) => lower.includes(e.match.toLowerCase()));
  return entry ? entry.num : null;
}

function storeZoneLabel(): string {
  if (!state.detectedZone) return '';
  const km = state.detectedZoneKm;
  if (km !== null) {
    return `Не входит в зону доставки · Ближайшая: ${state.detectedZone} · ${km.toLocaleString('ru-RU')} км`;
  }
  return state.detectedZone;
}

export function renderStoreZoneInfo(): string {
  if (state.detectedZoneLoading) {
    return '<div id="store-zone-info" class="store-zone-badge store-zone-badge-loading">Определяю зону…</div>';
  }
  if (!state.detectedZone) return '<div id="store-zone-info"></div>';
  const isOut = state.detectedZoneKm !== null;
  const zone = isOut ? null : DELIVERY_ZONES.find((z) => z.title === state.detectedZone);
  const color = zone?.color ?? 'var(--error)';
  const cls = isOut ? 'store-zone-badge store-zone-badge-out' : 'store-zone-badge';
  return `<div id="store-zone-info" class="${cls}" style="border-color:${color};color:${color}">${escapeHtml(storeZoneLabel())}</div>`;
}

export function renderStorePicker(): string {
  const { storesList, activeStoreId, storesLoading, storesExpanded } = state;
  if (!storesList.length) {
    return storesLoading
      ? '<div class="store-picker"><span class="store-picker-loading">Загрузка складов…</span></div>'
      : '';
  }

  const btn = (id: string, num: string, label: string) => {
    const active = activeStoreId === id ? ' active' : '';
    return `<button type="button" class="store-btn${active}" data-store-id="${escapeHtml(id)}" title="${escapeHtml(label)}">${escapeHtml(num)}</button>`;
  };

  const pinnedMap = new Map<string, string>(); // num → html
  const extra: string[] = [];

  storesList.forEach((shop) => {
    const id = String(shop.id);
    const label = formatShopOptionLabel(shop);
    const num = storeDisplayNum(label) ?? label;
    const html = btn(id, num, label);
    if (PINNED_NUMS.includes(num)) pinnedMap.set(num, html);
    else extra.push(html);
  });

  const pinned = [...PINNED_NUMS]
    .filter((num) => pinnedMap.has(num))
    .map((num) => pinnedMap.get(num)!);

  let extraHtml = '';
  if (extra.length) {
    extraHtml = storesExpanded
      ? extra.join('') + `<button type="button" class="store-more-btn" id="btn-stores-collapse">▲</button>`
      : `<button type="button" class="store-more-btn" id="btn-stores-expand">Ещё ▾</button>`;
  }

  const zoneInfo = renderStoreZoneInfo();
  return `<div class="store-picker">${zoneInfo}<div class="store-picker-label">Выберите магазин</div>${pinned.join('')}${extraHtml}</div>`;
}

const DRAFT_VOLUMES = [0.5, 1, 1.5] as const;

export function renderTiles(products: Product[]): string {
  // Один проход по корзине: карты для draft и обычных товаров
  const draftCartMap = new Map<number, Map<number, number>>();
  const regularCartMap = new Map<number, number>();
  for (const item of state.cart) {
    if (item.draftVolume !== undefined) {
      let volMap = draftCartMap.get(item.product.id);
      if (!volMap) { volMap = new Map(); draftCartMap.set(item.product.id, volMap); }
      volMap.set(item.draftVolume, (volMap.get(item.draftVolume) ?? 0) + item.qty);
    } else {
      regularCartMap.set(item.product.id, (regularCartMap.get(item.product.id) ?? 0) + item.qty);
    }
  }

  return `<div class="product-grid">${products.map((p) => {
    const oos = isOutOfStock(p);
    const isDraft = p.product_type === 'DRAFT';
    const isBeerType = isDraft || p.product_type === 'BOTTLED';
    const stil = isBeerType ? p.properties?.find((pr) => pr.code === 'STIL')?.value : undefined;
    const country = isBeerType ? getCountry(p) : '';
    const showCountry = country && !/россия|россий/i.test(country);
    const draftVolMap = isDraft ? (draftCartMap.get(p.id) ?? new Map<number, number>()) : null;
    const draftBtns = isDraft
      ? `<div class="draft-controls">${DRAFT_VOLUMES.map((v) => {
          const liters = draftVolMap!.get(v) ?? 0;
          const count = liters > 0 ? Math.round(liters / v) : 0;
          const isChanged = lastDraftClick?.id === p.id && lastDraftClick?.vol === v;
          const animClass = isChanged
            ? (lastDraftClick!.action === 'add' ? ' draft-step-count--pop' : ' draft-step-count--shrink')
            : '';
          return `
          <div class="draft-vol-group">
            <div class="draft-vol-label">${v} л</div>
            <div class="draft-vol-stepper">
              <button type="button" class="draft-step-btn draft-step-rm" data-draft-rm-id="${p.id}" data-draft-vol="${v}">−</button>
              <span class="draft-step-count${count > 0 ? ' draft-step-count--active' : ''}${animClass}">${count}</span>
              <button type="button" class="draft-step-btn draft-step-add" data-draft-id="${p.id}" data-draft-vol="${v}">+</button>
            </div>
          </div>`;
        }).join('')}</div>`
      : '';
    const totalDraftL = isDraft && draftVolMap
      ? [...draftVolMap.values()].reduce((s, v) => s + v, 0)
      : 0;
    const cartQty = isDraft ? totalDraftL : (regularCartMap.get(p.id) ?? 0);
    const cartBadge = cartQty > 0 ? `<div class="tile-cart-badge">${escapeHtml(formatQty(cartQty))}${isDraft ? ' л' : ''}</div>` : '';
    const priceStr = escapeHtml(formatPrice(p));
    const priceHtml = oos
      ? `<span class="oos-label">Нет в наличии</span><span class="oos-price">${priceStr}</span>`
      : priceStr;
    return `
    <div class="product-tile${oos ? ' tile-oos' : ''}${isDraft ? ' tile-draft' : ''}" data-add-id="${p.id}">
      <button type="button" class="tile-info-btn" data-info-id="${p.id}">?</button>
      ${cartBadge}
      <div class="tile-name">${formatProductName(p)}</div>
      ${stil || showCountry ? `<div class="tile-stil">${stil ? escapeHtml(stil) : ''}${stil && showCountry ? ' · ' : ''}${showCountry ? escapeHtml(country) : ''}</div>` : ''}
      <div class="tile-price">${priceHtml}</div>
      <div class="tile-stock">${oos ? '' : 'Остаток: ' + escapeHtml(formatQty(p.available_qty))}</div>
      ${draftBtns}
    </div>`;
  }).join('')}</div>`;
}

export function renderLocalTiles(): string {
  const items = state.localProducts;
  if (!items.length) {
    return '<p class="panel-status">Нет своих товаров</p>';
  }
  const cartQtyMap = new Map<number, number>();
  for (const item of state.cart) {
    if (item.draftVolume === undefined)
      cartQtyMap.set(item.product.id, (cartQtyMap.get(item.product.id) ?? 0) + item.qty);
  }
  return `<div class="product-grid">${items.map((lp) => {
    const isEditing = state.editingLocalProductId === lp.id;
    const priceStr = lp.price
      ? lp.productType === 'WEIGHT'
        ? `${lp.price.toLocaleString('ru-RU')} ₽/кг`
        : `${lp.price.toLocaleString('ru-RU')} ₽`
      : '—';
    const lpProduct = localToProduct(lp);
    const cartQty = cartQtyMap.get(lpProduct.id) ?? 0;
    const cartBadge = cartQty > 0 ? `<div class="tile-cart-badge">${escapeHtml(formatQty(cartQty))}</div>` : '';
    const editPriceInput = isEditing
      ? `<div class="tile-edit-row" onclick="event.stopPropagation()">
           <input type="text" inputmode="decimal" class="tile-edit-price-input" data-local-edit-id="${escapeHtml(lp.id)}" value="${escapeHtml(state.localEditPrice)}" placeholder="Цена" />
           <button type="button" class="tile-edit-save-btn" data-local-edit-save="${escapeHtml(lp.id)}" title="Сохранить">✓</button>
         </div>`
      : '';
    return `
      <div class="product-tile tile-local${isEditing ? ' tile-editing' : ''}" data-local-id="${escapeHtml(lp.id)}" draggable="${isEditing ? 'false' : 'true'}">
        <button type="button" class="tile-del-btn" data-local-del="${escapeHtml(lp.id)}" title="Удалить">✕</button>
        <button type="button" class="tile-edit-btn" data-local-edit="${escapeHtml(lp.id)}" title="Редактировать цену">✎</button>
        <span class="tile-drag-handle" title="Перетащить">⠿</span>
        ${cartBadge}
        <div class="tile-name">${escapeHtml(lp.name)}</div>
        <div class="tile-price">${escapeHtml(priceStr)}</div>
        ${editPriceInput}
        <div class="tile-stock"></div>
      </div>`;
  }).join('')}</div>`;
}

export function renderPendingTiles(items: ModeratedProduct[]): string {
  const cartQtyMap = new Map<number, number>();
  for (const item of state.cart) {
    if (item.draftVolume === undefined)
      cartQtyMap.set(item.product.id, (cartQtyMap.get(item.product.id) ?? 0) + item.qty);
  }
  return `<div class="product-grid">${items.map((item) => {
    const product = moderatedToProduct(item);
    const isRejected = item.status === 'REJECTED';
    const statusClass = isRejected ? 'rejected-label' : 'pending-label';
    const statusLabel = isRejected ? 'Отклонён' : 'На модерации';
    const cartQty = cartQtyMap.get(product.id) ?? 0;
    const cartBadge = cartQty > 0
      ? `<div class="tile-cart-badge">${escapeHtml(formatQty(cartQty))}</div>`
      : '';
    const priceStr = product.price != null
      ? `${product.price.toLocaleString('ru-RU')} ₽`
      : '—';
    const qtyHtml = item.formatted_qty ? `Кол-во: ${escapeHtml(item.formatted_qty)}` : '';
    return `<div class="product-tile tile-pending${isRejected ? ' tile-rejected' : ''}" data-add-id="${product.id}">
      ${cartBadge}
      <div class="tile-name">${escapeHtml(item.name.trim())}</div>
      <div class="tile-price">
        <span class="${statusClass}">${statusLabel}</span>
        <span class="pending-price">${escapeHtml(priceStr)}</span>
      </div>
      <div class="tile-stock">${qtyHtml}</div>
    </div>`;
  }).join('')}</div>`;
}

export function renderLocalProductForm(): string {
  const { name, price, productType } = state.localProductForm;
  const typeOptions = [
    { val: 'PIECE', label: 'Штучный' },
    { val: 'WEIGHT', label: 'Весовой (цена за кг)' },
    { val: 'DRAFT', label: 'Разливное' },
    { val: 'BOTTLED', label: 'Бутылочное' },
  ];
  return `
    <div class="local-product-form">
      <h3 class="local-form-title">Новый товар</h3>
      <label class="client-field">
        <span>Название <span class="local-required">*</span></span>
        <input type="text" id="lpf-name" class="client-input" placeholder="Название товара" value="${escapeHtml(name)}" />
      </label>
      <label class="client-field">
        <span>Цена, ₽</span>
        <input type="text" inputmode="decimal" id="lpf-price" class="client-input" placeholder="0" value="${escapeHtml(price)}" />
      </label>
      <label class="client-field">
        <span>Тип</span>
        <select id="lpf-type" class="client-input">
          ${typeOptions.map((o) => `<option value="${o.val}"${productType === o.val ? ' selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </label>
      <div class="local-form-actions">
        <button type="button" class="btn btn-primary" id="btn-local-save">Сохранить</button>
        <button type="button" class="btn btn-ghost" id="btn-local-cancel">Отмена</button>
      </div>
    </div>`;
}

let lastDraftClick: { id: number; vol: number; action: 'add' | 'rm' } | null = null;

export function setLastDraftClick(id: number, vol: number, action: 'add' | 'rm'): void {
  lastDraftClick = { id, vol, action };
  setTimeout(() => { lastDraftClick = null; }, 0);
}

function renderPrefetchStatus(): string {
  const { prefetchTotal, prefetchDone } = state;
  if (!prefetchTotal) return '';
  const pct = Math.round((prefetchDone / prefetchTotal) * 100);
  return `
    <div class="prefetch-status">
      <span class="search-spinner"></span>
      Кэшируем товары: ${prefetchDone} / ${prefetchTotal}
      <div class="prefetch-bar"><div class="prefetch-bar-fill" style="width:${pct}%"></div></div>
    </div>`;
}

export function updatePrefetchStatusDOM(): void {
  const el = document.getElementById('prefetch-status');
  if (el) el.innerHTML = renderPrefetchStatus();
}

export function renderProducts(): string {
  const statusEl = '<div id="prefetch-status">' + renderPrefetchStatus() + '</div>';

  if (!isConfigured(state.settings)) {
    return statusEl + '<p class="panel-status">Настройте подключение, чтобы видеть товары</p>';
  }

  const q = state.searchQuery.trim();

  if (q) {
    const all = getSearchAllProducts();
    const filtered = all.filter((p) => fuzzyMatch(p.name, q));
    const filteredModerated = state.pendingProducts.filter((p) => fuzzyMatch(p.name.trim(), q));
    if (!filtered.length && !filteredModerated.length) {
      return statusEl + `<p class="panel-status">Ничего не найдено по «${escapeHtml(q)}»</p>`;
    }
    let html = filtered.length ? renderTiles(filtered) : '';
    if (filteredModerated.length) {
      html += `<div class="moderated-search-section">${renderPendingTiles(filteredModerated)}</div>`;
    }
    return statusEl + html;
  }

  if (!state.selectedSubcategoryId) {
    return statusEl + '<p class="panel-status">Выберите категорию или подкатегорию</p>';
  }

  if (state.selectedSubcategoryId === LOCAL_CATEGORY_ID) {
    const addBtn = state.showLocalProductForm
      ? ''
      : '<div class="local-add-bar"><button type="button" class="btn btn-primary" id="btn-local-add">+ Добавить товар</button></div>';
    const formHtml = state.showLocalProductForm ? renderLocalProductForm() : '';
    return statusEl + addBtn + formHtml + renderLocalTiles();
  }

  if (state.selectedSubcategoryId === PENDING_ID) {
    const items = state.pendingProducts;
    if (!items.length) {
      return statusEl + (state.pendingProductsLoading
        ? '<p class="panel-status">Загрузка…</p>'
        : '<p class="panel-status">Нет позиций в обработке</p>');
    }
    const PAGE_SIZE = 30;
    const totalPages = Math.ceil(items.length / PAGE_SIZE);
    const page = Math.min(state.pendingPage, totalPages - 1);
    const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const nav = `<div class="pending-pagination">
      <button type="button" class="btn btn-ghost" id="btn-pending-prev"${page === 0 ? ' disabled' : ''}>←</button>
      <span class="pending-page-label">${page + 1} / ${totalPages} (${items.length})</span>
      <button type="button" class="btn btn-ghost" id="btn-pending-next"${page >= totalPages - 1 ? ' disabled' : ''}>→</button>
    </div>`;
    return statusEl + nav + renderPendingTiles(pageItems);
  }

  if (state.selectedSubcategoryId === NO_CATEGORY_ID) {
    const nocat = state.vendorProducts.filter((p) => !p.subcategory);
    if (!nocat.length) {
      return statusEl + (state.vendorProductsLoading
        ? '<p class="panel-status">Загрузка…</p>'
        : '<p class="panel-status">Нет товаров без категории</p>');
    }
    return statusEl + renderTiles(nocat);
  }

  if (state.productsLoading) {
    return statusEl + '<p class="panel-status">Загрузка товаров…</p>';
  }
  if (state.productsError) {
    return statusEl + `<p class="panel-status error">${escapeHtml(state.productsError)}</p>`;
  }

  const catId = state.selectedSubcategoryId;
  const inStockIds = new Set(state.products.map((p) => p.id));
  const oosExtra = state.vendorProducts.filter(
    (p) => p.subcategory?.id === catId && isOutOfStock(p) && !inStockIds.has(p.id),
  );

  let products = [...state.products, ...oosExtra];

  if (!products.length) {
    return statusEl + '<p class="panel-status">В этой подкатегории нет товаров</p>';
  }

  const hasBeer = products.some((p) => p.product_type === 'DRAFT' || p.product_type === 'BOTTLED');
  const hasImport = hasBeer && products.some((p) => isImport(p));
  const filterBar = hasImport
    ? `<div class="product-filter-bar"><button type="button" class="product-filter-btn${state.filterImport ? ' active' : ''}" id="btn-filter-import">Импорт</button></div>`
    : '';

  if (state.filterImport && hasBeer) {
    products = products.filter((p) => isImport(p));
  }

  return statusEl + filterBar + (products.length ? renderTiles(products) : '<p class="panel-status">Нет импортных товаров</p>');
}
