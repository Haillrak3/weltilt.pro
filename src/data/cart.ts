import { state } from '../state';
import { formatProductDetails, formatQty, unitPrice } from '../utils';
import { localToProduct } from './vendor';
import { render } from '../render/trigger';
import { showToast } from '../ui/toast';
import type { Product, SavedOrderItem } from '../types';

export function roundQty(val: number): number {
  return Math.round(val * 1000) / 1000;
}

// Pattern order matters: 1.5 before 1 to avoid partial match
const TARA_PATTERNS: [number, RegExp][] = [
  [1.5, /(тара|бутылка)\s*1[,.]5/i],
  [0.5, /(тара|бутылка)\s*0[,.]5/i],
  [1,   /(тара|бутылка)\s*1(?![\d,.])/i],
];

export function findTara(liters: number): Product | undefined {
  const entry = TARA_PATTERNS.find(([vol]) => vol === liters);
  if (!entry) return undefined;
  const pattern = entry[1];

  const local = state.localProducts.find((lp) => pattern.test(lp.name));
  if (local) return localToProduct(local);

  for (const p of state.vendorProducts) {
    if (pattern.test(p.name)) return p;
  }
  for (const list of state.productsCache.values()) {
    const found = list.find((p) => pattern.test(p.name));
    if (found) return found;
  }

  return undefined;
}

export function removeDraftWithTara(product: Product, liters: number): void {
  const beerItem = state.cart.find(
    (item) => item.product.id === product.id && item.draftVolume === liters,
  );
  if (!beerItem || beerItem.qty < liters - 0.001) return;

  const tara = findTara(liters);
  const taraItem = tara
    ? state.cart.find((item) => item.product.id === tara.id)
    : undefined;

  if (tara && !taraItem) return;

  beerItem.qty = roundQty(beerItem.qty - liters);
  if (beerItem.qty <= 0) state.cart.splice(state.cart.indexOf(beerItem), 1);

  if (taraItem) {
    taraItem.qty -= 1;
    if (taraItem.qty <= 0) state.cart.splice(state.cart.indexOf(taraItem), 1);
  }

  render();
}

export function addDraftWithTara(product: Product, liters: number): void {
  if (product.available_qty != null) {
    const totalInCart = state.cart
      .filter((ci) => ci.product.id === product.id && ci.draftVolume !== undefined)
      .reduce((s, ci) => s + ci.qty, 0);
    if (totalInCart + liters > product.available_qty) {
      showToast(`Недостаточно остатка — доступно: ${formatQty(product.available_qty)} л`);
    }
  }

  const existing = state.cart.find(
    (item) => item.product.id === product.id && item.draftVolume === liters,
  );
  if (existing) existing.qty = roundQty(existing.qty + liters);
  else state.cart.push({ product, qty: liters, draftVolume: liters });

  const tara = findTara(liters);
  if (tara) {
    const existingTara = state.cart.find((item) => item.product.id === tara.id);
    if (existingTara) existingTara.qty += 1;
    else state.cart.push({ product: tara, qty: 1 });
  }

  syncAutoItems();
  render();
}

function syncAutoItems(): void {
  const localIds = new Set(state.localProducts.map((lp) => localToProduct(lp).id));
  const nonLocalCount = state.cart
    .filter((i) => !localIds.has(i.product.id))
    .reduce((s, i) => s + (i.draftVolume !== undefined ? i.qty / i.draftVolume : i.qty), 0);

  if (nonLocalCount === 0) return;

  const hasDelivery = state.cart.some((i) => /доставка/i.test(i.product.name ?? ''));
  if (!hasDelivery) {
    const lp = state.localProducts.find((p) => /^доставка$/i.test(p.name));
    if (lp) state.cart.push({ product: localToProduct(lp), qty: 1 });
  }

  const neededPkgs = Math.max(1, Math.ceil(nonLocalCount / 7));
  const pkgLp = state.localProducts.find((p) => /^пакет$/i.test(p.name));
  if (pkgLp) {
    const pkgProduct = localToProduct(pkgLp);
    const existing = state.cart.find((i) => i.product.id === pkgProduct.id);
    if (existing) existing.qty = neededPkgs;
    else state.cart.push({ product: pkgProduct, qty: neededPkgs });
  }
}

export function addToCart(product: Product): void {
  const existing = state.cart.find((item) => item.product.id === product.id);
  if (product.available_qty != null) {
    const newQty = (existing?.qty ?? 0) + 1;
    if (newQty > product.available_qty) {
      showToast(`Недостаточно остатка — доступно: ${formatQty(product.available_qty)} шт.`);
    }
  }
  if (existing) existing.qty += 1;
  else state.cart.push({ product, qty: 1 });
  syncAutoItems();
  render();
}

export function changeCartQty(index: number, delta: number): void {
  const item = state.cart[index];
  if (!item) return;
  const newQty = roundQty(item.qty + delta);
  if (delta > 0 && item.product.available_qty != null) {
    const limit = item.product.available_qty;
    const exceeded = item.draftVolume !== undefined
      ? state.cart
          .filter((ci) => ci.product.id === item.product.id && ci.draftVolume !== undefined)
          .reduce((s, ci) => s + ci.qty, 0) + delta > limit
      : newQty > limit;
    if (exceeded) {
      const unit = item.draftVolume !== undefined ? 'л' : 'шт.';
      showToast(`Недостаточно остатка — доступно: ${formatQty(limit)} ${unit}`);
    }
  }
  if (newQty <= 0) state.cart.splice(index, 1);
  else item.qty = newQty;
  render();
}

export function getCartSum(): number {
  return state.cart.reduce((sum, item) => sum + unitPrice(item.product) * item.qty, 0);
}

export function removeFromCart(index: number): void {
  state.cart.splice(index, 1);
  render();
}

export function buildCartItems(): SavedOrderItem[] {
  return state.cart.map((item) => {
    const details = item.draftVolume !== undefined
      ? `${item.draftVolume} л`
      : formatProductDetails(item.product);
    return {
      id: item.product.id || undefined,
      name: item.product.name,
      qty: item.qty,
      price: unitPrice(item.product, item.draftVolume),
      productType: item.product.product_type ?? '',
      ...(details && { details }),
    };
  });
}
