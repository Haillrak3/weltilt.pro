import { loadSettings } from './config/settings';
import {
  loadClient, loadExtraClients, loadLocalProducts,
  loadOrderMeta, loadOrderApp, loadOrders, loadActiveStoreId, loadOrderMode,
  loadAllStoresCache, loadProductsCache, loadCurrentPage, loadHandledOrders,
} from './storage';
import { todayGMT3 } from './utils';
import type {
  AnalyticsPeriod, AnalyticsTab, AppPage, CartItem, CartTab, CategoryNode, CountryEntry,
  OrderApp, OrderMode, Product, SavedOrder, Shop,
} from './types';
import type { AppOrder, AppOrderPeriod, ModeratedProduct } from './api/types';

const _settings = loadSettings();
const _orders = loadOrders();
const _orderMeta = loadOrderMeta();
const _activeStoreId = loadActiveStoreId() || _orders[0]?.storeId || _settings.storeId;

export const state = {
  // ── Settings ───────────────────────────────────────────────────────────────
  settings: _settings,

  // ── Categories & products ──────────────────────────────────────────────────
  categories: [] as CategoryNode[],
  selectedSubcategoryId: null as number | null,
  products: [] as Product[],
  productsLoading: false,
  productsError: '',
  categoriesLoading: false,
  categoriesError: '',
  productsCache: loadProductsCache(_activeStoreId),
  vendorProducts: [] as Product[],
  vendorProductsLoading: false,
  pendingProducts: [] as ModeratedProduct[],
  pendingProductsLoading: false,
  pendingPage: 0,
  localProducts: loadLocalProducts(),
  showLocalProductForm: false,
  localProductForm: { name: '', price: '', productType: 'PIECE' },
  editingLocalProductId: null as string | null,
  localEditPrice: '',
  filterImport: false,

  // ── Stores ─────────────────────────────────────────────────────────────────
  activeStoreId: _activeStoreId,
  storesList: [] as Shop[],
  storesLoading: false,
  storesExpanded: false,

  // ── Cart & current order ───────────────────────────────────────────────────
  cart: [] as CartItem[],
  cartTab: 'cart' as CartTab,
  orderMeta: _orderMeta,
  orderApp: loadOrderApp() as OrderApp,
  orderMode: loadOrderMode() as OrderMode,
  editingOrderId: null as string | null,

  // ── Client ─────────────────────────────────────────────────────────────────
  client: loadClient(),
  clientSuggestHidden: false,
  extraClients: loadExtraClients(),
  clientInfoPanel: null as null | 'menu' | 'phones' | 'addresses',

  // ── Geo / zone detection ───────────────────────────────────────────────────
  detectedZone: '' as string,
  detectedZoneKm: null as number | null,
  detectedZoneLoading: false,
  zoneGeoKey: '',

  // ── Orders page ────────────────────────────────────────────────────────────
  orders: _orders,
  expandedOrderId: null as string | null,
  ordersFilterFrom: todayGMT3(),
  ordersFilterTo: todayGMT3(),
  ordersFilterStore: '',
  ordersFilterStatus: '' as SavedOrder['status'] | '',
  ordersFilterAttention: false,
  ordersShowTrash: false,

  // ── App orders (режим «Приложение») ────────────────────────────────────────
  appOrders: [] as AppOrder[],
  appOrdersLoading: false,
  appOrdersError: '',
  appOrdersPeriod: 'today' as AppOrderPeriod,
  appOrdersTotalCount: 0,
  appOrderLinked: null as string | null,
  appClientExpanded: false,
  handledOrders: loadHandledOrders(_orderMeta.operator),
  appOrdersSearch: '',
  appOrdersPollTimer: null as ReturnType<typeof setInterval> | null,

  // ── Global search ──────────────────────────────────────────────────────────
  searchQuery: '',
  searchAllQuery: '',
  allStoresProducts: loadAllStoresCache(),
  allStoresLoading: false,
  prefetchTotal: 0,
  prefetchDone: 0,

  // ── Navigation & UI ────────────────────────────────────────────────────────
  currentPage: loadCurrentPage() as AppPage,
  mobilePanel: 'products' as 'products' | 'cart' | 'cats',
  analyticsTab: 'overview' as AnalyticsTab,
  analyticsPeriod: 'day' as AnalyticsPeriod,
  dragLocalId: null as string | null,

  // ── Refs & countries ───────────────────────────────────────────────────────
  countries: [] as CountryEntry[],
  countriesExpanded: false,
  refsClientSearch: '',
  refsPage: 0,

  // ── Mango ──────────────────────────────────────────────────────────────────
  mangoAccounts: [] as Array<{ operatorPhone: string }>,
  mangoMyPhone: '',
};
