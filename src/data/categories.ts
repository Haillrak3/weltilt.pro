import { ApiError, getAllProducts, getCategories, getSubcategories, triggerServerWarmup } from '../api/client';
import { saveProductsCache } from '../storage';
import { state } from '../state';
import { render } from '../render/trigger';
import { isConfigured } from '../config/settings';
import { sortCategories } from '../utils';
import { NO_CATEGORY_ID, PENDING_ID, LOCAL_CATEGORY_ID } from '../types';
import { loadVendorProducts, loadPendingProducts } from './vendor';
import { updatePrefetchStatusDOM } from '../render/products-panel';

const ALL_STORE_IDS = ['2', '4', '5', '6', '7', '9'];

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

  // Фаза 2: собираем список некэшированных ID, показываем прогресс
  const toLoad: number[] = [];
  for (const node of state.categories) {
    if (!state.productsCache.has(node.category.id)) toLoad.push(node.category.id);
    for (const sub of node.subcategories ?? []) {
      if (!state.productsCache.has(sub.id)) toLoad.push(sub.id);
    }
  }

  state.prefetchTotal = toLoad.length;
  state.prefetchDone = 0;
  updatePrefetchStatusDOM();

  await Promise.all(toLoad.map(async (id) => {
    try {
      const list = await getAllProducts(storeId, id, authToken);
      state.productsCache.set(id, list);
    } catch { /* skip */ }
    state.prefetchDone++;
    updatePrefetchStatusDOM();
  }));

  saveProductsCache(storeId, state.productsCache);
  state.prefetchTotal = 0;
  updatePrefetchStatusDOM();
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
    state.productsLoading = false;
    render();
    try {
      const fresh = await getAllProducts(state.activeStoreId, categoryId, state.settings.authToken);
      const qtyMap = new Map(fresh.map((p) => [p.id, p.available_qty]));
      cached.forEach((p) => { p.available_qty = qtyMap.get(p.id); });
      if (state.selectedSubcategoryId === categoryId) render();
    } catch { /* остатки не обновились */ }
    return;
  }
  state.products = [];
  state.productsLoading = true;
  render();
  try {
    const list = await getAllProducts(state.activeStoreId, categoryId, state.settings.authToken);
    state.productsCache.set(categoryId, list);
    if (state.selectedSubcategoryId === categoryId) state.products = list;
  } catch (e) {
    state.productsError = e instanceof ApiError ? e.message : 'Не удалось загрузить товары';
    state.products = [];
  } finally {
    state.productsLoading = false;
    render();
  }
}
