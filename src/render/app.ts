import { state } from '../state';
import { saveClient, saveOrderMeta, saveOrderApp, saveOrderMode } from '../storage';
import { saveSettings } from '../config/settings';
import { openMangoAdmin } from '../ui/mango-admin';
import { runAsAdmin, getOperatorName } from '../auth';
import { escapeHtml, formatPhone, todayGMT3, yesterdayGMT3, debounce, formatQty, formatPrice } from '../utils';
import { NO_CATEGORY_ID, PENDING_ID, LOCAL_CATEGORY_ID } from '../types';
import type { SavedOrder } from '../types';

import { renderCartItems, renderCartFooter, renderClientForm, renderOrderMeta, renderAppMode } from './cart-panel';
import { renderCategoryTree } from './categories-panel';
import { renderProducts, renderStorePicker, renderStoreZoneInfo, storeDisplayNum, setLastDraftClick } from './products-panel';
import { renderOrdersPage } from './orders-page';
import { renderAnalyticsPage } from './analytics-page';
import { renderRefsPage } from './refs-page';
import { renderSearchPage, updateSearchDOM, buildStoreNumMap } from './search-page';
import { renderAppOrdersPage } from './app-orders-page';
import { saveCountries } from '../data/countries';

import { newOrder, createOrder, loadOrderToCart, changeOrderStatus, changeOrderStore,
  removeOrder, restoreOrder, permanentDeleteOrder, toggleOrderExpand, changeOrderItemQty, setOrderItemQty, removeOrderItem,
  loadOrdersFromServer } from '../data/orders';
import { openClientHistoryModal } from '../ui/order-preview-modal';
import { addToCart, addDraftWithTara, removeDraftWithTara, changeCartQty, removeFromCart, roundQty, getCartSum } from '../data/cart';
import { loadCategories, toggleCategory, selectSubcategory } from '../data/categories';
import { getAllProducts, getAppOrders } from '../api/client';
import { selectStore } from '../data/stores';
import { loadAllStoresProducts } from '../data/all-stores-search';
import { addLocalProduct, deleteLocalProduct, localToProduct, moderatedToProduct, reorderLocalProduct, updateLocalProduct } from '../data/vendor';
import { searchClients, findClientByPhone, getClientAddresses, getAllClientPhones, addAddressToClient } from '../data/clients';
import { openClientModal } from '../ui/client-modal';
import { openProductModal, findProductInCache } from '../ui/product-modal';
import { showOrderReceipt } from '../ui/receipt';
import { showToast } from '../ui/toast';
import { geocodeAddress, detectZones, nearestZone } from '../utils/geo';

const app = document.querySelector<HTMLDivElement>('#app')!;

// Закрывать попап телефона при клике вне него (один раз, не накапливается)
document.addEventListener('click', () => {
  document.querySelectorAll('.order-phone-popup').forEach(p => p.remove());
});

// Делегированный обработчик для кнопки остатков — вешается один раз, работает после любого updateSearchDOM()
document.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>('.tile-stock-btn');
  if (!btn) return;
  e.stopPropagation();
  const productId = Number(btn.dataset.stockId);
  void showStockPopup(btn, productId);
});

const THEME_KEY = 'orderdesk_theme';
function isLightTheme(): boolean { return localStorage.getItem(THEME_KEY) === 'light'; }
function applyTheme(light: boolean): void {
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, light ? 'light' : 'dark');
}

function parseNum(v: string): number { return Number(v.replaceAll(',', '.')); }

let zoneDebounceTimer = 0;
let dragLocalId: string | null = null;

function updateZoneBadgeDOM(): void {
  const storeEl = document.getElementById('store-zone-info');
  if (storeEl) storeEl.outerHTML = renderStoreZoneInfo();
}

function animateTile(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  el.classList.remove('tile-added');
  void el.offsetWidth; // force reflow so animation restarts if clicked rapidly
  el.classList.add('tile-added');
  setTimeout(() => el.classList.remove('tile-added'), 280);
}



export function triggerZoneDetection(debounce = 600): void {
  clearTimeout(zoneDebounceTimer);
  zoneDebounceTimer = window.setTimeout(async () => {
    const { street, house } = state.client;
    const key = `${street}|${house}`;
    if (!street || !house) {
      state.zoneGeoKey = key;
      state.detectedZone = '';
      state.detectedZoneKm = null;
      state.detectedZoneLoading = false;
      updateZoneBadgeDOM();
      return;
    }
    if (key === state.zoneGeoKey) return;
    state.zoneGeoKey = key;
    state.detectedZone = '';
    state.detectedZoneKm = null;
    state.detectedZoneLoading = true;
    updateZoneBadgeDOM();
    const coords = await geocodeAddress(street, house);
    state.detectedZoneLoading = false;
    if (coords) {
      const zones = detectZones(coords.lon, coords.lat);
      if (zones.length) {
        state.detectedZone = zones[0].title;
        state.detectedZoneKm = null;
        const numMatch = zones[0].title.match(/доставки (\d+) магазин/);
        if (numMatch) {
          const targetNum = numMatch[1];
          const { formatShopOptionLabel } = await import('../utils/shop');
          const match = state.storesList.find((s) => storeDisplayNum(formatShopOptionLabel(s)) === targetNum);
          if (match) selectStore(String(match.id));
        }
      } else {
        const nearest = nearestZone(coords.lon, coords.lat);
        state.detectedZone = nearest.zone.title;
        state.detectedZoneKm = Math.round(nearest.distanceKm * 10) / 10;
      }
    } else {
      state.detectedZone = '';
      state.detectedZoneKm = null;
    }
    updateZoneBadgeDOM();
  }, debounce);
}

// ── Попап остатков по магазинам ───────────────────────────────────────────────
let _stockPopupEl: HTMLDivElement | null = null;

function getStockPopupEl(): HTMLDivElement {
  if (!_stockPopupEl) {
    _stockPopupEl = document.createElement('div');
    _stockPopupEl.className = 'stock-popup';
    _stockPopupEl.style.display = 'none';
    document.body.appendChild(_stockPopupEl);
    document.addEventListener('click', () => { if (_stockPopupEl) _stockPopupEl.style.display = 'none'; });
  }
  return _stockPopupEl;
}

