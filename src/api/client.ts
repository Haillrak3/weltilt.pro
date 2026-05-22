import type {
  ApiResponse,
  AppOrder,
  AppOrderPeriod,
  AppOrdersPage,
  Category,
  ModeratedProductsPage,
  Product,
  ProductsPage,
  SignInData,
  SmsCodeInfo,
  Shop,
  ShopsPage,
  VendorItemsPage,
} from './types';
import { loadSettings } from '../config/settings';

/** В dev — через Vite proxy (/api). В prod — напрямую (CORS * на api.0-5.ru). */
const API_BASE =
  import.meta.env.VITE_API_BASE?.replace(/\/$/, '') ??
  (import.meta.env.DEV ? '' : 'https://api.0-5.ru');

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type RequestOptions = {
  withAuth?: boolean;
  authToken?: string;
  publicEndpoint?: boolean;
};

async function request<T>(
  path: string,
  init?: RequestInit,
  options?: RequestOptions,
): Promise<T> {
  const stored = loadSettings();
  const authToken = options?.authToken?.trim() || stored.authToken.trim();
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  headers.set('X-App', '2po2');
  headers.set('User-Agent', 'OrderDesk/1.0 (2po2 web)');
  if (!options?.publicEndpoint) {
    const withAuth = options?.withAuth === true;
    if (withAuth) {
      if (!authToken) {
        throw new ApiError('Нужен X-Auth-Token: войдите по SMS или вставьте токен');
      }
      headers.set('X-Auth-Token', authToken);
    } else if (authToken) {
      headers.set('X-Auth-Token', authToken);
    }
  }
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, headers });
  } catch (e) {
    const hint = import.meta.env.DEV
      ? ' Запустите: npm run dev'
      : ' Проверьте сеть или VITE_API_BASE.';
    const msg = e instanceof Error ? e.message : 'сеть недоступна';
    throw new ApiError(`${msg}.${hint}`);
  }

  const raw = await res.text();
  let json: ApiResponse<T> & { message?: string; error_code?: string };
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw new ApiError(
      raw ? `Ответ сервера не JSON: ${raw.slice(0, 120)}` : `HTTP ${res.status}`,
      res.status,
    );
  }

  if (!res.ok) {
    throw new ApiError(json.message ?? `HTTP ${res.status}`, res.status);
  }
  if (json.success === false) {
    const hint = json.error_code ? ` (${json.error_code})` : '';
    throw new ApiError((json.message ?? 'Запрос не выполнен') + hint);
  }
  return json.data;
}

function parseStoresList(data: ShopsPage | Shop[] | null | undefined): Shop[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.list ?? [];
}

function storeQuery(storeId: string): string {
  return `store_id=${encodeURIComponent(storeId)}`;
}

export function getCategories(storeId: string, authToken?: string): Promise<Category[]> {
  return request<Category[]>(`/api/v1/catalog/categories?${storeQuery(storeId)}`, undefined, {
    withAuth: true,
    authToken,
  });
}

export function getSubcategories(
  storeId: string,
  categoryId: number,
  authToken?: string,
): Promise<Category[]> {
  return request<Category[]>(
    `/api/v1/catalog/categories/${categoryId}/subcategories?${storeQuery(storeId)}`,
    undefined,
    { withAuth: true, authToken },
  );
}

export function getProducts(
  storeId: string,
  categoryId: number,
  page = 1,
  perPage = 50,
  authToken?: string,
): Promise<ProductsPage> {
  const q = new URLSearchParams({
    store_id: storeId,
    category_id: String(categoryId),
    page: String(page),
    per_page: String(perPage),
  });
  return request<ProductsPage>(`/api/v1/catalog/products?${q}`, undefined, {
    withAuth: true,
    authToken,
  });
}

/** Все товары категории — сервер кэширует и отдаёт одним запросом. */
export async function getAllProducts(
  storeId: string,
  categoryId: number,
  authToken?: string,
): Promise<Product[]> {
  const q = new URLSearchParams({ store_id: storeId, category_id: String(categoryId) });
  const page = await request<ProductsPage>(`/desk-api/catalog?${q}`, undefined, {
    withAuth: true, authToken,
  });
  return page.list ?? [];
}

