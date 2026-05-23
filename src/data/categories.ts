import { ApiError, getAllProducts, getCategories, getSubcategories, triggerServerWarmup } from '../api/client';
import type { Product } from '../api/types';
import { saveProductsCache } from '../storage';
import { state } from '../state';
import { render } from '../render/trigger';
import { isConfigured } from '../config/settings';
import { sortCategories } from '../utils';
import { NO_CATEGORY_ID, PENDING_ID, LOCAL_CATEGORY_ID } from '../types';
import { loadVendorProducts, loadPendingProducts } from './vendor';
import { updatePrefetchStatusDOM, invalidateSearchCache } from '../render/products-panel';

const ALL_STORE_IDS = ['2', '4', '5', '6', '7', '9'];

// Поля которые обновляются при каждом запросе; остальное (name, description, image…) берётся из кэша
const VOLATILE: (keyof Product)[] = ['price', 'original_price', 'formatted_price', 'available_qty', 'availability', 'is_blocked', 'status'];

/** Мерджит свежие данные с кэшем: для известных товаров обновляет только volatile-поля,
 *  новые позиции добавляются целиком, удалённые исчезают (их нет во fresh).
 *  Если fresh пустой — возвращает cached без изменений (защита от пустого ответа сервера). */
function patchProducts(cached: Product[], fresh: Product[]): Product[] {
  if (!fresh.length) return cached;
  const byId = new Map(cached.map(p => [p.id, p]));
  return fresh.map(fp => {
    const cp = byId.get(fp.id);
    if (!cp) return fp;
    const patched = { ...cp };
    for (const k of VOLATILE) (patched as Record<string, unknown>)[k] = fp[k];
    return patched;
  });
}

export async function loadCategories(): Promise<void> {
  if (!isConfigured(state.settings)) {
    state.categories = [];
    state.categoriesError = 'Укажите магазин и токен в настройках';
    render();
    return;
  }
  state.categoriesLoading = true;
  state.categoriesError = '';
  render();
  try {
    const list = await getCategories(state.activeStoreId, state.settings.authToken);
    state.categories = sortCategories(list).map((category) => ({
      category, subcategories: null, expanded: false, loading: false,
    }));
    void prefetchAll().then(() => triggerServerWarmup(ALL_STORE_IDS, state.settings.authToken));
    void loadVendorProducts();
    void loadPendingProducts();
  } catch (e) {
    state.categoriesError = e instanceof ApiError ? e.message : 'Не удалось загрузить категории';
    state.categories = [];
  } finally {
    state.categoriesLoading = false;
    render();
  }
}

export async function prefetchAll(): Promise<void> {
  const { authToken } = state.settings;
  const storeId = state.activeStoreId;

  // Фаза 1: подкатегории всех категорий параллельно
  await Promise.all(state.categories.map(async (node) => {
    if (node.subcategories !== null) return;
    try { node.subcategories = sortCategories(await getSubcategories(storeId, node.category.id, authToken)); }
    catch { node.subcategories = []; }
  }));

  // Фаза 2: все ID категорий — и новые (нет в кэше), и уже кэшированные
  const allIds: number[] = [];
  for (const node of state.categories) {
    allIds.push(node.category.id);
    for (const sub of node.subcategories ?? []) allIds.push(sub.id);
  }

  state.prefetchTotal = allIds.length;
  state.prefetchDone = 0;
  updatePrefetchStatusDOM();

  await Promise.all(allIds.map(async (id) => {
    try {
      const fresh = await getAllProducts(storeId, id, authToken);
      const cached = state.productsCache.get(id);
      // Для известных категорий — патчим только volatile-поля, имена сохраняем из кэша
      // Для новых категорий (нет в кэше) — берём целиком
      state.productsCache.set(id, cached ? patchProducts(cached, fresh) : fresh);
    } catch { /* skip */ }
    state.prefetchDone++;
    updatePrefetchStatusDOM();
  }));

  saveProductsCache(storeId, state.productsCache);
  state.prefetchTotal = 0;
  updatePrefetchStatusDOM();
  invalidateSearchCache();
}

export async function toggleCategory(index: number): Promise<void> {
  const node = state.categories[index];
  if (!node) return;
  if (node.expanded) { node.expanded = false; render(); return; }
  state.categories.forEach((n, i) => { if (i !== index) n.expanded = false; });
  node.expanded = true;
  void selectSubcategory(node.category.id);
  if (node.subcategories !== null) return;
  node.loading = true;
  render();
  try {
    const subs = await getSubcategories(state.activeStoreId, node.category.id, state.settings.authToken);
    node.subcategories = sortCategories(subs);
  } catch (e) {
    node.subcategories = [];
    state.categoriesError = e instanceof ApiError ? e.message : `Ошибка подкатегорий: ${node.category.name}`;
  } finally {
    node.loading = false;
    render();
  }
}

function mergeVendorProducts(categoryId: number): void {
  // Prefer allStoresProducts (loaded from server cache, always fresh) over vendorProducts
  const source = state.allStoresProducts.get(state.activeStoreId)
    ?? (state.vendorProducts.length ? state.vendorProducts : null);
  if (!source) return;
  const forCat = source.filter(vp => vp.subcategory?.id === categoryId);
  if (!forCat.length) return;
  const existingIds = new Set(state.products.map(p => p.id));
  const missing = forCat.filter(vp => !existingIds.has(vp.id));
  if (missing.length) state.products = [...state.products, ...missing];
}

export function remergeCurrentCategory(): void {
  const catId = state.selectedSubcategoryId;
  if (catId != null && catId > 0 && state.products.length > 0) mergeVendorProducts(catId);
}


export async function selectSubcategory(categoryId: number): Promise<void> {
  state.selectedSubcategoryId = categoryId;
  state.searchQuery = '';
  state.productsError = '';
  if (categoryId === NO_CATEGORY_ID || categoryId === PENDING_ID || categoryId === LOCAL_CATEGORY_ID) {
    state.products = [];
    state.productsLoading = false;
    if (categoryId === PENDING_ID) {
      state.pendingPage = 0;
      if (!state.pendingProducts.length && !state.pendingProductsLoading) void loadPendingProducts();
    }
    render();
    return;
  }
  const cached = state.productsCache.get(categoryId);
  if (cached) {
    state.products = cached;
    mergeVendorProducts(categoryId);
    state.productsLoading = false;
    render();
    try {
      const fresh = await getAllProducts(state.activeStoreId, categoryId, state.settings.authToken);
      if (state.selectedSubcategoryId === categoryId) {
        const patched = patchProducts(cached, fresh);
        state.productsCache.set(categoryId, patched);
        state.products = patched;
        mergeVendorProducts(categoryId);
        render();
      }
    } catch { /* volatile не обновились */ }
    return;
  }
  state.products = [];
  state.productsLoading = true;
  render();
  try {
    const list = await getAllProducts(state.activeStoreId, categoryId, state.settings.authToken);
    state.productsCache.set(categoryId, list);
    if (state.selectedSubcategoryId === categoryId) {
      state.products = list;
      mergeVendorProducts(categoryId);
    }
  } catch (e) {
    state.productsError = e instanceof ApiError ? e.message : 'Не удалось загрузить товары';
    state.products = [];
  } finally {
    state.productsLoading = false;
    render();
  }
}
