import { state } from '../state';
import { getAllVendorProducts } from '../api/client';
import { updateSearchDOM } from '../render/search-page';
import { saveAllStoresCache } from '../storage';

export async function loadAllStoresProducts(): Promise<void> {
  if (state.allStoresLoading || !state.storesList.length) return;
  const missing = state.storesList.filter((s) => !state.allStoresProducts.has(String(s.id)));
  if (!missing.length) return;

  state.allStoresLoading = true;
  updateSearchDOM();

  await Promise.allSettled(
    missing.map(async (shop) => {
      const id = String(shop.id);
      try {
        const all = await getAllVendorProducts(id, state.settings.authToken);
        state.allStoresProducts.set(id, all);
        saveAllStoresCache(state.allStoresProducts);
        updateSearchDOM();
      } catch { /* склад недоступен */ }
    }),
  );

  state.allStoresLoading = false;
  updateSearchDOM();
}
