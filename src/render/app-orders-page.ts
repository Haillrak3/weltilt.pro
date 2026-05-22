import { state } from '../state';
import { escapeHtml } from '../utils';
import type { AppOrder, AppOrderStatus } from '../api/types';

const STATUS_LABEL: Record<AppOrderStatus, string> = {
  CREATED: 'Создан',
  ACTIVE: 'В работе',
  PACKAGING: 'Собирается',
  READY_FOR_PICK_UP: 'Готов',
  PICKED_UP: 'Выдан',
  CANCELED: 'Отменён',
};

const STATUS_CLASS: Record<AppOrderStatus, string> = {
  CREATED: 'ao-status--created',
  ACTIVE: 'ao-status--active',
  PACKAGING: 'ao-status--packaging',
  READY_FOR_PICK_UP: 'ao-status--ready',
  PICKED_UP: 'ao-status--done',
  CANCELED: 'ao-status--canceled',
};

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

function renderOrder(o: AppOrder): string {
  const phone = `${o.user.phone_number.country_code}${o.user.phone_number.number}`;
  const name = o.user.name || '—';
  const time = formatTime(o.order_date);
  const total = o.total_price.toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽';
  const statusLabel = STATUS_LABEL[o.status] ?? o.status;
  const statusClass = STATUS_CLASS[o.status] ?? '';
  const items = o.cart_products
    .map((p) => {
      const pack = p.pack_item ? ` ${p.pack_item.volume}л` : '';
      return `${escapeHtml(p.name)}${pack} × ${p.qty}`;
    })
    .join(', ');
  const note = o.note ? `<div class="ao-note" title="${escapeHtml(o.note)}">💬 ${escapeHtml(o.note)}</div>` : '';

  const canProgress = o.status !== 'PICKED_UP' && o.status !== 'CANCELED';

  return `<div class="ao-row${o.status === 'CANCELED' ? ' ao-row--canceled' : ''}">
    <div class="ao-row-main">
      <span class="ao-num">#${escapeHtml(o.number.slice(-6))}</span>
      <span class="ao-time">${time}</span>
      <span class="ao-status ${statusClass}">${statusLabel}</span>
      <span class="ao-store">${escapeHtml(o.store.name)}</span>
      <span class="ao-client">${escapeHtml(name)}</span>
      <span class="ao-phone">${escapeHtml(phone)}</span>
      <span class="ao-total">${total}</span>
      ${canProgress ? `<button type="button" class="btn btn-sm btn-ghost ao-progress-btn" data-ao-number="${escapeHtml(o.number)}">▶</button>` : '<span></span>'}
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
  } else if (!appOrders.length) {
    content = '<p class="panel-status">Заказов нет</p>';
  } else {
    content = `<div class="ao-list">${appOrders.map(renderOrder).join('')}</div>`;
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
