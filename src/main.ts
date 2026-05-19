import './style.css';

// Apply saved theme immediately to avoid flash
if (localStorage.getItem('orderdesk_theme') === 'light') {
  document.documentElement.dataset.theme = 'light';
}
import { setRender } from './render/trigger';
import { renderApp, triggerZoneDetection } from './render/app';
import { loadCategories } from './data/categories';
import { loadOrdersFromServer } from './data/orders';
import { loadLocalProductsFromServer } from './data/vendor';
import { loadCountries } from './data/countries';
import { loadStoresList } from './data/stores';
import { openSettings } from './ui/settings';
import { isConfigured, operatorFromSettings, loadSettings } from './config/settings';
import { state } from './state';
import { saveOrderMeta } from './storage';
import { isAuthorized, showAuthScreen, syncOperatorNames } from './auth';
import { initMangoSse } from './ui/incoming-call';

function boot(): void {
  Object.assign(state.settings, loadSettings());
  if (!state.orderMeta.operator && state.settings.phoneNumber) {
    state.orderMeta.operator = operatorFromSettings(state.settings);
    saveOrderMeta(state.orderMeta);
  }

  setRender(renderApp);
  renderApp();
  triggerZoneDetection(0);

  if (!isConfigured(state.settings)) {
    openSettings(false);
  } else {
    void loadCategories();
    void loadStoresList();
  }
  void loadOrdersFromServer();
  void loadLocalProductsFromServer();
  void loadCountries();
  void syncOperatorNames();
}

if (isAuthorized()) {
  boot();
  initMangoSse();
} else {
  showAuthScreen(() => { boot(); initMangoSse(); });
}
