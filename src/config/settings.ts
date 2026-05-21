const STORAGE_KEY = 'orderdesk_settings';

export interface Settings {
  storeId: string;
  storeLabel: string;
  authToken: string;
  countryCode: string;
  phoneNumber: string;
}

const defaults: Settings = {
  storeId: '',
  storeLabel: '',
  authToken: '',
  countryCode: '+7',
  phoneNumber: '',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function syncSharedSettingsToServer(settings: Settings): void {
  fetch('/desk-api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authToken: settings.authToken, storeId: settings.storeId, storeLabel: settings.storeLabel }),
  }).catch(() => {});
}

export async function loadSharedSettingsFromServer(): Promise<Partial<Pick<Settings, 'authToken' | 'storeId' | 'storeLabel'>>> {
  try {
    const res = await fetch('/desk-api/settings');
    if (!res.ok) return {};
    return await res.json() as Partial<Pick<Settings, 'authToken' | 'storeId' | 'storeLabel'>>;
  } catch { return {}; }
}

export function isConfigured(settings: Settings): boolean {
  return Boolean(settings.storeId.trim() && settings.authToken.trim());
}

export function operatorFromSettings(settings: Settings): string {
  return settings.phoneNumber ? `${settings.countryCode}${settings.phoneNumber}` : '';
}
