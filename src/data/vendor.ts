import { getVendorCatalogProducts, getModeratedProducts } from '../api/client';
import { state } from '../state';
import { saveLocalProducts } from '../storage';
import { render } from '../render/trigger';
import { isConfigured } from '../config/settings';
import type { LocalProduct, Product } from '../types';
import type { ModeratedProduct } from '../api/types';

async function pushLocalProductsToServer(): Promise<void> {
  try {
    await fetch('/desk-api/local-products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.localProducts),
    });
  } catch { /* ignore */ }
}

export async function loadLocalProductsFromServer(): Promise<void> {
  try {
    const res = await fetch('/desk-api/local-products');
    if (!res.ok) return;
    const serverList = await res.json() as LocalProduct[];
    if (serverList.length === 0) return;
    // Server is authoritative — always use server data
    state.localProducts = serverList;
    localStorage.setItem('orderdesk_local_products', JSON.stringify(serverList));
    render();
  } catch { /* сервер недоступен — используем localStorage */ }
}

export function localToProduct(lp: LocalProduct): Product {
  const numericId = -parseInt(lp.id.replace('local_', ''), 10);
  return {
    id: numericId,
    name: lp.name,
    price: lp.productType === 'WEIGHT' ? lp.price / 10 : lp.price,
    product_type: lp.productType as Product['product_type'],
  };
}

function findVendorPrice(exchangeId: number, name: string): number | undefined {
  // 1. По exchange_product.id — точное совпадение
  for (const p of state.vendorProducts) {
    if ((p as any).exchange_product?.id === exchangeId && p.original_price != null) return p.original_price;
  }
  for (const list of state.productsCache.values()) {
    for (const p of list) {
      if ((p as any).exchange_product?.id === exchangeId && p.original_price != null) return p.original_price;
    }
  }
  // 2. По имени — fallback
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const target = norm(name);
  for (const p of state.vendorProducts) {
    if (norm(p.name) === target && p.original_price != null) return p.original_price;
  }
  for (const list of state.productsCache.values()) {
    for (const p of list) {
      if (norm(p.name) === target && p.original_price != null) return p.original_price;
    }
  }
  return undefined;
}

export function moderatedToProduct(item: ModeratedProduct): Product {
  const qtyMatch = item.formatted_qty?.match(/^([\d.,]+)/);
  const available_qty = qtyMatch ? parseFloat(qtyMatch[1].replace(',', '.')) : undefined;
  const price = findVendorPrice(item.id, item.name.trim());
  return {
    id: -(item.id + 1_000_000),
    name: item.name.trim(),
    price,
    original_price: price,
    product_type: (item.type as Product['product_type']) ?? 'PIECE',
    available_qty,
  };
}

export async function loadVendorProducts(): Promise<void> {
  if (!isConfigured(state.settings)) return;
  state.vendorProductsLoading = true;
  const { authToken } = state.settings;
  const storeId = state.activeStoreId;
  const all: Product[] = [];
  try {
    let page = 1;
    while (true) {
      const result = await getVendorCatalogProducts(storeId, page, 100, authToken);
      // Vendor API returns "type" instead of "product_type" — normalize here
      all.push(...(result.list ?? []).map(p => ({
        ...p,
        product_type: p.product_type ?? (p as unknown as Record<string, string>)['type'],
      })));
      if (!result.has_more) break;
      if (++page > 20) break;
    }
    state.vendorProducts = all;
  } catch { /* supplementary — fail silently */ }
  finally { state.vendorProductsLoading = false; render(); }
}

const MODERATED_PARTNER_ID = 2; // Алексей Лукьянец, «Еще парочку!»

export async function loadPendingProducts(): Promise<void> {
  if (!isConfigured(state.settings)) return;
  state.pendingProductsLoading = true;
  const { authToken } = state.settings;
  const all: ModeratedProduct[] = [];
  try {
    for (const status of ['PENDING', 'REJECTED'] as const) {
      let page = 1;
      while (true) {
        const result = await getModeratedProducts(MODERATED_PARTNER_ID, status, page, 100, authToken);
        all.push(...(result.list ?? []));
        if (!result.has_more) break;
        if (++page > 20) break;
      }
    }
    state.pendingProducts = all;
  } catch { /* supplementary — fail silently */ }
  finally { state.pendingProductsLoading = false; render(); }
}

export function addLocalProduct(): void {
  const { name, price, productType } = state.localProductForm;
  const trimmed = name.trim();
  if (!trimmed) return;
  const lp: LocalProduct = {
    id: `local_${Date.now()}`,
    name: trimmed,
    price: Math.max(0, parseFloat(price) || 0),
    productType,
  };
  state.localProducts.push(lp);
  saveLocalProducts(state.localProducts);
  pushLocalProductsToServer();
  state.showLocalProductForm = false;
  state.localProductForm = { name: '', price: '', productType: 'PIECE' };
  render();
}

export function updateLocalProduct(id: string, price: number): void {
  const lp = state.localProducts.find((x) => x.id === id);
  if (!lp) return;
  lp.price = Math.max(0, price);
  saveLocalProducts(state.localProducts);
  pushLocalProductsToServer();
  state.editingLocalProductId = null;
  state.localEditPrice = '';
  render();
}

export function deleteLocalProduct(id: string): void {
  state.localProducts = state.localProducts.filter((lp) => lp.id !== id);
  saveLocalProducts(state.localProducts);
  pushLocalProductsToServer();
  render();
}

export function reorderLocalProduct(fromId: string, toId: string): void {
  const list = state.localProducts;
  const from = list.findIndex((lp) => lp.id === fromId);
  const to   = list.findIndex((lp) => lp.id === toId);
  if (from === -1 || to === -1 || from === to) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  saveLocalProducts(list);
  pushLocalProductsToServer();
  render();
}
