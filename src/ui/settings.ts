import { openAuthModal } from './auth-modal';
import { state } from '../state';
import { saveOrderMeta } from '../storage';
import { operatorFromSettings } from '../config/settings';
import { loadCategories } from '../data/categories';
import { loadStoresList } from '../data/stores';
import { saveActiveStoreId } from '../storage';
import { render } from '../render/trigger';

export function openSettings(closeable = true): void {
  const prevPhone = operatorFromSettings(state.settings);
  openAuthModal({
    settings: state.settings,
    closeable,
    onSaved: () => {
      const newPhone = operatorFromSettings(state.settings);
      if (newPhone && (!state.orderMeta.operator || state.orderMeta.operator === prevPhone)) {
        state.orderMeta.operator = newPhone;
        saveOrderMeta(state.orderMeta);
      }
      state.selectedSubcategoryId = null;
      state.products = [];
      state.productsCache.clear();
      state.categories = [];
      state.storesList = [];
      // reset active store to the newly configured one
      state.activeStoreId = state.settings.storeId;
      saveActiveStoreId(state.activeStoreId);
      void loadStoresList();
      void loadCategories();
      render();
    },
  });
}
