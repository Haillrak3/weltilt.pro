import './style.css';

// Apply saved theme immediately to avoid flash
if (localStorage.getItem('orderdesk_theme') === 'light') {
  document.documentElement.dataset.theme = 'light';
}
import { setRender } from './render/trigger';
import { renderApp, triggerZoneDetection, startAppOrdersPolling, loadAppOrders } from './render/app';
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

  // Автопривязка телефона по URL-параметру ?setup_phone=79XXXXXXXXX
  const _setupPhone = new URLSearchParams(location.search).get('setup_phone');
  if (_setupPhone) {
    const _d = _setupPhone.replace(/\D/g, '');
    const _norm = _d.startsWith('7') && _d.length === 11 ? _d.slice(1) : _d;
    if (_norm.length >= 10) {
      state.settings.phoneNumber = _norm;
      saveSettings(state.settings);
    }
    history.replaceState({}, '', location.pathname);
  }

  if (!state.orderMeta.operator && state.settings.phoneNumber) {
    state.orderMeta.operator = operatorFromSettings(state.settings);
    saveOrderMeta(state.orderMeta);
  }

  migrateOrderSeqNums();
  setRender(() => {
    const el = document.querySelector<HTMLElement>('.orders-main');
    const top = el?.scrollTop ?? 0;
    renderApp();
    if (top > 0) document.querySelector<HTMLElement>('.orders-main')?.scrollTo({ top, behavior: 'instant' });
  });
  renderApp();
  triggerZoneDetection(0);
  if (state.orderMode === 'app') { void loadAppOrders(); startAppOrdersPolling(); }

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
  void initMangoOperator();
}

async function initMangoOperator(): Promise<void> {
  try {
    const [myRes, accRes] = await Promise.all([
      fetch('/desk-api/mango/my-operator'),
      fetch('/desk-api/mango/accounts'),
    ]);
    if (accRes.ok) {
      const accounts = await accRes.json() as Array<{ operatorPhone: string }>;
      state.mangoAccounts = accounts;
    }
    if (!myRes.ok) return;
    const data = await myRes.json() as { phone?: string };
    let phone = (data.phone ?? '').replace(/\D/g, '');

    // Автопривязка если сервер ещё не знает оператора — пробуем несколько источников
    if (!phone && state.mangoAccounts.length > 0) {
      const candidates = [
        sessionStorage.getItem('orderdesk_auth') ?? '',
        state.orderMeta.operator,
        state.settings.phoneNumber ?? '',
      ].map(s => s.replace(/\D/g, '')).filter(Boolean);

      for (const candidate of candidates) {
        const matched = state.mangoAccounts.find(a => a.operatorPhone.replace(/\D/g, '') === candidate);
        if (matched) {
          await fetch('/desk-api/mango/bind-operator', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: matched.operatorPhone }),
          });
          phone = matched.operatorPhone.replace(/\D/g, '');
          break;
        }
      }
    }

    state.mangoMyPhone = phone;
    // Обновляем оператора: всегда если пришёл телефон с сервера,
    // чтобы заменить устаревший формат "имя" на телефон
    if (phone && state.orderMeta.operator.replace(/\D/g, '') !== phone) {
      state.orderMeta.operator = phone;
      saveOrderMeta(state.orderMeta);
    }
  } catch { /* mango not configured */ }
}

if (isAuthorized()) {
  void boot();
  initMangoSse();
} else {
  showAuthScreen(() => { void boot(); initMangoSse(); });
}