function positionPopup(popup: HTMLElement, btn: HTMLElement): void {
  const rect = btn.getBoundingClientRect();
  popup.style.display = 'block';
  const pw = popup.offsetWidth;
  const ph = popup.offsetHeight;
  let left = rect.right - pw;
  let top  = rect.bottom + 4;
  if (left < 4) left = 4;
  if (top + ph > window.innerHeight - 4) top = rect.top - ph - 4;
  popup.style.left = `${left + window.scrollX}px`;
  popup.style.top  = `${top  + window.scrollY}px`;
}

async function showStockPopup(btn: HTMLElement, productId: number): Promise<void> {
  const popup = getStockPopupEl();
  const storeNumMap = buildStoreNumMap();

  // Find which stores have this product and its subcategory id
  const storeEntries: Array<{ storeId: string; num: string; categoryId: number }> = [];
  let categoryId = 0;
  state.allStoresProducts.forEach((products, storeId) => {
    const p = products.find((x) => x.id === productId);
    if (!p) return;
    const num = storeNumMap.get(storeId) ?? storeId;
    if (!categoryId && p.subcategory?.id) categoryId = p.subcategory.id;
    storeEntries.push({ storeId, num, categoryId: p.subcategory?.id ?? 0 });
  });

  if (!storeEntries.length) { popup.style.display = 'none'; return; }

  // Show loading immediately
  popup.innerHTML = `<div class="stock-popup-title">Остаток по магазинам</div><div class="stock-popup-loading">Загрузка…</div>`;
  positionPopup(popup, btn);

  // Fetch real quantities per store in parallel
  const results = await Promise.allSettled(
    storeEntries.map(async ({ storeId, num, categoryId: catId }) => {
      const cid = catId || categoryId;
      if (!cid) return { num, qty: undefined as number | undefined, price: '', inStock: false };
      const products = await getAllProducts(storeId, cid, state.settings.authToken);
      const found = products.find((x) => x.id === productId);
      const qty = found?.available_qty ?? undefined;
      const price = found ? formatPrice(found) : '';
      const inStock = found != null && (found.available_qty == null || found.available_qty > 0);
      return { num, qty, price, inStock };
    }),
  );

  const rows = results
    .filter((r): r is PromiseFulfilledResult<{ num: string; qty: number | undefined; price: string; inStock: boolean }> => r.status === 'fulfilled')
    .map((r) => r.value)
    .sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));

  popup.innerHTML = `
    <div class="stock-popup-title">Остаток по магазинам</div>
    ${rows.map((r) => `
      <div class="stock-popup-row${r.inStock ? '' : ' stock-popup-row--oos'}">
        <span class="stock-popup-num">№${escapeHtml(r.num)}</span>
        <span class="stock-popup-qty">${r.qty != null ? `${escapeHtml(formatQty(r.qty))} шт` : r.inStock ? 'есть' : '—'}</span>
        ${r.price ? `<span class="stock-popup-price">${escapeHtml(r.price)}</span>` : ''}
      </div>`).join('')}`;
  positionPopup(popup, btn);
}

