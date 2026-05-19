import { state } from '../state';
import { escapeHtml, formatPhone } from '../utils';
import { repeatOrder } from '../data/orders';
import { buildOrderNumbers } from './receipt';

function formatDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm} ${hh}:${min}`;
}

export function openClientHistoryModal(phone: string): void {
  const digits = phone.replace(/\D/g, '');
  const orders = state.orders
    .filter((o) => o.client.phone.replace(/\D/g, '') === digits)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!orders.length) return;

  const orderNumbers = buildOrderNumbers();
  const clientName = orders[0].client.name || formatPhone(phone);

  const ordersHtml = orders.map((order) => {
    const num = orderNumbers.get(order.id) ?? '?';
    const totalStr = (order.total ?? 0).toLocaleString('ru-RU') + ' ₽';
    const payLabel = order.payMethod === 'cash' ? 'Нал' : 'Безнал';
    const STATUS_LABEL: Record<string, string> = { created: 'Создан', in_progress: 'В работе', done: 'Выдан' };

    const itemsHtml = order.items.map((item) => {
      const lineTotal = (item.price * item.qty).toLocaleString('ru-RU');
      const unitStr = item.productType === 'WEIGHT'
        ? `${item.price * 10} ₽/кг`
        : `${item.price.toLocaleString('ru-RU')} ₽`;
      return `<div class="op-row">
        <span class="op-name">${escapeHtml(item.name)}</span>
        <span class="op-qty-price">${item.qty} × ${escapeHtml(unitStr)} = <b>${escapeHtml(lineTotal)} ₽</b></span>
      </div>`;
    }).join('');

    return `<div class="op-hist-order">
      <div class="op-hist-header">
        <span class="op-num">#${num}</span>
        <span class="op-date">${escapeHtml(formatDate(order.createdAt))}</span>
        ${order.storeId ? `<span class="op-badge">№${escapeHtml(order.storeId)}</span>` : ''}
        <span class="op-badge">${escapeHtml(payLabel)}</span>
        <span class="op-hist-status">${escapeHtml(STATUS_LABEL[order.status] ?? order.status)}</span>
        <span class="op-hist-total">${escapeHtml(totalStr)}</span>
        <button type="button" class="btn btn-sm btn-primary op-repeat-btn" data-order-id="${order.id}">Повторить</button>
      </div>
      <div class="op-items">${itemsHtml || '<span class="muted">Нет позиций</span>'}</div>
    </div>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-wide op-modal" role="dialog">
      <div class="op-hist-title">
        История — <b>${escapeHtml(clientName)}</b>
        <span class="op-hist-count">${orders.length} зак.</span>
      </div>
      <div class="op-hist-list">${ordersHtml}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="op-hist-close">Закрыть</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.querySelector('#op-hist-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelectorAll<HTMLButtonElement>('.op-repeat-btn').forEach((btn) => {
    btn.addEventListener('click', () => { overlay.remove(); repeatOrder(btn.dataset.orderId ?? ''); });
  });
}
