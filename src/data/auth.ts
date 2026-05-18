import { getStores } from '../api/client';
import { loadSettings, saveSettings } from '../config/settings';
import { formatShopOptionLabel } from '../utils/shop';
import type { Settings } from '../config/settings';

/** Сохраняет токен, телефон и (если не задан) первый магазин. Возвращает обновлённые настройки. */
export async function completeSignIn(
  countryCode: string,
  phoneNumber: string,
  token: string,
): Promise<Settings> {
  const settings = loadSettings();
  settings.authToken = token;
  settings.countryCode = countryCode;
  settings.phoneNumber = phoneNumber;
  if (!settings.storeId) {
    try {
      const shops = await getStores(token);
      if (shops[0]) {
        settings.storeId = String(shops[0].id);
        settings.storeLabel = formatShopOptionLabel(shops[0]);
      }
    } catch { }
  }
  saveSettings(settings);
  return settings;
}
