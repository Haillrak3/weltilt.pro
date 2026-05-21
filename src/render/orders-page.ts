import { state } from '../state';
import { escapeHtml, dayKeyGMT3, todayGMT3, yesterdayGMT3 } from '../utils';
import { buildOrderNumbers } from '../ui/receipt';
import type { SavedOrder } from '../types';

const STORE_IDS = ['2', '4', '5', '6', '7', '9'];

export function needsAttention(o: SavedOrder): boolean {
  return !STORE_IDS.includes(o.storeId) || o.status !== 'done';
}

function clientPreferredStore(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return null;
  const done = state.orders
    .filter((o) => o.status === 'done' && o.client.phone.replace(/\D/g, '') === digits)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);
  if (done.length < 10) return null;
  const counts = new Map<string, number>();
  for (const o of done) counts.set(o.storeId, (counts.get(o.storeId) ?? 0) + 1);
  let best = '', bestCount = 0;
  counts.forEach((cnt, id) => { if (cnt > bestCount) { bestCount = cnt; best = id; } });
  return best || null;
}

export function filteredOrders(): SavedOrder[] {
  const { ordersFilterFrom: from, ordersFilterTo: to, ordersFilterStore: store, ordersFilterStatus: status, ordersFilterAttention: attention } = state;
  return state.orders.filter((o) => {
    if (o.deletedAt) return false;
    const dk = dayKeyGMT3(o.createdAt);
    return (!from || dk >= from) && (!to || dk <= to)
      && (!store || o.storeId === store)
      && (!status || o.status === status)
      && (!attention || needsAttention(o));
  });
}

function renderTrashView(): string {
  const deleted = state.orders.filter(o => o.deletedAt)
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));

  const orderNumbers = buildOrderNumbers();

  const rows = deleted.length
    ? deleted.map((order) => {
        const orderNum = orderNumbers.get(order.id) ?? '?';
        const dk = dayKeyGMT3(order.createdAt);
        const dateObj = new Date(new Date(order.createdAt).getTime() + 3 * 60 * 60 * 1000);
        const timeStr = dateObj.toISOString().slice(11, 16);
        const dateLabel = `${dk.slice(8)}.${dk.slice(5, 7)} ${timeStr}`;
        const delDateObj = new Date(new Date(order.deletedAt!).getTime() + 3 * 60 * 60 * 1000);
        const delLabel = `${String(delDateObj.getUTCDate()).padStart(2, '0')}.${String(delDateObj.getUTCMonth() + 1).padStart(2, '0')} ${delDateObj.toISOString().slice(11, 16)}`;
        const clientName = order.client.name || '—';
        const clientPhone = order.client.phone || '—';
        const totalStr = (order.total ?? 0).toLocaleString('ru-RU') + ' ₽';
        return `<div class="order-row trash-row">
          <div class="order-row-info">
            <span class="order-num">#${orderNum}</span>
            <span class="order-date">${escapeHtml(dateLabel)}</span>
            <span class="order-client">${escapeHtml(clientName)}</span>
            <span class="order-phone">${escapeHtml(clientPhone)}</span>
            <span class="order-items">${order.items.length} поз. · ${escapeHtml(totalStr)}</span>
            <span class="trash-del-date">удалён ${escapeHtml(delLabel)}</span>
            <button type="button" class="order-restore-btn" data-order-id="${order.id}">Восстановить</button>
            <button type="button" class="order-del-btn order-perm-del-btn" data-order-id="${order.id}" title="Удалить навсегда">✕ навсегда</button>
          </div>
        </div>`;
      }).join('')
    : `<p class="panel-status">Корзина пуста</p>`;

  return `<div class="orders-page">
    <div class="orders-toolbar">
      <div class="orders-quick-btns">
        <button type="button" class="orders-quick-btn" id="btn-trash-back">← Назад</button>
        <span style="font-size:0.82rem;color:var(--muted);align-self:center">Корзина · ${deleted.length} заказ${deleted.length === 1 ? '' : deleted.length >= 2 && deleted.length <= 4 ? 'а' : 'ов'}</span>
      </div>
    </div>
    <div class="orders-list">${rows}</div>
  </div>`;
}

