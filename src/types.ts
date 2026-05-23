import type { Category, Product, Shop, VendorItem } from './api/types';

export const NO_CATEGORY_ID = -1;
export const PENDING_ID = -2;
export const LOCAL_CATEGORY_ID = -3;

export interface CategoryNode {
  category: Category;
  subcategories: Category[] | null;
  expanded: boolean;
  loading: boolean;
}

export interface CartItem {
  product: Product;
  qty: number;
  draftVolume?: number;  // liters per serving, only for DRAFT — separate entry per volume
}

export interface ClientInfo {
  phone: string;
  name: string;
  street: string;
  house: string;
  entrance: string;
  floor: string;
  apartment: string;
  intercom: string;
}

export interface LocalProduct {
  id: string;
  name: string;
  price: number;
  productType: string;
}

export interface CountryEntry {
  keyword: string;
  country: string;
}

export interface ClientAddress {
  street: string;
  house: string;
  entrance: string;
  floor: string;
  apartment: string;
  intercom: string;
}

export type DbClient = {
  name: string; phone: string; street: string; house: string;
  entrance: string; floor: string; apartment: string; intercom: string; notes: string;
  addresses?: ClientAddress[];
  phones?: string[];
};

export interface OrderMeta {
  orderMethod: 'phone' | 'app';
  payMethod: 'cash' | 'card';
  operator: string;
}

export interface SavedOrderItem {
  id?: number;
  name: string;
  qty: number;
  price: number;
  productType: string;
  details?: string;
}

export interface SavedOrder {
  id: string;
  createdAt: string;
  status: 'created' | 'in_progress' | 'done';
  storeId: string;
  client: ClientInfo & { notes: string };
  orderMethod: 'phone' | 'app';
  payMethod: 'cash' | 'card';
  operator: string;
  items: SavedOrderItem[];
  total: number;
  orderNumber?: string;
  seqNum?: number;
  deliveryPrice?: number;
  orderAmount?: number;
  given?: number;
  change?: number;
  deletedAt?: string;
  hasWeightItems?: boolean;
}

export interface OrderApp {
  orderNumber: string;
  orderAmount: string;
  deliveryPrice: number;
  packageQty: number;
}

export type AppPage = 'products' | 'orders' | 'analytics' | 'refs' | 'search';
export type CartTab = 'cart' | 'client' | 'order';
export type OrderMode = 'phone' | 'app';
export type AnalyticsTab = 'overview' | 'revenue';
export type AnalyticsPeriod = 'day' | 'week' | 'month';

export type { Category, Product, VendorItem, Shop };