/** Все vendor-товары магазина — сервер кэширует и отдаёт одним запросом. */
export async function getAllVendorProducts(
  storeId: string,
  authToken?: string,
): Promise<Product[]> {
  const q = new URLSearchParams({ store_id: storeId });
  const page = await request<ProductsPage>(`/desk-api/vendor-catalog?${q}`, undefined, {
    withAuth: true, authToken,
  });
  return page.list ?? [];
}

/** GET /api/v1/vendor/catalog/products — все товары магазина включая OUT_OF_STOCK */
export function getVendorCatalogProducts(
  storeId: string,
  page = 1,
  perPage = 100,
  authToken?: string,
): Promise<ProductsPage> {
  const q = new URLSearchParams({
    store_id: storeId,
    page: String(page),
    per_page: String(perPage),
  });
  return request<ProductsPage>(`/api/v1/vendor/catalog/products?${q}`, undefined, {
    withAuth: true,
    authToken,
  });
}

/** GET /api/v1/stores — публичный список, токен не обязателен (проверено по API) */
export function getStores(authToken?: string): Promise<Shop[]> {
  return request<ShopsPage | Shop[]>('/api/v1/stores', undefined, {
    authToken,
  }).then(parseStoresList);
}

/** GET /api/v1/vendor/products — мастер-каталог со статусами (PENDING, APPROVED и др.) */
export function getVendorItems(
  page = 1,
  perPage = 100,
  authToken?: string,
): Promise<VendorItemsPage> {
  const q = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  return request<VendorItemsPage>(`/api/v1/vendor/products?${q}`, undefined, {
    withAuth: true,
    authToken,
  });
}

/** GET /api/v1/vendor/products/moderated — товары на модерации по партнёру */
export function getModeratedProducts(
  partnerId: number,
  status?: 'PENDING' | 'REJECTED' | 'APPROVED',
  page = 1,
  perPage = 100,
  authToken?: string,
): Promise<ModeratedProductsPage> {
  const q = new URLSearchParams({
    partner_id: String(partnerId),
    page: String(page),
    per_page: String(perPage),
  });
  if (status) q.set('status', status);
  return request<ModeratedProductsPage>(`/api/v1/vendor/products/moderated?${q}`, undefined, {
    withAuth: true,
    authToken,
  });
}

export function requestSms(
  countryCode: string,
  phoneNumber: string,
): Promise<SmsCodeInfo> {
  return request<SmsCodeInfo>('/api/v1/vendor/sms/request_code', {
    method: 'POST',
    body: JSON.stringify({ country_code: countryCode, phone_number: phoneNumber }),
  }, { publicEndpoint: true });
}

export function signIn(
  countryCode: string,
  phoneNumber: string,
  confirmationCode: string,
): Promise<SignInData> {
  return request<SignInData>('/api/v1/vendor/sign_in', {
    method: 'POST',
    body: JSON.stringify({
      user: {
        country_code: countryCode,
        phone_number: phoneNumber,
        confirmation_code: confirmationCode,
      },
    }),
  }, { publicEndpoint: true });
}

export function getAppOrders(
  period: AppOrderPeriod = 'today',
  page = 0,
  perPage = 100,
  authToken?: string,
): Promise<AppOrdersPage> {
  const q = new URLSearchParams({ period, page: String(page), per_page: String(perPage) });
  return request<AppOrdersPage>(`/api/v1/vendor/orders?${q}`, undefined, { withAuth: true, authToken });
}

export function progressAppOrder(orderId: string, authToken?: string): Promise<{ order: AppOrder }> {
  return request<{ order: AppOrder }>(`/api/v1/vendor/orders/${encodeURIComponent(orderId)}/progress`, { method: 'POST' }, { withAuth: true, authToken });
}

/** Просит сервер прогреть кэш каталога для указанных складов в фоне. Fire-and-forget. */
export function triggerServerWarmup(storeIds: string[], authToken: string): void {
  fetch('/desk-api/warm-cache', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: authToken, storeIds }),
  }).catch(() => { /* fire-and-forget */ });
}
