import { state } from '../state';
import { render } from '../render/trigger';
import type { CountryEntry } from '../types';

export async function loadCountries(): Promise<void> {
  try {
    const res = await fetch('/desk-api/countries');
    if (!res.ok) return;
    state.countries = await res.json() as CountryEntry[];
    render();
  } catch { }
}

export async function saveCountries(list: CountryEntry[]): Promise<void> {
  state.countries = list;
  await fetch('/desk-api/countries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  });
  render();
}

export function lookupCountry(productName: string): string {
  const lower = productName.toLowerCase();
  return state.countries.find((e) => lower.includes(e.keyword.toLowerCase()))?.country ?? '';
}
