import { state } from '../state';
import { saveClient, saveOrderMeta, saveOrderApp, saveOrders, saveOrderMode, ORDERS_KEY } from '../storage';
import { render } from '../render/trigger';
import { upsertClientRecord } from './clients';
import { buildCartItems, roundQty } from './cart';
import { dayKeyGMT3, unitPrice } from '../utils';
import { showChangeCalculator, showOrderReceipt } from '../ui/receipt';
import { storeDisplayNum } from '../render/products-panel';
import { formatShopOptionLabel } from '../utils/shop';
import type { Product, SavedOrder, SavedOrderItem, CartItem } from '../types';

function resolveStoreId(apiId: string): string {
  const shop = state.storesList.find((s) => String(s.id) === apiId);
  if (!shop) return apiId;
  return storeDisplayNum(formatShopOptionLabel(shop)) ?? apiId;
}

function nextSeqNum(dayKey: string): number {
  const existing = state.orders
    .filter((o) => dayKeyGMT3(o.createdAt) === dayKey && o.seqNum != null)
    .map((o) => o.seqNum as number);
  return existing.length ? Math.max(...existing) + 1 : 1;
}

export function migrateOrderSeqNums(): void {
  const sorted = [...state.orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const dayCounts = new Map<string, number>();
  let changed = false;
  sorted.forEach((o) => {
    const dk = dayKeyGMT3(o.createdAt);
    const n = (dayCounts.get(dk) ?? 0) + 1;
    dayCounts.set(dk, n);
    if (o.seqNum == null) { o.seqNum = n; changed = true; }
  });
  if (changed) saveOrders(state.orders);
}

export function newOrder(): void {
  state.cart = [];
  state.editingOrderId = null;
  state.client = { phone: '', name: '', street: '', house: '', entrance: '', floor: '', apartment: '', intercom: '', notes: '' };
  saveClient(state.client);
  state.clientSuggestHidden = false;
  state.cartTab = 'client';
  state.orderMode = 'phone';
  saveOrderMode('phone');
  state.appClientExpanded = false;
  state.orderApp = { orderNumber: '', orderAmount: '', deliveryPrice: 300, packageQty: 1 };
  saveOrderApp(state.orderApp);
  state.detectedZone = '';
  state.detectedZoneKm = null;
  state.detectedZoneLoading = false;
  state.zoneGeoKey = '';
  render();
}

export function createOrder(): void {
  const isAppTab = state.orderMode === 'app';
  if (!state.cart.length && !isAppTab) return;


  const cartSum = state.cart.reduce((sum, item) => sum + unitPrice(item.product) * item.qty, 0);
  const total = isAppTab
    ? (parseFloat(state.orderApp.orderAmount.replaceAll(',', '.')) || 0) + state.orderApp.deliveryPrice + cartSum
    : cartSum;
  const items = buildCartItems();
  const orderMethod: SavedOrder['orderMethod'] = isAppTab ? 'app' : 'phone';

  if (state.editingOrderId) {
    const order = state.orders.find((o) => o.id === state.editingOrderId);
    if (order) {
      order.items = items;
      order.total = total;
      order.client = { ...state.client };
      order.orderMethod = orderMethod;
      order.payMethod = isAppTab ? 'card' : state.orderMeta.payMethod;
      order.operator = state.orderMeta.operator;
      if (isAppTab) {
        order.orderNumber = state.orderApp.orderNumber || undefined;
        order.deliveryPrice = state.orderApp.deliveryPrice;
        order.orderAmount = parseFloat(state.orderApp.orderAmount.replaceAll(',', '.')) || 0;
      }
      saveOrders(state.orders);
    }
    state.editingOrderId = null;
    state.cart = [];
    state.cartTab = 'cart';
    state.currentPage = 'orders';
    render();
    if (order && order.payMethod === 'cash') {
      showChangeCalculator(order.total, (given, change) => {
        if (given > 0) { order.given = given; order.change = change; }
        else { order.given = undefined; order.change = undefined; }
        saveOrders(state.orders);
        render();
        showOrderReceipt(order);
      }, order.given);
    } else if (order) {
      showOrderReceipt(order);
    }
    return;
  }

  const createdAt = new Date().toISOString();
  const order: SavedOrder = {
    id: Date.now().toString(),
    createdAt,
    seqNum: nextSeqNum(dayKeyGMT3(createdAt)),
    status: 'created',
    storeId: resolveStoreId(state.activeStoreId),
    client: { ...state.client },
    orderMethod,
    payMethod: isAppTab ? 'card' : state.orderMeta.payMethod,
    operator: state.orderMeta.operator,
    items,
    total,
    ...(isAppTab && state.orderApp.orderNumber ? { orderNumber: state.orderApp.orderNumber } : {}),
    ...(isAppTab ? { deliveryPrice: state.orderApp.deliveryPrice, orderAmount: parseFloat(state.orderApp.orderAmount.replaceAll(',', '.')) || 0 } : {}),
    ...(isAppTab && state.appOrderLinked ? (() => {
      const linked = state.appOrders.find((o) => o.number === state.appOrderLinked);
      const hasW = linked?.cart_products.some((p) => !p.pack_item || p.pack_item.volume === 0) ?? false;
      return hasW ? { hasWeightItems: true } : {};
    })() : {}),
  };
  state.orders.unshift(order);
  saveOrders(state.orders);
  upsertClientRecord(order.client);
  state.cart = [];
  state.cartTab = 'cart';
  state.client = { phone: '', name: '', street: '', house: '', entrance: '', floor: '', apartment: '', intercom: '', notes: '' };
  saveClient(state.client);
  state.clientSuggestHidden = false;
  state.orderApp = { orderNumber: '', orderAmount: '', deliveryPrice: 300, packageQty: 1 };
  saveOrderApp(state.orderApp);
  state.currentPage = 'orders';
  render();

  if (order.payMethod === 'cash') {
    showChangeCalculator(order.total, (given, change) => {
      if (given > 0) { order.given = given; order.change = change; saveOrders(state.orders); render(); }
      showOrderReceipt(order);
    });
  } else {
    showOrderReceipt(order);
  }
}

function itemsToCart(items: SavedOrderItem[]): CartItem[] {
  return items.map((item) => {
    const product: Product = (() => {
      if (item.id) {
        for (const list of state.productsCache.values()) {
          const found = list.find((p) => p.id === item.id);
          if (found) return found;
        }
      }
      return {
        id: item.id ?? 0,
        name: item.name,
        price: item.productType === 'WEIGHT' ? item.price / 10 : item.price,
        product_type: (item.productType as Product['product_type']) || undefined,
      };
    })();
    const draftVol = item.productType === 'DRAFT' && /^\d+(\.\d+)?\s*л$/i.test(item.details ?? '')
      ? parseFloat(item.details!)
      : undefined;
    return { product, qty: item.qty, ...(draftVol !== undefined && { draftVolume: draftVol }) };
  });
}

export function repeatOrder(orderId: string): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;

  state.cart = itemsToCart(order.items);
  Object.assign(state.client, order.client);
  saveClient(state.client);
  state.orderMeta = { orderMethod: order.orderMethod, payMethod: order.payMethod, operator: order.operator ?? '' };
  saveOrderMeta(state.orderMeta);
  state.editingOrderId = null;
  state.cartTab = 'cart';
  state.orderMode = order.orderMethod === 'app' ? 'app' : 'phone';
  saveOrderMode(state.orderMode);
  if (order.orderMethod === 'app') {
    state.orderApp = { orderNumber: '', orderAmount: '', deliveryPrice: order.deliveryPrice ?? 300, packageQty: 1 };
    saveOrderApp(state.orderApp);
  }
  state.appClientExpanded = false;
  state.currentPage = 'products';
  render();
}

