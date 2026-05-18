import { state } from '../state';
import { saveClient, saveOrderMeta, saveOrderApp, saveOrders, saveOrderMode } from '../storage';
import { render } from '../render/trigger';
import { upsertClientRecord } from './clients';
import { buildCartItems, roundQty } from './cart';
import { localToProduct } from './vendor';
import { unitPrice } from '../utils';
import { showChangeCalculator, showOrderReceipt } from '../ui/receipt';
import { storeDisplayNum } from '../render/products-panel';
import { formatShopOptionLabel } from '../utils/shop';
import type { Product, SavedOrder, SavedOrderItem } from '../types';

function resolveStoreId(apiId: string): string {
  const shop = state.storesList.find((s) => String(s.id) === apiId);
  if (!shop) return apiId;
  return storeDisplayNum(formatShopOptionLabel(shop)) ?? apiId;
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

  if (!isAppTab && !state.editingOrderId) {
    const hasPkg      = state.cart.some((i) => /пакет/i.test(i.product.name ?? ''));
    const hasDelivery = state.cart.some((i) => /доставка/i.test(i.product.name ?? ''));
    if (!hasPkg) {
      const lp = state.localProducts.find((p) => /^пакет$/i.test(p.name));
      if (lp) state.cart.push({ product: localToProduct(lp), qty: 1 });
    }
    if (!hasDelivery) {
      const lp = state.localProducts.find((p) => /^доставка$/i.test(p.name));
      if (lp) state.cart.push({ product: localToProduct(lp), qty: 1 });
    }
  }

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

  const order: SavedOrder = {
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
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

export function repeatOrder(orderId: string): void {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;

  const findOrBuild = (item: SavedOrderItem): Product => {
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
  };

  state.cart = order.items.map((item) => ({ product: findOrBuild(item), qty: item.qty }));
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

  const findOrBuild = (item: SavedOrderItem): Product => {
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
  };

  state.cart = order.items.map((item) => ({ product: findOrBuild(item), qty: item.qty }));
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
  state.orders = state.orders.filter((o) => o.id !== orderId);
  if (state.expandedOrderId === orderId) state.expandedOrderId = null;
  saveOrders(state.orders);
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
  item.qty = Math.max(0.001, roundQty(item.qty + delta));
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
    const serverOrders = await res.json() as SavedOrder[];
    if (serverOrders.length > 0) {
      if (JSON.stringify(serverOrders) !== JSON.stringify(state.orders)) {
        state.orders = serverOrders;
        render();
      }
    } else if (state.orders.length > 0) {
      await fetch('/desk-api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.orders),
      });
    }
  } catch { /* сервер недоступен — используем localStorage */ }
}
