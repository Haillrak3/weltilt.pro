export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string | null;
  error_code?: string | null;
}

export interface Category {
  id: number;
  name: string;
  position?: number;
  products_count?: number;
}

export interface ProductProperty {
  code: string;
  name: string;
  value: string;
}

export interface ProductImage {
  small?: string | null;
  medium?: string | null;
  large?: string | null;
  original?: string | null;
}

export interface Product {
  id: number;
  name: string;
  price?: number;
  original_price?: number;
  formatted_price?: string;
  available_qty?: number;
  subcategory?: Category;
  product_type?: string;
  properties?: ProductProperty[];
  main_image?: ProductImage;
  description?: string;
  availability?: 'IN_STOCK' | 'OUT_OF_STOCK';
  is_blocked?: boolean;
  status?: 'APPROVED' | 'REJECTED' | 'DELETED' | 'PENDING';
  exchange_product?: { id: number };
}

export interface VendorItem {
  id: number;
  name: string;
  status?: 'APPROVED' | 'REJECTED' | 'DELETED' | 'PENDING';
  min_price?: number;
  main_image?: ProductImage;
  description?: string | null;
  properties?: ProductProperty[];
  subcategory?: Category | null;
  is_from_exchange?: boolean;
}

export interface VendorItemsPage {
  list: VendorItem[];
  page?: number;
  per_page?: number;
  has_more?: boolean;
  total_count?: number;
}

export interface ModeratedProduct {
  id: number;
  name: string;
  type?: string;
  status: 'PENDING' | 'REJECTED' | 'APPROVED';
  formatted_qty?: string;
  bar_codes?: string[];
  brewery?: string;
  matched_product?: {
    id: number;
    name: string;
    main_image?: ProductImage;
    subcategory?: Category;
  };
}

export interface ModeratedProductsPage {
  list: ModeratedProduct[];
  page?: number;
  per_page?: number;
  has_more?: boolean;
  total_count?: number;
}

export interface ProductsPage {
  list: Product[];
  page?: number;
  per_page?: number;
  has_more?: boolean;
  total_count?: number;
}

export interface ShopAddress {
  street?: string;
  number?: string;
  city?: { name: string };
}

export interface Shop {
  id: number | string;
  name?: string;
  description?: string;
  address?: ShopAddress;
}

/** Ответ GET /api/v1/stores — пагинация как у products */
export interface ShopsPage {
  list: Shop[];
  page?: number;
  per_page?: number;
  has_more?: boolean;
  total_count?: number;
}

export interface SmsCodeInfo {
  next_request_timeout_in_seconds?: number;
  code_length?: number;
  code?: number;
}

export interface SignInData {
  access_token: string;
  user?: { access_token: string; name?: string; is_new?: boolean };
  name?: string;
  is_new?: boolean;
}