export function loadOrderToCart(orderId: string): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;

  state.cart = itemsToCart(order.items);
  Object.assign(state.client, order.client);
  saveClient(state.client);
  state.orderMeta = { orderMethod: order.orderMethod, payMethod: order.payMethod, operator: order.operator ?? '' };
  saveOrderMeta(state.orderMeta);
  state.editingOrderId = orderId;

  if (order.orderMethod === 'app') {
    state.orderApp = {
      orderNumber: order.orderNumber ?? '',
      orderAmount: String(order.orderAmount ?? ''),
      deliveryPrice: order.deliveryPrice ?? 300,
      packageQty: order.items.reduce((sum, i) => /пакет/i.test(i.name) ? sum + i.qty : sum, 0) || 1,
    };
    saveOrderApp(state.orderApp);
    state.orderMode = 'app';
    saveOrderMode('app');
  } else {
    state.cartTab = 'cart';
    state.orderMode = 'phone';
    saveOrderMode('phone');
  }
  state.appClientExpanded = false;

  state.currentPage = 'products';
  render();
}

export function changeOrderStatus(orderId: string, newStatus: SavedOrder['status']): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;
  order.status = newStatus;
  saveOrders(state.orders);
  render();
}

export function changeOrderStore(orderId: string, storeId: string): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;
  order.storeId = storeId;
  saveOrders(state.orders);
  render();
}