function bindEvents(): void {
  const searchEl = document.getElementById('product-search') as HTMLInputElement | null;
  const debouncedSearch = debounce(renderApp, 300);
  searchEl?.addEventListener('input', () => { state.searchQuery = searchEl.value; debouncedSearch(); });


  document.querySelectorAll<HTMLButtonElement>('.cart-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.cartTab = btn.dataset.tab as typeof state.cartTab;
      renderApp();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.mode-btn[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const newMode = btn.dataset.mode as 'phone' | 'app';
      if (state.orderMode === newMode) return;

      const hasPhone = state.client.phone.replace(/\D/g, '').length >= 7;
      const hasCartItems = state.cart.length > 0;
      if (hasCartItems && hasPhone && !confirm('Корзина будет очищена. Продолжить?')) return;

      state.orderMode = newMode;
      saveOrderMode(newMode);
      state.cart = [];
      if (newMode === 'phone') state.appOrderLinked = null;
      if (newMode === 'app') {
        const pkg = state.localProducts.find((lp) => /пакет/i.test(lp.name));
        if (pkg) {
          if (state.orderApp.packageQty < 1) state.orderApp.packageQty = 1;
          state.cart.push({ product: localToProduct(pkg), qty: state.orderApp.packageQty });
          saveOrderApp(state.orderApp);
        }
      }
      renderApp();
    });
  });

  document.getElementById('btn-app-client-expand')?.addEventListener('click', () => {
    state.appClientExpanded = !state.appClientExpanded;
    renderApp();
  });

  document.querySelectorAll<HTMLButtonElement>('.meta-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { metaGroup, metaVal } = btn.dataset;
      if (!metaGroup || !metaVal) return;
      (state.orderMeta as unknown as Record<string, string>)[metaGroup] = metaVal;
      saveOrderMeta(state.orderMeta);
      renderApp();
    });
  });

  const suggestions = searchClients(state.client.phone);
  document.querySelectorAll<HTMLLIElement>('.client-suggestion').forEach((li) => {
    li.addEventListener('click', () => {
      const idx = Number(li.dataset.suggestIdx);
      const s = suggestions[idx];
      if (!s) return;
      Object.assign(state.client, {
        phone: formatPhone(s.phone), name: s.name, street: s.street, house: s.house,
        entrance: s.entrance, floor: s.floor, apartment: s.apartment,
        intercom: s.intercom, notes: s.notes,
      });
      state.clientSuggestHidden = true;
      saveClient(state.client);
      renderApp();
      triggerZoneDetection();
    });
  });

  // ── Единая кнопка инфо о клиенте ──────────────────────────────────────────
  document.getElementById('btn-client-info')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.clientInfoPanel = state.clientInfoPanel ? null : 'menu';
    renderApp();
  });

  document.getElementById('btn-ci-phones')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.clientInfoPanel = 'phones';
    renderApp();
  });

  document.getElementById('btn-ci-history')?.addEventListener('click', () => {
    state.clientInfoPanel = null;
    openClientHistoryModal(state.client.phone);
  });

  document.getElementById('btn-ci-addresses')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.clientInfoPanel = 'addresses';
    renderApp();
  });

  document.querySelectorAll<HTMLButtonElement>('.addr-dd-item[data-phone-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const digits = state.client.phone.replace(/\D/g, '');
      const client = findClientByPhone(digits);
      if (!client) return;
      const idx = Number(btn.dataset.phoneIdx);
      const norm = getAllClientPhones(client)[idx];
      if (!norm) return;
      state.client.phone = formatPhone(norm) || norm;
      state.clientInfoPanel = null;
      saveClient(state.client);
      renderApp();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.addr-dd-item[data-addr-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const digits = state.client.phone.replace(/\D/g, '');
      const client = findClientByPhone(digits);
      if (!client) return;
      const idx = Number(btn.dataset.addrIdx);
      if (idx === -1) {
        Object.assign(state.client, { street: '', house: '', entrance: '', floor: '', apartment: '', intercom: '' });
      } else {
        const addr = getClientAddresses(client)[idx];
        if (addr) Object.assign(state.client, { street: addr.street, house: addr.house, entrance: addr.entrance, floor: addr.floor, apartment: addr.apartment, intercom: addr.intercom });
      }
      state.clientInfoPanel = null;
      saveClient(state.client);
      renderApp();
      triggerZoneDetection();
    });
  });

  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.client-input').forEach((el) => {
    el.addEventListener('input', () => {
      const key = (el as HTMLElement).dataset.cl;
      if (!key) return;
      if (key === 'phone' && el instanceof HTMLInputElement) el.value = formatPhone(el.value);
      (state.client as unknown as Record<string, string>)[key] = el.value;
      if (key === 'phone') {
        const digits = el.value.replace(/\D/g, '');
        const found = digits.length === 11 ? findClientByPhone(digits) : null;
        if (found) {
          Object.assign(state.client, {
            name: found.name, street: found.street, house: found.house,
            entrance: found.entrance, floor: found.floor,
            apartment: found.apartment, intercom: found.intercom, notes: found.notes ?? '',
          });
          state.clientSuggestHidden = true;
        } else {
          state.clientSuggestHidden = false;
        }
        saveClient(state.client);
        if (found) triggerZoneDetection();
        renderApp();
      } else {
        const persistedKeys = ['name','street','house','entrance','floor','apartment','intercom'];
        if (persistedKeys.includes(key)) saveClient(state.client);
        if (key === 'street' || key === 'house') triggerZoneDetection();
      }
    });
  });

  document.getElementById('btn-save-addr')?.addEventListener('click', () => {
    const c = state.client;
    void addAddressToClient(c.phone, {
      street: c.street.trim(), house: c.house.trim(), entrance: c.entrance.trim(),
      floor: c.floor.trim(), apartment: c.apartment.trim(), intercom: c.intercom.trim(),
    }).then(updated => {
      if (updated) { showToast('Адрес сохранён'); renderApp(); }
      else showToast('Не удалось сохранить адрес');
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.store-btn').forEach((btn) => {
    btn.addEventListener('click', () => { if (btn.dataset.storeId) selectStore(btn.dataset.storeId); });
  });
  document.getElementById('btn-stores-expand')?.addEventListener('click', () => { state.storesExpanded = true; renderApp(); });
  document.getElementById('btn-stores-collapse')?.addEventListener('click', () => { state.storesExpanded = false; renderApp(); });
  document.getElementById('btn-mango-admin')?.addEventListener('click', () => void runAsAdmin(() => openMangoAdmin()));

  document.getElementById('mango-op-select')?.addEventListener('change', async (e) => {
    const phone = (e.target as HTMLSelectElement).value;
    if (!phone) return;
    try {
      await fetch('/desk-api/mango/bind-operator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      state.mangoMyPhone = phone;
      state.orderMeta.operator = phone;
      saveOrderMeta(state.orderMeta);
      renderApp();
    } catch { /* ignore */ }
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    sessionStorage.removeItem('orderdesk_auth');
    await fetch('/desk-api/auth/session', { method: 'DELETE' }).catch(() => {});
    state.settings.authToken = '';
    saveSettings(state.settings);
    location.reload();
  });
  document.getElementById('btn-reload')?.addEventListener('click', () => { void loadCategories(); });
  (document.getElementById('theme-toggle') as HTMLInputElement | null)
    ?.addEventListener('change', (e) => { applyTheme((e.target as HTMLInputElement).checked); });
  document.getElementById('btn-create-order')?.addEventListener('click', () => createOrder());
  document.getElementById('btn-cancel-edit')?.addEventListener('click', () => {
    state.editingOrderId = null;
    state.cart = [];
    state.currentPage = 'orders';
    renderApp();
  });
  document.getElementById('tab-products')?.addEventListener('click', () => { state.currentPage = 'products'; newOrder(); });
  document.getElementById('tab-orders')?.addEventListener('click', () => { state.currentPage = 'orders'; renderApp(); void loadOrdersFromServer(); });

  document.querySelectorAll<HTMLButtonElement>('.mob-nav-btn[data-mob-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mobilePanel = btn.dataset.mobPanel as typeof state.mobilePanel;
      renderApp();
    });
  });
  document.getElementById('tab-analytics')?.addEventListener('click', () => { state.currentPage = 'analytics'; renderApp(); });

  document.querySelectorAll<HTMLButtonElement>('[data-an-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.analyticsTab = btn.dataset.anTab as typeof state.analyticsTab;
      renderApp();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-an-period]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.analyticsPeriod = btn.dataset.anPeriod as typeof state.analyticsPeriod;
      renderApp();
    });
  });
  document.getElementById('tab-refs')?.addEventListener('click', () => { state.currentPage = 'refs'; renderApp(); });
  document.getElementById('tab-search')?.addEventListener('click', () => {
    state.currentPage = 'search';
    renderApp();
    void loadAllStoresProducts();
  });

  document.getElementById('tab-app-orders')?.addEventListener('click', () => {
    state.currentPage = 'app-orders';
    void loadAppOrders();
  });

  document.getElementById('ao-refresh-btn')?.addEventListener('click', () => { void loadAppOrders(); });

  document.querySelectorAll<HTMLButtonElement>('.ao-deliver-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const num = btn.dataset.aoDeliver;
      const order = state.appOrders.find((o) => o.number === num);
      if (!order) return;

      const totalQty = order.cart_products.reduce((s, p) =>
        s + (p.pack_item && p.pack_item.volume > 0 ? p.qty : 0.5), 0);
      const totalLiters = order.cart_products.reduce((s, p) =>
        s + (p.pack_item && p.pack_item.volume > 0 ? p.qty * p.pack_item.volume : 0), 0);
      const packages = Math.max(
        Math.ceil(totalQty / 7),
        totalLiters > 0 ? Math.ceil(totalLiters / 7) : 0,
        1,
      );

      const rawPhone = order.user.phone_number.country_code + order.user.phone_number.phone_number;
      state.appOrderLinked = order.number;
      state.client.phone = formatPhone(rawPhone) || rawPhone;
      saveClient(state.client);
      state.orderApp.orderNumber = order.number.slice(-6);
      state.orderApp.orderAmount = String(order.total_price);
      state.orderApp.packageQty = packages;
      saveOrderApp(state.orderApp);
      state.orderMode = 'app';
      saveOrderMode('app');
      state.cart = [];
      const pkg = state.localProducts.find((lp) => /пакет/i.test(lp.name));
      if (pkg) state.cart.push({ product: localToProduct(pkg), qty: packages });
      state.currentPage = 'products';
      renderApp();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-ao-period]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.appOrdersPeriod = btn.dataset.aoPeriod as typeof state.appOrdersPeriod;
      void loadAppOrders();
    });
  });


  (document.getElementById('search-all-input') as HTMLInputElement | null)?.addEventListener('input', (e) => {
    state.searchAllQuery = (e.target as HTMLInputElement).value;
    updateSearchDOM();
  });

  (document.getElementById('refs-search') as HTMLInputElement | null)?.addEventListener('input', (e) => {
    state.refsClientSearch = (e.target as HTMLInputElement).value;
    state.refsPage = 0;
    renderApp();
  });

  document.getElementById('refs-prev-page')?.addEventListener('click', () => {
    if (state.refsPage > 0) { state.refsPage--; renderApp(); }
  });
  document.getElementById('refs-next-page')?.addEventListener('click', () => {
    state.refsPage++;
    renderApp();
  });

  document.getElementById('btn-countries-toggle')?.addEventListener('click', () => {
    state.countriesExpanded = !state.countriesExpanded;
    renderApp();
  });

  document.getElementById('btn-country-add')?.addEventListener('click', () => {
    const kw = (document.getElementById('country-keyword') as HTMLInputElement | null)?.value.trim();
    const cn = (document.getElementById('country-name') as HTMLInputElement | null)?.value.trim();
    if (!kw || !cn) return;
    void saveCountries([...state.countries, { keyword: kw, country: cn }]);
  });

  document.querySelectorAll<HTMLButtonElement>('.country-del-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.countryIdx);
      void saveCountries(state.countries.filter((_, i) => i !== idx));
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.refs-client-row[data-refs-phone]').forEach((btn) => {
    btn.addEventListener('click', () => openClientModal(btn.dataset.refsPhone ?? ''));
  });

  const renderKeepOrdersScroll = () => {
    const el = document.querySelector<HTMLElement>('.orders-main');
    const top = el?.scrollTop ?? 0;
    renderApp();
    document.querySelector<HTMLElement>('.orders-main')?.scrollTo({ top, behavior: 'instant' });
  };

  document.getElementById('of-all')?.addEventListener('click', () => {
    state.ordersFilterFrom = ''; state.ordersFilterTo = ''; renderKeepOrdersScroll();
  });
  document.getElementById('of-today')?.addEventListener('click', () => {
    const t = todayGMT3(); state.ordersFilterFrom = t; state.ordersFilterTo = t; renderKeepOrdersScroll();
  });
  document.getElementById('of-yesterday')?.addEventListener('click', () => {
    const y = yesterdayGMT3(); state.ordersFilterFrom = y; state.ordersFilterTo = y; renderKeepOrdersScroll();
  });
  (document.getElementById('of-from') as HTMLInputElement | null)?.addEventListener('change', (e) => {
    state.ordersFilterFrom = (e.target as HTMLInputElement).value; renderKeepOrdersScroll();
  });
  (document.getElementById('of-to') as HTMLInputElement | null)?.addEventListener('change', (e) => {
    state.ordersFilterTo = (e.target as HTMLInputElement).value; renderKeepOrdersScroll();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-filter-store]').forEach((btn) => {
    btn.addEventListener('click', () => { state.ordersFilterStore = btn.dataset.filterStore!; renderKeepOrdersScroll(); });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-filter-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.ordersFilterStatus = btn.dataset.filterStatus! as SavedOrder['status'] | '';
      renderKeepOrdersScroll();
    });
  });

  document.getElementById('btn-filter-attention')?.addEventListener('click', () => {
    state.ordersFilterAttention = !state.ordersFilterAttention;
    renderKeepOrdersScroll();
  });

  document.querySelectorAll<HTMLButtonElement>('.order-store-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { orderId, storeId } = btn.dataset;
      if (orderId && storeId) changeOrderStore(orderId, storeId);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.order-status-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { orderId, orderNext } = btn.dataset;
      if (orderId && orderNext) changeOrderStatus(orderId, orderNext as SavedOrder['status']);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.order-expand-btn').forEach((btn) => {
    btn.addEventListener('click', () => { if (btn.dataset.orderId) toggleOrderExpand(btn.dataset.orderId); });
  });

  // Телефон в заказе — показать инлайн-попап с кнопкой обратного звонка
  document.querySelectorAll<HTMLButtonElement>('.order-phone-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = btn.parentElement?.querySelector('.order-phone-popup');
      document.querySelectorAll('.order-phone-popup').forEach(p => p.remove());
      if (existing) return; // второй клик по тому же — закрыть

      const phone = btn.dataset.phone ?? '';
      const popup = document.createElement('span');
      popup.className = 'order-phone-popup';
      popup.innerHTML = `<button type="button" class="order-callback-btn" data-phone="${phone.replace(/"/g, '&quot;')}">&#128222; Обратный звонок</button>`;
      btn.after(popup);

      popup.querySelector('.order-callback-btn')?.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const cbBtn = popup.querySelector('.order-callback-btn') as HTMLButtonElement;
        cbBtn.disabled = true;
        cbBtn.textContent = '…';
        try {
          const digits = phone.replace(/\D/g, '');
          const operatorPhone = (state.orderMeta.operator || sessionStorage.getItem('orderdesk_auth') || state.settings.phoneNumber).replace(/\D/g, '');
          const res = await fetch('/desk-api/mango/callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: digits, operatorPhone }),
          });
          const data = await res.json() as { ok?: boolean; error?: string };
          popup.remove();
          if (res.ok) showToast('Звонок инициирован');
          else showToast(`Ошибка: ${data.error ?? res.status}`);
        } catch {
          popup.remove();
          showToast('Ошибка соединения с сервером');
        }
      });
    });
  });


  document.getElementById('btn-mango-callback')?.addEventListener('click', async () => {
    const phone = state.client.phone.replace(/\D/g, '');
    if (phone.length < 7) return;
    const btn = document.getElementById('btn-mango-callback') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const operatorPhone = (state.orderMeta.operator || sessionStorage.getItem('orderdesk_auth') || state.settings.phoneNumber).replace(/\D/g, '');
      const res = await fetch('/desk-api/mango/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, operatorPhone }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (res.ok) showToast('Звонок инициирован');
      else showToast(`Ошибка: ${data.error ?? res.status}`);
    } catch {
      showToast('Ошибка соединения с сервером');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📞'; }
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.order-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => { if (btn.dataset.orderId) loadOrderToCart(btn.dataset.orderId); });
  });

  document.querySelectorAll<HTMLButtonElement>('.order-receipt-btn, .ch-receipt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const order = state.orders.find((o) => o.id === btn.dataset.orderId);
      if (order) showOrderReceipt(order);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.order-del-btn:not(.order-perm-del-btn)').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.orderId) removeOrder(btn.dataset.orderId);
    });
  });

  document.getElementById('btn-show-trash')?.addEventListener('click', () => {
    state.ordersShowTrash = true; renderKeepOrdersScroll();
  });
  document.getElementById('btn-trash-back')?.addEventListener('click', () => {
    state.ordersShowTrash = false; renderKeepOrdersScroll();
  });

  document.querySelectorAll<HTMLButtonElement>('.order-restore-btn').forEach((btn) => {
    btn.addEventListener('click', () => { if (btn.dataset.orderId) restoreOrder(btn.dataset.orderId); });
  });
  document.querySelectorAll<HTMLButtonElement>('.order-perm-del-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.orderId && confirm('Удалить заказ навсегда? Это действие необратимо.')) permanentDeleteOrder(btn.dataset.orderId);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-oitem-dec]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { orderId, itemIdx } = btn.dataset;
      if (orderId && itemIdx != null) changeOrderItemQty(orderId, Number(itemIdx), -1);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-oitem-inc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { orderId, itemIdx } = btn.dataset;
      if (orderId && itemIdx != null) changeOrderItemQty(orderId, Number(itemIdx), 1);
    });
  });

  document.querySelectorAll<HTMLInputElement>('[data-oitem-qty]').forEach((input) => {
    input.addEventListener('change', () => {
      const { orderId, itemIdx } = input.dataset;
      if (orderId && itemIdx != null) setOrderItemQty(orderId, Number(itemIdx), parseNum(input.value));
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-oitem-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { orderId, itemIdx } = btn.dataset;
      if (orderId && itemIdx != null) removeOrderItem(orderId, Number(itemIdx));
    });
  });

  document.getElementById('btn-no-category')?.addEventListener('click', () => {
    state.categories.forEach((n) => { n.expanded = false; });
    void selectSubcategory(NO_CATEGORY_ID);
  });

  document.getElementById('btn-pending')?.addEventListener('click', () => {
    state.categories.forEach((n) => { n.expanded = false; });
    void selectSubcategory(PENDING_ID);
  });

  document.getElementById('btn-pending-prev')?.addEventListener('click', () => {
    if (state.pendingPage > 0) { state.pendingPage--; renderApp(); }
  });

  document.getElementById('btn-pending-next')?.addEventListener('click', () => {
    const totalPages = Math.ceil(state.pendingProducts.length / 30);
    if (state.pendingPage < totalPages - 1) { state.pendingPage++; renderApp(); }
  });

  document.getElementById('btn-local-products')?.addEventListener('click', () => {
    state.categories.forEach((n) => { n.expanded = false; });
    state.showLocalProductForm = false;
    void selectSubcategory(LOCAL_CATEGORY_ID);
  });

  document.getElementById('btn-filter-import')?.addEventListener('click', () => {
    state.filterImport = !state.filterImport;
    renderApp();
  });

  document.getElementById('btn-local-add')?.addEventListener('click', () => {
    state.showLocalProductForm = true;
    renderApp();
  });

  document.getElementById('btn-local-cancel')?.addEventListener('click', () => {
    state.showLocalProductForm = false;
    state.localProductForm = { name: '', price: '', productType: 'PIECE' };
    renderApp();
  });

  document.getElementById('btn-local-save')?.addEventListener('click', addLocalProduct);

  (document.getElementById('lpf-name') as HTMLInputElement | null)?.addEventListener('input', (e) => {
    state.localProductForm.name = (e.target as HTMLInputElement).value;
  });
  (document.getElementById('lpf-price') as HTMLInputElement | null)?.addEventListener('input', (e) => {
    state.localProductForm.price = (e.target as HTMLInputElement).value;
  });
  (document.getElementById('lpf-type') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    state.localProductForm.productType = (e.target as HTMLSelectElement).value;
  });

  document.querySelectorAll<HTMLButtonElement>('.tile-del-btn[data-local-del]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.dataset.localDel) deleteLocalProduct(btn.dataset.localDel);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.tile-edit-btn[data-local-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.localEdit!;
      const lp = state.localProducts.find((x) => x.id === id);
      if (!lp) return;
      state.editingLocalProductId = state.editingLocalProductId === id ? null : id;
      state.localEditPrice = state.editingLocalProductId ? String(lp.price) : '';
      renderApp();
      if (state.editingLocalProductId) {
        setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>(`.tile-edit-price-input[data-local-edit-id="${id}"]`);
          input?.focus();
          input?.select();
        }, 0);
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.tile-edit-price-input').forEach((input) => {
    input.addEventListener('input', (e) => {
      state.localEditPrice = (e.target as HTMLInputElement).value;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const id = input.dataset.localEditId!;
        const price = parseFloat(state.localEditPrice.replace(',', '.'));
        if (!isNaN(price)) updateLocalProduct(id, price);
      } else if (e.key === 'Escape') {
        state.editingLocalProductId = null;
        state.localEditPrice = '';
        renderApp();
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.tile-edit-save-btn[data-local-edit-save]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.localEditSave!;
      const price = parseFloat(state.localEditPrice.replace(',', '.'));
      if (!isNaN(price)) updateLocalProduct(id, price);
    });
  });

  document.querySelectorAll<HTMLDivElement>('.product-tile[data-local-id]').forEach((tile) => {
    tile.addEventListener('click', () => {
      const localId = tile.dataset.localId;
      const lp = state.localProducts.find((x) => x.id === localId);
      if (lp) {
        addToCart(localToProduct(lp));
        if (state.orderMode === 'phone') state.cartTab = 'cart';
        animateTile(`.product-tile[data-local-id="${localId}"]`);
      }
    });

    tile.addEventListener('dragstart', (e) => {
      dragLocalId = tile.dataset.localId ?? null;
      e.dataTransfer!.effectAllowed = 'move';
      setTimeout(() => tile.classList.add('tile-dragging'), 0);
    });
    tile.addEventListener('dragend', () => {
      tile.classList.remove('tile-dragging');
      document.querySelectorAll('.tile-drag-over').forEach((el) => el.classList.remove('tile-drag-over'));
    });
    tile.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (tile.dataset.localId !== dragLocalId) tile.classList.add('tile-drag-over');
    });
    tile.addEventListener('dragleave', () => tile.classList.remove('tile-drag-over'));
    tile.addEventListener('drop', (e) => {
      e.preventDefault();
      tile.classList.remove('tile-drag-over');
      const toId = tile.dataset.localId;
      if (dragLocalId && toId && dragLocalId !== toId) reorderLocalProduct(dragLocalId, toId);
    });
  });

  document.querySelectorAll('.cat-parent').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = Number((btn as HTMLButtonElement).dataset.catIndex);
      void toggleCategory(index);
    });
  });

  document.querySelectorAll('.sub-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number((btn as HTMLButtonElement).dataset.subId);
      void selectSubcategory(id);
    });
  });

  const findProduct = (id: number) => {
    const fromCache = findProductInCache(id);
    if (fromCache) return fromCache;
    const local = state.localProducts.find((lp) => localToProduct(lp).id === id);
    if (local) return localToProduct(local);
    for (const item of state.pendingProducts) {
      const p = moderatedToProduct(item);
      if (p.id === id) return p;
    }
    return state.vendorProducts.find((p) => p.id === id);
  };

  document.querySelectorAll<HTMLDivElement>('.product-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      const id = Number(tile.dataset.addId);
      const product = findProduct(id);
      if (product && product.product_type !== 'DRAFT') {
        addToCart(product);
        if (state.orderMode === 'phone') state.cartTab = 'cart';
        animateTile(`.product-tile[data-add-id="${id}"]`);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.tile-info-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const product = findProduct(Number(btn.dataset.infoId));
      if (product) openProductModal(product);
    });
  });


  document.querySelectorAll<HTMLButtonElement>('[data-draft-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const product = findProduct(Number(btn.dataset.draftId));
      const vol = Number(btn.dataset.draftVol);
      if (product && vol) {
        setLastDraftClick(product.id, vol, 'add');
        addDraftWithTara(product, vol);
        if (state.orderMode === 'phone') state.cartTab = 'cart';
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-draft-rm-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const product = findProduct(Number(btn.dataset.draftRmId));
      const vol = Number(btn.dataset.draftVol);
      if (product && vol) {
        setLastDraftClick(product.id, vol, 'rm');
        removeDraftWithTara(product, vol);
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.cart-price-input[data-cart-price]').forEach((input) => {
    input.addEventListener('change', () => {
      const index = Number(input.dataset.cartPrice);
      const item = state.cart[index];
      if (item) { item.product.price = Math.max(0, parseNum(input.value) || 0); renderApp(); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
  });

  document.querySelectorAll<HTMLInputElement>('.qty-input[data-cart-qty]').forEach((input) => {
    input.addEventListener('change', () => {
      const index = Number(input.dataset.cartQty);
      const val = Math.max(0.001, roundQty(parseNum(input.value) || 0.001));
      const item = state.cart[index];
      if (item) { item.qty = val; renderApp(); }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.qty-btn[data-cart-dec]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); });
    btn.addEventListener('click', () => changeCartQty(Number(btn.dataset.cartDec), -1));
  });

  document.querySelectorAll<HTMLButtonElement>('.qty-btn[data-cart-inc]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); });
    btn.addEventListener('click', () => changeCartQty(Number(btn.dataset.cartInc), 1));
  });

  document.querySelectorAll<HTMLButtonElement>('.cart-del[data-cart-del]').forEach((btn) => {
    btn.addEventListener('click', () => removeFromCart(Number(btn.dataset.cartDel)));
  });

  // ── Order App tab ─────────────────────────────────
  const saveOA = () => saveOrderApp(state.orderApp);

  (document.getElementById('oa-order-number') as HTMLInputElement | null)
    ?.addEventListener('input', (e) => {
      state.orderApp.orderNumber = (e.target as HTMLInputElement).value;
      saveOA();
    });

  (document.getElementById('oa-order-amount') as HTMLInputElement | null)
    ?.addEventListener('input', (e) => {
      state.orderApp.orderAmount = (e.target as HTMLInputElement).value;
      saveOA();
      updateCartTotal();
    });

  (document.getElementById('oa-delivery-price') as HTMLInputElement | null)
    ?.addEventListener('change', (e) => {
      state.orderApp.deliveryPrice = parseNum((e.target as HTMLInputElement).value) || 0;
      saveOA();
      updateCartTotal();
    });

  const updatePackage = (qty: number) => {
    qty = Math.max(1, qty);
    state.orderApp.packageQty = qty;
    saveOA();
    const pkg = state.localProducts.find((lp) => /пакет/i.test(lp.name));
    if (!pkg) return;
    const product = localToProduct(pkg);
    const isPkg = (item: { product: { id: number; name?: string } }) =>
      item.product.id === product.id || /пакет/i.test(item.product.name ?? '');
    if (qty === 0) {
      const idx = state.cart.findIndex(isPkg);
      if (idx !== -1) state.cart.splice(idx, 1);
    } else {
      const existing = state.cart.find(isPkg);
      if (existing) {
        existing.qty = qty;
        existing.product = product; // нормализуем id на случай если был 0 из БД
      } else {
        state.cart.push({ product, qty });
      }
    }
    renderApp();
  };

  (document.getElementById('oa-pkg-qty') as HTMLInputElement | null)
    ?.addEventListener('change', (e) => updatePackage(parseNum((e.target as HTMLInputElement).value)));

  document.getElementById('oa-pkg-dec')
    ?.addEventListener('click', () => updatePackage(state.orderApp.packageQty - 1));

  document.getElementById('oa-pkg-inc')
    ?.addEventListener('click', () => updatePackage(state.orderApp.packageQty + 1));

  document.addEventListener('click', (e) => {
    if (state.clientInfoPanel && !(e.target as Element).closest('.ci-wrap')) {
      state.clientInfoPanel = null;
      renderApp();
    }
  }, { once: true });
}

function renderLinkedAppOrder(): string {
  if (state.orderMode !== 'app' || !state.appOrderLinked) return '';
  const order = state.appOrders.find((o) => o.number === state.appOrderLinked);
  if (!order) return '';

  const items = order.cart_products.map((p) => {
    const pack = p.pack_item && p.pack_item.volume > 0 ? ` ${p.pack_item.volume}л` : '';
    return `<div class="linked-order-item">${escapeHtml(p.name)}${pack} × ${p.qty}</div>`;
  }).join('');

  const note = order.note
    ? `<div class="linked-order-note">${escapeHtml(order.note)}</div>`
    : '';

  return `<aside class="panel linked-order-panel">
    <div class="panel-body scroll">
      ${note}
      <div class="linked-order-items">${items}</div>
    </div>
  </aside>`;
}

async function loadAppOrders(): Promise<void> {
  state.appOrdersLoading = true;
  state.appOrdersError = '';
  renderApp();
  try {
    const page = await getAppOrders(state.appOrdersPeriod);
    state.appOrders = page.list ?? [];
    state.appOrdersTotalCount = page.total_count ?? 0;
  } catch (e) {
    state.appOrdersError = e instanceof Error ? e.message : 'Ошибка загрузки';
  } finally {
    state.appOrdersLoading = false;
    renderApp();
  }
}

function updateCartTotal(): void {
  const cartSum = getCartSum();
  const total = (parseFloat(state.orderApp.orderAmount.replaceAll(',', '.')) || 0) + state.orderApp.deliveryPrice + cartSum;
  const el = document.querySelector<HTMLElement>('.cart-total span:last-child');
  if (el) el.textContent = total.toLocaleString('ru-RU') + ' ₽';
}

export function renderApp(): void {
  const searchInput = document.getElementById('product-search') as HTMLInputElement | null;
  const hadFocus = searchInput === document.activeElement;
  const selStart = searchInput?.selectionStart ?? null;
  const selEnd = searchInput?.selectionEnd ?? null;

  const phoneInput = document.getElementById('cl-phone') as HTMLInputElement | null;
  const hadPhoneFocus = phoneInput === document.activeElement;
  const phoneSelStart = phoneInput?.selectionStart ?? null;
  const phoneSelEnd = phoneInput?.selectionEnd ?? null;

  const refsSearchInput = document.getElementById('refs-search') as HTMLInputElement | null;
  const hadRefsSearchFocus = refsSearchInput === document.activeElement;
  const refsSearchSelStart = refsSearchInput?.selectionStart ?? null;
  const refsSearchSelEnd = refsSearchInput?.selectionEnd ?? null;


  const productsScroll = document.querySelector('.products-panel .panel-body')?.scrollTop ?? 0;
  const categoriesScroll = document.querySelector('.categories-panel .panel-body')?.scrollTop ?? 0;
  const cartScroll = document.querySelector('.cart-panel .panel-body')?.scrollTop ?? 0;


  app.innerHTML = `
    <div class="shell">
      <nav class="tabs">
        <button type="button" class="tab${state.currentPage === 'products' ? ' active' : ''}" id="tab-products">Новый заказ</button>
        <button type="button" class="tab${state.currentPage === 'orders' ? ' active' : ''}" id="tab-orders">Заказы</button>
        <button type="button" class="tab${state.currentPage === 'analytics' ? ' active' : ''}" id="tab-analytics">Аналитика</button>
        <button type="button" class="tab${state.currentPage === 'refs' ? ' active' : ''}" id="tab-refs">Справочники</button>
        <button type="button" class="tab${state.currentPage === 'search' ? ' active' : ''}" id="tab-search">Поиск</button>
        <button type="button" class="tab${state.currentPage === 'app-orders' ? ' active' : ''}" id="tab-app-orders">Заказы с АПП</button>
        <div class="tabs-actions">
          <button type="button" class="btn btn-ghost" id="btn-reload">Обновить</button>
          <label class="theme-toggle" title="Светлая / тёмная тема">
            <input type="checkbox" class="theme-toggle-input" id="theme-toggle"${isLightTheme() ? ' checked' : ''}>
            <span class="theme-toggle-track">
              <span class="theme-toggle-icon theme-toggle-icon-dark">☾</span>
              <span class="theme-toggle-icon theme-toggle-icon-light">☀</span>
              <span class="theme-toggle-thumb"></span>
            </span>
          </label>
          ${state.mangoAccounts.length > 0 && !state.mangoMyPhone ? `<select class="mango-op-select" id="mango-op-select" title="Я — оператор">
            <option value="">Выберите себя...</option>
            ${state.mangoAccounts.map(a => `<option value="${escapeHtml(a.operatorPhone)}">${escapeHtml(getOperatorName(a.operatorPhone))}</option>`).join('')}
          </select>` : ''}
          <button type="button" class="btn btn-ghost" id="btn-mango-admin" title="Mango SIP настройки">Манго</button>
          <button type="button" class="btn btn-ghost btn-logout" id="btn-logout" title="Выйти из аккаунта">Выход</button>
        </div>
      </nav>

      ${state.currentPage === 'orders' ? `<main class="orders-main scroll">${renderOrdersPage()}</main>`
      : state.currentPage === 'analytics' ? `<main class="orders-main scroll">${renderAnalyticsPage()}</main>`
      : state.currentPage === 'refs' ? `<main class="orders-main scroll">${renderRefsPage()}</main>`
      : state.currentPage === 'search' ? `<main class="orders-main scroll">${renderSearchPage()}</main>`
      : state.currentPage === 'app-orders' ? `<main class="orders-main scroll">${renderAppOrdersPage()}</main>`
      : `
      <main class="workspace mob-${state.mobilePanel}">
        <aside class="panel cart-panel">
          <div class="order-mode-switcher">
            <button type="button" class="mode-btn${state.orderMode === 'phone' ? ' active' : ''}" data-mode="phone">Телефон</button>
            <button type="button" class="mode-btn${state.orderMode === 'app' ? ' active' : ''}" data-mode="app">Приложение</button>
          </div>
          ${state.orderMode === 'phone' ? `
          <nav class="cart-tabs">
            <button type="button" class="cart-tab${state.cartTab === 'cart' ? ' active' : ''}" data-tab="cart">Товары</button>
            <button type="button" class="cart-tab${state.cartTab === 'client' ? ' active' : ''}" data-tab="client">Клиент</button>
            <button type="button" class="cart-tab${state.cartTab === 'order' ? ' active' : ''}" data-tab="order">Заказ</button>
          </nav>
          <div class="panel-body scroll">
            ${state.cartTab === 'cart' ? renderCartItems()
              : state.cartTab === 'client' ? renderClientForm()
              : renderOrderMeta()}
          </div>
          ` : `
          <div class="panel-body scroll">
            ${renderAppMode()}
          </div>
          `}
          ${renderCartFooter()}
        </aside>

        ${renderLinkedAppOrder()}

        <aside class="panel categories-panel">
          <header class="panel-head">
            <h2>Категории</h2>
          </header>
          <div class="panel-body scroll cat-tree">${renderCategoryTree()}</div>
        </aside>

        <section class="panel products-panel">
          <header class="panel-head products-head">
            ${renderStorePicker()}
            <input type="search" id="product-search" class="search-input" placeholder="Поиск…" value="${escapeHtml(state.searchQuery)}" />
          </header>
          <div class="panel-body scroll">${renderProducts()}</div>
        </section>
      </main>
      <nav class="mob-nav">
        <button type="button" class="mob-nav-btn${state.mobilePanel === 'products' ? ' active' : ''}" data-mob-panel="products">
          <span class="mob-nav-icon">🔍</span>Товары
        </button>
        <button type="button" class="mob-nav-btn${state.mobilePanel === 'cats' ? ' active' : ''}" data-mob-panel="cats">
          <span class="mob-nav-icon">☰</span>Категории
        </button>
        <button type="button" class="mob-nav-btn${state.mobilePanel === 'cart' ? ' active' : ''}" data-mob-panel="cart">
          <span class="mob-nav-icon">🛒</span>Корзина${state.cart.length > 0 ? ` (${state.cart.length})` : ''}
        </button>
      </nav>`}
    </div>
  `;

  bindEvents();

  const pBody = document.querySelector('.products-panel .panel-body');
  const cBody = document.querySelector('.categories-panel .panel-body');
  const cartBody = document.querySelector('.cart-panel .panel-body');
  if (pBody) pBody.scrollTop = productsScroll;
  if (cBody) cBody.scrollTop = categoriesScroll;
  if (cartBody) cartBody.scrollTop = cartScroll;

  if (hadFocus) {
    const el = document.getElementById('product-search') as HTMLInputElement | null;
    if (el) { el.focus(); if (selStart != null) el.setSelectionRange(selStart, selEnd ?? selStart); }
  }
  if (hadPhoneFocus) {
    const el = document.getElementById('cl-phone') as HTMLInputElement | null;
    if (el) { el.focus(); if (phoneSelStart != null) el.setSelectionRange(phoneSelStart, phoneSelEnd ?? phoneSelStart); }
  }
  if (hadRefsSearchFocus) {
    const el = document.getElementById('refs-search') as HTMLInputElement | null;
    if (el) { el.focus(); if (refsSearchSelStart != null) el.setSelectionRange(refsSearchSelStart, refsSearchSelEnd ?? refsSearchSelStart); }
  }
}
