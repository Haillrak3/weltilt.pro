import './style.css';

// Apply saved theme immediately to avoid flash
if (localStorage.getItem('orderdesk_theme') === 'light') {
  document.documentElement.dataset.theme = 'light';
}
import { setRender } from './render/trigger';
import { renderApp, triggerZoneDetection } from './render/app';
import { loadCategories } from './data/categories';
import { loadOrdersFromServer, migrateOrderSeqNums } from './data/orders';
import { loadLocalProductsFromServer } from './data/vendor';
import { loadCountries } from './data/countries';
import { loadStoresList } from './data/stores';
import { openSettings } from './ui/settings';
import { isConfigured, operatorFromSettings, loadSettings, loadSharedSettingsFromServer, saveSettings } from './config/settings';
import { state } from './state';
import { saveOrderMeta } from './storage';
import { isAuthorized, showAuthScreen, syncOperatorNames, ensureServerSession } from './auth';
import { initMangoSse } from './ui/incoming-call';

async function boot(): Promise<void> {
  Object.assign(state.settings, loadSettings());
  if (!state.orderMeta.operator && state.settings.phoneNumber) {
    state.orderMeta.operator = operatorFromSettings(state.settings);
    saveOrderMeta(state.orderMeta);
  }

  migrateOrderSeqNums();
  setRender(renderApp);
  renderApp();
  triggerZoneDetection(0);

  if (!isConfigured(state.settings)) {
    openSettings(false);
  } else {
    void loadCategories();
    void loadStoresList();
  }

  await ensureServerSession();

  // Если токен/магазин не настроен локально — пробуем взять с сервера
  if (!isConfigured(state.settings)) {
    const shared = await loadSharedSettingsFromServer();
    if (shared.authToken) {
      if (!state.settings.authToken) state.settings.authToken = shared.authToken;
      if (!state.settings.storeId && shared.storeId) {
        state.settings.storeId   = shared.storeId;
        state.settings.storeLabel = shared.storeLabel ?? '';
      }
      if (isConfigured(state.settings)) {
        saveSettings(state.settings);
        void loadCategories();
        void loadStoresList();
        renderApp();
      }
    }
  }

  void loadOrdersFromServer();
  void loadLocalProductsFromServer();
  void loadCountries();
  void syncOperatorNames();
}

if (isAuthorized()) {
  void boot();
  initMangoSse();
} else {
  showAuthScreen(() => { void boot(); initMangoSse(); });
}
