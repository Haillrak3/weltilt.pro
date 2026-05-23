import { getStores } from '../api/client';
import { state } from '../state';
import { saveActiveStoreId, loadProductsCache } from '../storage';
import { render } from '../render/trigger';
import { isConfigured } from '../config/settings';
import { loadCategories } from './categories';
import { loadAllStoresProducts } from './all-stores-search';

export async function loadStoresList(): Promise<void> {
  if (!isConfigured(state.settings)) return;
  state.storesLoading = true;
  try {
    const shops = await getStores(state.settings.authToken);
    state.storesList = shops;
    void loadAllStoresProducts();
  } catch { /* fail silently — stores list is supplementary */ }
  finally { state.storesLoading = false; render(); }
}

export function selectStore(storeId: string): void {
  if (state.activeStoreId === storeId) return;
  state.activeStoreId = storeId;
  saveActiveStoreId(storeId);
  state.productsCache = loadProductsCache(storeId);
  state.products = [];
  state.selectedSubcategoryId = null;
  state.categories = [];
  void loadCategories();
}