export function buildFilterToolbar(): string {
  const { ordersFilterFrom: from, ordersFilterTo: to, ordersFilterStore: store, ordersFilterStatus: status } = state;
  const today = todayGMT3();
  const yesterday = yesterdayGMT3();
  const isToday = from === today && to === today;
  const isYesterday = from === yesterday && to === yesterday;
  const isAll = !from && !to;

  const STATUSES: Array<{ val: SavedOrder['status']; label: string }> = [
    { val: 'created', label: 'Создан' },
    { val: 'in_progress', label: 'В работе' },
    { val: 'done', label: 'Произведён' },
  ];

  // Заказы за текущий период (без фильтров магазина/статуса)
  const periodOrders = state.orders.filter((o) => {
    if (o.deletedAt) return false;
    const dk = dayKeyGMT3(o.createdAt);
    return (!from || dk >= from) && (!to || dk <= to);
  });
  const needAttentionCount = periodOrders.filter(needsAttention).length;
  if (needAttentionCount === 0) state.ordersFilterAttention = false;
  const activeAttention = state.ordersFilterAttention;
  const attentionHtml = needAttentionCount > 0
    ? `<button type="button" class="orders-attention${activeAttention ? ' orders-attention--active' : ''}" id="btn-filter-attention">
        Требуют внимания: <strong>${needAttentionCount}</strong>${activeAttention ? ' · <span class="attention-reset">Все</span>' : ''}
       </button>`
    : `<div class="orders-attention orders-attention--ok">Все заказы обработаны</div>`;

  const trashCount = state.orders.filter(o => o.deletedAt).length;

  return `
    <div class="orders-toolbar">
      <div class="orders-quick-btns">
        <button type="button" class="orders-quick-btn${isAll ? ' active' : ''}" id="of-all">Все</button>
        <button type="button" class="orders-quick-btn${isToday ? ' active' : ''}" id="of-today">Сегодня</button>
        <button type="button" class="orders-quick-btn${isYesterday ? ' active' : ''}" id="of-yesterday">Вчера</button>
        ${trashCount > 0 ? `<button type="button" class="orders-quick-btn orders-trash-btn" id="btn-show-trash">Корзина <span class="trash-count">${trashCount}</span></button>` : ''}
      </div>
      <div class="orders-date-range">
        <label class="orders-date-label">С <input type="date" id="of-from" class="orders-date-input" value="${escapeHtml(from)}" /></label>
        <label class="orders-date-label">По <input type="date" id="of-to" class="orders-date-input" value="${escapeHtml(to)}" /></label>
      </div>
      ${attentionHtml}
      <div class="orders-filter-row">
        <span class="orders-filter-label">Магазин:</span>
        <button type="button" class="orders-quick-btn${!store ? ' active' : ''}" data-filter-store="">Все</button>
        ${STORE_IDS.map((id) => `<button type="button" class="orders-quick-btn${store === id ? ' active' : ''}" data-filter-store="${id}">№${id}</button>`).join('')}
      </div>
      <div class="orders-filter-row">
        <span class="orders-filter-label">Статус:</span>
        <button type="button" class="orders-quick-btn${!status ? ' active' : ''}" data-filter-status="">Все</button>
        ${STATUSES.map(({ val, label }) => `<button type="button" class="orders-quick-btn${status === val ? ' active' : ''}" data-filter-status="${val}">${escapeHtml(label)}</button>`).join('')}
      </div>
    </div>`;
}

