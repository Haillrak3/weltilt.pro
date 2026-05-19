import type { Category, Product } from './types';
import { lookupCountry } from './data/countries';

export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Форматирует телефон в маску 8 (XXX) XXX-XX-XX. Всегда возвращает минимум '8'. */
export function formatPhone(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (!d) return '8';
  if (d[0] === '7') d = '8' + d.slice(1);
  else if (d[0] !== '8') d = '8' + d;
  d = d.slice(0, 11);
  let r = '';
  for (let i = 0; i < d.length; i++) {
    if      (i === 0) r += d[i];
    else if (i === 1) r += ' (' + d[i];
    else if (i === 4) r += ') ' + d[i];
    else if (i === 7) r += '-' + d[i];
    else if (i === 9) r += '-' + d[i];
    else              r += d[i];
  }
  return r;
}

export function isOutOfStock(p: Product): boolean {
  if (p.availability === 'OUT_OF_STOCK') return true;
  if (p.available_qty != null && p.available_qty <= 0) return true;
  return false;
}

export function unitPrice(product: Product, _draftVolume?: number): number {
  const base = product.price ?? 0;
  return product.product_type === 'WEIGHT' ? base * 10 : base;
}

export function formatPrice(product: Product): string {
  if (product.product_type === 'WEIGHT') {
    if (product.price != null) return `${(product.price * 10).toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽/кг`;
    return '—';
  }
  if (product.formatted_price) return product.formatted_price;
  if (product.price != null) return `${product.price.toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽`;
  return '—';
}

export function getBeerStrength(product: Product): string {
  if (product.product_type !== 'DRAFT' && product.product_type !== 'BOTTLED') return '';
  return product.properties?.find((p) => p.code === 'KREPOST')?.value ?? '';
}

export function getProductWeight(product: Product): string {
  if (product.product_type !== 'PIECE') return '';
  return product.properties?.find((p) => p.code === 'VES')?.value ?? '';
}

export function formatProductName(product: Product): string {
  const parts: string[] = [];
  const strength = getBeerStrength(product);
  if (strength) parts.push(strength);
  if (product.product_type === 'BOTTLED') {
    const vol = product.properties?.find((p) => p.code === 'OBYEM')?.value;
    if (vol) parts.push(vol);
  }
  const weight = getProductWeight(product);
  if (weight) parts.push(weight);
  const name = escapeHtml(product.name);
  return parts.length ? `${name} <span class="strength">${escapeHtml(parts.join(' '))}</span>` : name;
}

export function getCountry(product: Product): string {
  const fromProps = product.properties?.find((p) => /стран/i.test(p.name))?.value ?? '';
  return fromProps || lookupCountry(product.name);
}

export function isImport(product: Product): boolean {
  const c = getCountry(product);
  return Boolean(c) && !/россия|россий/i.test(c);
}

export function formatProductDetails(product: Product): string {
  if (product.product_type === 'BOTTLED') return product.properties?.find((p) => p.code === 'OBYEM')?.value ?? '';
  if (product.product_type === 'PIECE') return product.properties?.find((p) => p.code === 'VES')?.value ?? '';
  return '';
}

export function formatQty(qty?: number): string {
  if (qty == null) return '—';
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
}

export function sortCategories(list: Category[]): Category[] {
  return [...list].sort((a, b) => {
    const pa = a.position ?? 0, pb = b.position ?? 0;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name, 'ru');
  });
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

export function dayKeyGMT3(isoDate: string): string {
  const d = new Date(new Date(isoDate).getTime() + 3 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function todayGMT3(): string { return dayKeyGMT3(new Date().toISOString()); }
export function yesterdayGMT3(): string { return dayKeyGMT3(new Date(Date.now() - 86400000).toISOString()); }

export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function flatten(s: string): string {
  return s.replace(/[\s.,\-/]/g, '');
}

export function fuzzyMatch(name: string, query: string): boolean {
  const n = normalize(name), q = normalize(query).trim();
  if (!q) return true;
  if (n.includes(q)) return true;
  // "перерва 26к2" matches "Перерва, 26 к.2" after stripping spaces/punctuation
  if (flatten(n).includes(flatten(q))) return true;
  const words = n.split(/\s+/);
  return q.split(/\s+/).every((token) => {
    if (words.some((w) => w.includes(token))) return true;
    if (token.length < 3) return false;
    return words.some((w) => editDistance(w.slice(0, token.length + 1), token) <= 1);
  });
}

