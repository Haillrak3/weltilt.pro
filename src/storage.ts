import type { ClientInfo, DbClient, LocalProduct, OrderApp, OrderMeta, Product, SavedOrder } from './types';

export const LOCAL_PRODUCTS_KEY = 'orderdesk_local_products';
const CURRENT_PAGE_KEY = 'orderdesk_current_page';
export function loadCurrentPage(): string { return localStorage.getItem(CURRENT_PAGE_KEY) ?? 'products'; }
export function saveCurrentPage(page: string): void { localStorage.setItem(CURRENT_PAGE_KEY, page); }
export const EXTRA_CLIENTS_KEY = 'orderdesk_extra_clients';
export const CLIENT_KEY = 'orderdesk_client';
export const ORDER_META_KEY = 'orderdesk_order_meta';
export const ORDERS_KEY = 'orderdesk_orders';
export const ACTIVE_STORE_KEY = 'orderdesk_active_store';

export function loadActiveStoreId(): string {
  return localStorage.getItem(ACTIVE_STORE_KEY) ?? '';
}

export function saveActiveStoreId(id: string): void {
  localStorage.setItem(ACTIVE_STORE_KEY, id);
}

export function loadLocalProducts(): LocalProduct[] {
  try {
    const raw = localStorage.getItem(LOCAL_PRODUCTS_KEY);
    return raw ? (JSON.parse(raw) as LocalProduct[]) : [];
  } catch { return []; }
}

export function saveLocalProducts(list: LocalProduct[]): void {
  localStorage.setItem(LOCAL_PRODUCTS_KEY, JSON.stringify(list));
  fetch('/desk-api/local-products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  }).catch(() => {});
}

export function loadExtraClients(): DbClient[] {
  try {
    const raw = localStorage.getItem(EXTRA_CLIENTS_KEY);
    return raw ? (JSON.parse(raw) as DbClient[]) : [];
  } catch { return []; }
}

export function saveExtraClients(list: DbClient[]): void {
  localStorage.setItem(EXTRA_CLIENTS_KEY, JSON.stringify(list));
}

export function loadClient(): ClientInfo & { notes: string } {
  try {
    const raw = localStorage.getItem(CLIENT_KEY);
    const saved: Partial<ClientInfo> = raw ? JSON.parse(raw) : {};
    return { phone: '', name: '', street: '', house: '', entrance: '', floor: '', apartment: '', intercom: '', notes: '', ...saved };
  } catch {
    return { phone: '', name: '', street: '', house: '', entrance: '', floor: '', apartment: '', intercom: '', notes: '' };
  }
}

export function saveClient(info: ClientInfo & { notes?: string }): void {
  localStorage.setItem(CLIENT_KEY, JSON.stringify(info));
}

export function loadOrderMeta(): OrderMeta {
  try {
    const raw = localStorage.getItem(ORDER_META_KEY);
    return raw
      ? { orderMethod: 'phone', payMethod: 'card', operator: '', ...JSON.parse(raw) }
      : { orderMethod: 'phone', payMethod: 'card', operator: '' };
  } catch {
    return { orderMethod: 'phone', payMethod: 'card', operator: '' };
  }
}

export function saveOrderMeta(meta: OrderMeta): void {
  localStorage.setItem(ORDER_META_KEY, JSON.stringify(meta));
}

export function loadOrders(): SavedOrder[] {
  try {
    const raw = localStorage.getItem(ORDERS_KEY);
    return raw ? (JSON.parse(raw) as SavedOrder[]) : [];
  } catch { return []; }
}

export const ORDER_APP_KEY = 'orderdesk_order_app';

const ORDER_APP_DEFAULTS: OrderApp = {
  orderNumber: '',
  orderAmount: '',
  deliveryPrice: 300,
  packageQty: 1,
};

export function loadOrderApp(): OrderApp {
  try {
    const raw = localStorage.getItem(ORDER_APP_KEY);
    return raw ? { ...ORDER_APP_DEFAULTS, ...JSON.parse(raw), orderNumber: '', orderAmount: '', deliveryPrice: 300 } : { ...ORDER_APP_DEFAULTS };
  } catch { return { ...ORDER_APP_DEFAULTS }; }
}

export function saveOrderApp(data: OrderApp): void {
  localStorage.setItem(ORDER_APP_KEY, JSON.stringify(data));
}

export const ORDER_MODE_KEY = 'orderdesk_order_mode';

export function loadOrderMode(): 'phone' | 'app' {
  return localStorage.getItem(ORDER_MODE_KEY) === 'app' ? 'app' : 'phone';
}

export function saveOrderMode(mode: 'phone' | 'app'): void {
  localStorage.setItem(ORDER_MODE_KEY, mode);
}

export function saveOrders(orders: SavedOrder[]): void {
  fetch('/desk-api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orders),
  }).catch(() => {});
}

// ── Кэш товаров ─────────────────────────────────────────────────────────────

const ALL_STORES_CACHE_KEY = 'orderdesk_allstores_cache';
const ALL_STORES_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 ч

const PRODUCTS_CACHE_TTL = 60 * 60 * 1000; // 1 ч

function productsCacheKey(storeId: string): string {
  return `orderdesk_products_${storeId}`;
}

/** Загружает кэш всех складов для поиска. Возвращает пустую Map если кэш устарел или отсутствует. */
export function loadAllStoresCache(): Map<string, Product[]> {
  try {
    const raw = localStorage.getItem(ALL_STORES_CACHE_KEY);
    if (!raw) return new Map();
    const parsed: { ts: number; stores: Record<string, Product[]> } = JSON.parse(raw);
    if (Date.now() - parsed.ts > ALL_STORES_CACHE_TTL) return new Map();
    return new Map(Object.entries(parsed.stores));
  } catch { return new Map(); }
}

/** Сохраняет все склады в кэш. Молча игнорирует ошибки квоты. */
export function saveAllStoresCache(map: Map<string, Product[]>): void {
  try {
    const stores: Record<string, Product[]> = {};
    map.forEach((products, storeId) => { stores[storeId] = products; });
    localStorage.setItem(ALL_STORES_CACHE_KEY, JSON.stringify({ ts: Date.now(), stores }));
  } catch { /* QuotaExceededError — не критично */ }
}

/** Загружает кэш товаров по категориям для конкретного магазина. */
export function loadProductsCache(storeId: string): Map<number, Product[]> {
  try {
    const raw = localStorage.getItem(productsCacheKey(storeId));
    if (!raw) return new Map();
    const parsed: { ts: number; categories: [number, Product[]][] } = JSON.parse(raw);
    if (Date.now() - parsed.ts > PRODUCTS_CACHE_TTL) return new Map();
    return new Map(parsed.categories);
  } catch { return new Map(); }
}

/** Сохраняет кэш товаров по категориям для конкретного магазина. */
export function saveProductsCache(storeId: string, map: Map<number, Product[]>): void {
  try {
    const categories: [number, Product[]][] = [...map.entries()];
    localStorage.setItem(productsCacheKey(storeId), JSON.stringify({ ts: Date.now(), categories }));
  } catch { /* QuotaExceededError — не критично */ }
}