export function removeOrder(orderId: string): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;
  order.deletedAt = new Date().toISOString();
  if (state.expandedOrderId === orderId) state.expandedOrderId = null;
  saveOrders(state.orders);
  render();
}

export function restoreOrder(orderId: string): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;
  delete order.deletedAt;
  saveOrders(state.orders);
  render();
}

export function permanentDeleteOrder(orderId: string): void {
  state.orders = state.orders.filter((o) => o.id !== orderId);
  if (state.expandedOrderId === orderId) state.expandedOrderId = null;
  fetch(`/desk-api/orders?id=${encodeURIComponent(orderId)}`, { method: 'DELETE' }).catch(() => {});
  render();
}

export function toggleOrderExpand(orderId: string): void {
  state.expandedOrderId = state.expandedOrderId === orderId ? null : orderId;
  render();
}

export function recalcOrderTotal(order: SavedOrder): void {
  const itemsSum = order.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  order.total = order.orderMethod === 'app'
    ? (order.orderAmount ?? 0) + (order.deliveryPrice ?? 0) + itemsSum
    : itemsSum;
}

export function changeOrderItemQty(orderId: string, itemIndex: number, delta: number): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;
  const item = order.items[itemIndex];
  if (!item) return;
  const newQty = roundQty(item.qty + delta);
  if (newQty <= 0) order.items.splice(itemIndex, 1);
  else item.qty = newQty;
  recalcOrderTotal(order);
  saveOrders(state.orders);
  render();
}

export function setOrderItemQty(orderId: string, itemIndex: number, val: number): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;
  const item = order.items[itemIndex];
  if (!item) return;
  item.qty = Math.max(0.001, roundQty(val || 0.001));
  recalcOrderTotal(order);
  saveOrders(state.orders);
  render();
}

export function removeOrderItem(orderId: string, itemIndex: number): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;
  order.items.splice(itemIndex, 1);
  recalcOrderTotal(order);
  saveOrders(state.orders);
  render();
}

export async function loadOrdersFromServer(): Promise<void> {
  try {
    const res = await fetch('/desk-api/orders');
    if (!res.ok) return;
    const body = await res.json() as SavedOrder[] | { ok: boolean; data: SavedOrder[] };
    const serverOrders: SavedOrder[] = Array.isArray(body) ? body : (body as { data: SavedOrder[] }).data ?? [];

    const serverIds = new Set(serverOrders.map(o => o.id));
    // Exclude locally-deleted orders — they were permanently deleted on server by another session
    // and must not be re-uploaded (that's what caused deleted orders to reappear after tab switch)
    const localOnly = state.orders.filter(o => !serverIds.has(o.id) && !o.deletedAt);
    const merged = localOnly.length > 0
      ? [...localOnly, ...serverOrders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : serverOrders;

    if (localOnly.length > 0) {
      fetch('/desk-api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      }).catch(() => {});
    }

    const prevSnapshot = JSON.stringify(state.orders);
    state.orders = merged;
    // Назначаем seqNum только заказам у которых его нет (миграция старых данных)
    migrateOrderSeqNums();

    // Кэшируем в localStorage чтобы следующий старт видел актуальные заказы
    try { localStorage.setItem(ORDERS_KEY, JSON.stringify(state.orders)); } catch { /* quota */ }

    if (JSON.stringify(state.orders) !== prevSnapshot) {
      render();
    }
  } catch { /* сервер недоступен */ }
}
