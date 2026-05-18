import type { Shop, ShopAddress } from '../api/types';

/** Как в приложении: улица + номер через запятую */
export function formatStreetAndNumber(address?: ShopAddress | null): string {
  if (!address) return '';
  const parts = [address.street, address.number].filter(Boolean);
  return parts.join(', ');
}

export function formatShopAddress(shop: Shop): string {
  const street = formatStreetAndNumber(shop.address);
  const city = shop.address?.city?.name;
  if (street && city) return `${street}, ${city}`;
  if (street) return street;
  if (city) return city;
  return shop.name || `Магазин #${shop.id}`;
}

/** Подпись для списка выбора */
export function formatShopOptionLabel(shop: Shop): string {
  const address = formatShopAddress(shop);
  if (shop.name && shop.name !== address) {
    return `${address} · ${shop.name}`;
  }
  return address;
}