export function renderOrdersPage(): string {
  if (state.ordersShowTrash) return renderTrashView();
  const STATUSES: Array<{ val: SavedOrder['status']; label: string }> = [
    { val: 'created', label: 'Создан' },
    { val: 'in_progress', label: 'В работе' },
    { val: 'done', label: 'Произведён' },
  ];
  const STATUS_CLASS: Record<string, string> = { created: 'badge-created', in_progress: 'badge-progress', done: 'badge-done' };

  const orderNumbers = buildOrderNumbers();
  const visible = filteredOrders();
  const isAll = !state.ordersFilterFrom && !state.ordersFilterTo && !state.ordersFilterStore && !state.ordersFilterStatus && !state.ordersFilterAttention;
  const toolbar = buildFilterToolbar();

  const ordersHtml = visible.length
    ? `<div class="orders-list">${visible.map((order) => {
        const orderNum = orderNumbers.get(order.id) ?? '?';
        const dk = dayKeyGMT3(order.createdAt);
        const dateObj = new Date(new Date(order.createdAt).getTime() + 3 * 60 * 60 * 1000);
        const timeStr = dateObj.toISOString().slice(11, 16);
        const dateLabel = `${dk.slice(8)}.${dk.slice(5, 7)} ${timeStr}`;
        const clientName = order.client.name || '—';
        const clientPhone = order.client.phone || '—';
        const addrBase = [order.client.street, order.client.house].filter(Boolean).join(', ') || '—';
        const preferredStore = clientPreferredStore(order.client.phone);
        const addr = preferredStore ? `${addrBase} · №${preferredStore}` : addrBase;
        const totalStr = (order.total ?? 0).toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽';
        const methodLabel = (order.orderMethod === 'app' && order.orderAmount !== undefined) ? 'Прилож.' : 'Тел.';
        const payLabel = order.payMethod === 'cash' ? 'Нал' : 'Безнал';
        const changeLabel = order.payMethod === 'cash' && order.change ? ` · сдача ${order.change.toLocaleString('ru-RU')} ₽` : '';

        const storeChips = STORE_IDS.map((id) =>
          `<button type="button" class="order-store-btn${order.storeId === id ? ' active' : ''}" data-order-id="${order.id}" data-store-id="${id}">№${id}</button>`
        ).join('');

        const statusBtns = STATUSES.map(({ val, label }) =>
          `<button type="button" class="order-status-btn${order.status === val ? ` active ${STATUS_CLASS[val]}` : ''}" data-order-id="${order.id}" data-order-next="${val}">${escapeHtml(label)}</button>`
        ).join('');

        const isExpanded = state.expandedOrderId === order.id;

        const expandedHtml = isExpanded
          ? `<div class="order-expanded">
              ${order.items.length
                ? order.items.map((item, idx) => {
                    const lineTotal = ((item.price ?? 0) * item.qty).toLocaleString('ru-RU', { minimumFractionDigits: 0 });
                    return `<div class="order-item-row">
                      <span class="order-item-name">${escapeHtml(item.name)}${item.details ? ` <span class="order-item-detail">${escapeHtml(item.details)}</span>` : ''}</span>
                      <div class="order-item-controls">
                        <button type="button" class="qty-btn" data-oitem-dec data-order-id="${order.id}" data-item-idx="${idx}">−</button>
                        <input type="text" inputmode="decimal" class="qty-input" data-oitem-qty data-order-id="${order.id}" data-item-idx="${idx}" value="${item.qty}" />
                        <button type="button" class="qty-btn" data-oitem-inc data-order-id="${order.id}" data-item-idx="${idx}">+</button>
                        <span class="order-item-price">${(item.price ?? 0).toLocaleString('ru-RU')} ₽ × ${item.qty} = ${lineTotal} ₽</span>
                        <button type="button" class="cart-del" data-oitem-del data-order-id="${order.id}" data-item-idx="${idx}" title="Удалить позицию">✕</button>
                      </div>
                    </div>`;
                  }).join('')
                : '<p class="panel-status" style="margin:0">Нет позиций</p>'}
              <div class="order-expanded-total">Итого: ${escapeHtml(totalStr)}</div>
            </div>`
          : '';

        const storeNumBadge = STORE_IDS.includes(order.storeId)
          ? `<span class="order-store-badge">№${order.storeId}</span>`
          : '';

        const attention = needsAttention(order);
        return `<div class="order-row${isExpanded ? ' expanded' : ''}${attention ? ' order-row--attention' : ''}">
          <div class="order-row-info">
            <span class="order-num">#${orderNum}</span>
            ${storeNumBadge}
            <span class="order-date">${escapeHtml(dateLabel)}</span>
            <span class="order-client">${escapeHtml(clientName)}</span>
            <button type="button" class="order-phone-btn" data-phone="${escapeHtml(order.client.phone)}">${escapeHtml(clientPhone)}</button>
            <span class="order-addr">${escapeHtml(addr)}</span>
            <span class="order-items">${order.items.length} поз. · ${escapeHtml(totalStr)}</span>
            <span class="order-method">${escapeHtml(methodLabel)} · ${escapeHtml(payLabel)}${escapeHtml(changeLabel)}${order.orderNumber ? ` <span class="order-app-num">№${escapeHtml(order.orderNumber)}</span>` : ''}</span>
            <button type="button" class="order-expand-btn${isExpanded ? ' active' : ''}" data-order-id="${order.id}">${isExpanded ? '▲ Свернуть' : '▼ Состав'}</button>
            <button type="button" class="order-edit-btn" data-order-id="${order.id}" title="Редактировать заказ">Изменить</button>
            <button type="button" class="order-receipt-btn" data-order-id="${order.id}" title="Показать чек">Чек</button>
            <button type="button" class="order-del-btn" data-order-id="${order.id}" title="Удалить заказ">✕</button>
          </div>
          <div class="order-row-controls">
            <div class="order-store-picker">${storeChips}</div>
            <div class="order-status-picker">${statusBtns}</div>
          </div>
          ${expandedHtml}
        </div>`;
      }).join('')}</div>`
    : `<p class="panel-status">Нет заказов${!isAll ? ' за выбранный период' : ''}</p>`;

  return `<div class="orders-page">${toolbar}${ordersHtml}</div>`;
}
