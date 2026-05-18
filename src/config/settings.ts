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

export function isConfigured(settings: Settings): boolean {
  return Boolean(settings.storeId.trim() && settings.authToken.trim());
}

export function operatorFromSettings(settings: Settings): string {
  return settings.phoneNumber ? `${settings.countryCode}${settings.phoneNumber}` : '';
}
