import { state } from '../state';
import { escapeHtml } from '../utils';
import type { AppOrder } from '../api/types';

const STORE_NUM: Record<number, string> = {
  12: '1', 7: '2', 11: '3', 10: '4',
  13: '5', 6: '6', 14: '7', 15: '8', 16: '9',
};

const OUR_STORE_IDS = new Set(Object.keys(STORE_NUM).map(Number));

const PERIOD_LABELS = [
  { val: 'today', label: 'Сегодня' },
  { val: 'yesterday', label: 'Вчера' },
  { val: '7day', label: '7 дней' },
  { val: '28day', label: '28 дней' },
] as const;

function formatTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm} ${hh}:${min}`;
}

function findDuplicates(orders: AppOrder[]): Set<string> {
  const byPhone = new Map<string, AppOrder[]>();
  for (const o of orders) {
    const key = o.user.phone_number.phone_number;
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key)!.push(o);
  }
  const dupes = new Set<string>();
  byPhone.forEach((group) => {
    if (group.length < 2) return;
    const sorted = [...group].sort((a, b) => a.order_date.localeCompare(b.order_date));
    for (let i = 1; i < sorted.length; i++) {
      const diff = new Date(sorted[i].order_date).getTime() - new Date(sorted[i - 1].order_date).getTime();
      if (diff < 15 * 60 * 1000) {
        dupes.add(sorted[i].number);
        dupes.add(sorted[i - 1].number);
      }
    }
  });
  return dupes;
}

function renderOrder(o: AppOrder, isDupe: boolean): string {
  const phone = `${o.user.phone_number.country_code}${o.user.phone_number.phone_number}`;
  const name = o.user.name || '—';
  const time = formatTime(o.order_date);
  const total = o.total_price.toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽';
  const storeNum = STORE_NUM[o.store.id] ?? '?';
  const items = o.cart_products
    .map((p) => {
      const pack = p.pack_item ? ` ${p.pack_item.volume}л` : '';
      return `${escapeHtml(p.name)}${pack} × ${p.qty}`;
    })
    .join(', ');
  const note = o.note ? `<div class="ao-note" title="${escapeHtml(o.note)}">💬 ${escapeHtml(o.note)}</div>` : '';

  return `<div class="ao-row${isDupe ? ' ao-row--dupe' : ''}">
    <div class="ao-row-main">
      <span class="ao-num">#${escapeHtml(o.number.slice(-6))}</span>
      <span class="ao-time">${time}</span>
      <span class="ao-store-badge">№${storeNum}</span>
      <span class="ao-client">${escapeHtml(name)}</span>
      <span class="ao-phone">${escapeHtml(phone)}</span>
      <span class="ao-total">${total}</span>
    </div>
    <div class="ao-items">${escapeHtml(items)}</div>
    ${note}
  </div>`;
}

export function renderAppOrdersPage(): string {
  const { appOrders, appOrdersLoading, appOrdersError, appOrdersPeriod, appOrdersTotalCount } = state;

  const periodBtns = PERIOD_LABELS.map(({ val, label }) =>
    `<button type="button" class="orders-quick-btn${appOrdersPeriod === val ? ' active' : ''}" data-ao-period="${val}">${label}</button>`
  ).join('');

  const stats = appOrdersTotalCount > 0
    ? `<span class="refs-count">${appOrdersTotalCount} заказов</span>`
    : '';

  let content: string;
  if (appOrdersLoading) {
    content = '<p class="panel-status">Загружаем заказы…</p>';
  } else if (appOrdersError) {
    content = `<p class="panel-status panel-status--error">${escapeHtml(appOrdersError)}</p>`;
  } else {
    const filtered = appOrders.filter((o) => OUR_STORE_IDS.has(o.store.id) && o.status !== 'CANCELED' && o.status !== 'PICKED_UP');
    if (!filtered.length) {
      content = '<p class="panel-status">Заказов нет</p>';
    } else {
      const dupes = findDuplicates(filtered);
      content = `<div class="ao-list">${filtered.map((o) => renderOrder(o, dupes.has(o.number))).join('')}</div>`;
    }
  }

  return `<div class="ao-page">
    <div class="orders-toolbar ao-toolbar">
      <div class="orders-quick-btns">${periodBtns}</div>
      <button type="button" class="btn btn-ghost" id="ao-refresh-btn">Обновить</button>
      ${stats}
    </div>
    ${content}
  </div>`;
}
