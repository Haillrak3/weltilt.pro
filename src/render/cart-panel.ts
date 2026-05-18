import { state } from '../state';
import { escapeHtml, formatPhone, formatProductName, unitPrice } from '../utils';
import { getCartSum } from '../data/cart';
import { searchClients, findClientByPhone, getClientAddresses } from '../data/clients';
import { buildOrderNumbers } from '../ui/receipt';

export function renderClientHistory(): string {
  const digits = state.client.phone.replace(/\D/g, '');
  if (digits.length < 7) return '';

  const clientOrders = state.orders
    .filter((o) => o.client.phone.replace(/\D/g, '') === digits)
    .slice(0, 15);

  if (!clientOrders.length) return '';

  const orderNumbers = buildOrderNumbers();
  const STATUS_LABEL: Record<string, string> = { created: 'Создан', in_progress: 'В работе', done: 'Произведён' };
  const STATUS_CLS: Record<string, string> = { created: 'ch-s-created', in_progress: 'ch-s-progress', done: 'ch-s-done' };

  const rows = clientOrders.map((order) => {
    const num = orderNumbers.get(order.id) ?? '?';
    const dateObj = new Date(new Date(order.createdAt).getTime() + 3 * 60 * 60 * 1000);
    const dk = dateObj.toISOString().slice(0, 10);
    const dateLabel = `${dk.slice(8)}.${dk.slice(5, 7)} ${dateObj.toISOString().slice(11, 16)}`;
    const totalStr = order.total.toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽';
    return `
      <div class="ch-row">
        <span class="ch-num">#${num}</span>
        <span class="ch-date">${escapeHtml(dateLabel)}</span>
        <span class="ch-items">${order.items.length} поз.</span>
        <span class="ch-total">${escapeHtml(totalStr)}</span>
        <span class="ch-status ${STATUS_CLS[order.status] ?? ''}">${escapeHtml(STATUS_LABEL[order.status] ?? order.status)}</span>
        <button type="button" class="ch-receipt-btn" data-order-id="${order.id}">Чек</button>
      </div>`;
  }).join('');

  return `
    <div class="client-history">
      <div class="client-history-title">История заказов&thinsp;(${clientOrders.length})</div>
      ${rows}
    </div>`;
}

function renderAddressPicker(): string {
  const digits = state.client.phone.replace(/\D/g, '');
  if (digits.length < 7) return '';
  const client = findClientByPhone(digits);
  if (!client) return '';
  const addresses = getClientAddresses(client);
  if (!addresses.length) return '';

  const currentKey = [
    state.client.street, state.client.house, state.client.entrance,
    state.client.floor, state.client.apartment, state.client.intercom,
  ].map((s) => s.trim().toLowerCase()).join('|');

  const chips = addresses.map((a, i) => {
    const label = [a.street, a.house, a.apartment ? `кв. ${a.apartment}` : ''].filter(Boolean).join(', ');
    const aKey = [a.street, a.house, a.entrance, a.floor, a.apartment, a.intercom]
      .map((s) => s.trim().toLowerCase()).join('|');
    const active = aKey === currentKey && currentKey !== '|||||';
    return `<button type="button" class="addr-chip${active ? ' active' : ''}" data-addr-idx="${i}">${escapeHtml(label || `Адрес ${i + 1}`)}</button>`;
  }).join('');

  return `<div class="addr-picker">${chips}<button type="button" class="addr-chip addr-chip-new" data-addr-idx="-1">+ Новый адрес</button></div>`;
}

export function renderClientForm(): string {
  const c = state.client;
  const f = (id: string, label: string, val: string, type = 'text') =>
    `<label class="client-field">
      <span>${escapeHtml(label)}</span>
      <input type="${type}" id="cl-${id}" class="client-input" data-cl="${id}" value="${escapeHtml(val)}" />
    </label>`;

  const digits = c.phone.replace(/\D/g, '');
  const pastCount = digits.length >= 7
    ? state.orders.filter((o) => o.client.phone.replace(/\D/g, '') === digits).length
    : 0;
  const historyBtn = pastCount > 0
    ? `<button type="button" class="btn-client-history" id="btn-client-history">${pastCount} зак.</button>`
    : '';

  const suggestions = state.clientSuggestHidden ? [] : searchClients(c.phone);
  const suggestionsHtml = suggestions.length
    ? `<ul class="client-suggestions">${suggestions.map((s, i) =>
        `<li class="client-suggestion" data-suggest-idx="${i}">
          <span class="suggest-phone">${escapeHtml(formatPhone(s.phone))}</span>
          <span class="suggest-name">${escapeHtml(s.name)}</span>
          <span class="suggest-addr">${escapeHtml([s.street, s.house, s.apartment].filter(Boolean).join(', '))}</span>
        </li>`).join('')}</ul>`
    : '';

  return `
    <div class="client-form">
      <label class="client-field">
        <span>Телефон</span>
        <input type="tel" id="cl-phone" class="client-input" data-cl="phone" value="${escapeHtml(formatPhone(c.phone) || c.phone)}" />
      </label>
      ${suggestionsHtml}
      <div class="client-name-row">
        ${f('name', 'Имя', c.name)}
        ${historyBtn}
      </div>
      ${renderAddressPicker()}
      ${f('street', 'Улица', c.street)}
      ${f('house', 'Дом', c.house)}
      ${f('entrance', 'Подъезд', c.entrance)}
      ${f('floor', 'Этаж', c.floor)}
      ${f('apartment', 'Квартира', c.apartment)}
      ${f('intercom', 'Код домофона', c.intercom)}
      <label class="client-field">
        <span>Примечания</span>
        <textarea id="cl-notes" class="client-input client-textarea" data-cl="notes" rows="3">${escapeHtml(c.notes)}</textarea>
      </label>
    </div>`;
}

export function renderOrderMeta(): string {
  const { payMethod } = state.orderMeta;
  const opt = (group: string, val: string, label: string, active: boolean) =>
    `<button type="button" class="meta-btn${active ? ' active' : ''}" data-meta-group="${group}" data-meta-val="${val}">${escapeHtml(label)}</button>`;
  return `
    <div class="order-meta-form">
      <div class="meta-group">
        <span class="meta-label">Способ оплаты</span>
        <div class="meta-options">
          ${opt('payMethod', 'cash', 'Наличные', payMethod === 'cash')}
          ${opt('payMethod', 'card', 'Безнал', payMethod === 'card')}
        </div>
      </div>
    </div>`;
}

export function renderCartItems(): string {
  const editBanner = state.editingOrderId
    ? '<div class="edit-banner">Редактирование заказа</div>'
    : '';

  if (!state.cart.length) {
    return editBanner + '<p class="cart-empty">Корзина пуста</p>';
  }

  return editBanner + `<ul class="cart-list">${state.cart
    .map((item, index) => {
      const isDraft = item.draftVolume !== undefined;
      const nameHtml = formatProductName(item.product)
        + (isDraft ? ` <span class="cart-draft-vol">${item.draftVolume} л</span>` : '');
      const isLocal = item.product.id < 0;
      const isFixedPrice = /(тара|бутылка|пакет)/i.test(item.product.name ?? '');
      const perUnit = unitPrice(item.product, item.draftVolume);
      const linePrice = perUnit * item.qty;
      const linePriceStr = linePrice.toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽';
      const perUnitStr = perUnit.toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽';
      const priceCell = isLocal && !isFixedPrice
        ? `<div class="cart-item-price">
             <input type="text" inputmode="decimal" class="cart-price-input" data-cart-price="${index}"
               value="${item.product.price ?? 0}" title="Цена" />
             <span class="cart-price-unit">₽ · ${escapeHtml(linePriceStr)}</span>
           </div>`
        : `<div class="cart-item-price">${escapeHtml(perUnitStr)} · ${escapeHtml(linePriceStr)}</div>`;
      return `
        <li class="cart-item">
          <div class="cart-item-name">${nameHtml}</div>
          ${priceCell}
          <div class="cart-item-controls">
            <button type="button" class="qty-btn" data-cart-dec="${index}">−</button>
            <input type="text" inputmode="decimal" class="qty-input" data-cart-qty="${index}" value="${item.qty}" />
            <button type="button" class="qty-btn" data-cart-inc="${index}">+</button>
            <button type="button" class="cart-del" data-cart-del="${index}" title="Удалить">✕</button>
          </div>
        </li>`;
    })
    .join('')}</ul>`;
}


export function renderAppMode(): string {
  const { orderNumber, orderAmount, deliveryPrice, packageQty } = state.orderApp;
  const pkg = state.localProducts.find((lp) => /пакет/i.test(lp.name));
  const pkgName = pkg ? escapeHtml(pkg.name) : 'Пакет';
  const pkgPrice = pkg ? `${pkg.price.toLocaleString('ru-RU')} ₽` : '';
  const editBanner = state.editingOrderId ? '<div class="edit-banner">Редактирование заказа</div>' : '';

  const c = state.client;
  const addrPart = [c.street, c.house, c.apartment ? `кв. ${c.apartment}` : ''].filter(Boolean).join(', ');

  const suggestions = state.clientSuggestHidden ? [] : searchClients(c.phone);
  const suggestionsHtml = suggestions.length
    ? `<ul class="client-suggestions">${suggestions.map((s, i) =>
        `<li class="client-suggestion" data-suggest-idx="${i}">
          <span class="suggest-phone">${escapeHtml(formatPhone(s.phone))}</span>
          <span class="suggest-name">${escapeHtml(s.name)}</span>
          <span class="suggest-addr">${escapeHtml([s.street, s.house, s.apartment].filter(Boolean).join(', '))}</span>
        </li>`).join('')}</ul>`
    : '';

  const clientSection = state.appClientExpanded
    ? `<div class="app-client-expanded">
        <button type="button" class="btn btn-ghost app-client-toggle" id="btn-app-client-expand">▲ Свернуть</button>
        ${renderClientForm()}
      </div>`
    : `<div class="app-client-compact">
        <div class="app-client-phone-row">
          <input type="tel" id="cl-phone" class="client-input app-phone-input" data-cl="phone"
            placeholder="Телефон" value="${escapeHtml(formatPhone(c.phone) || c.phone)}" />
          <button type="button" class="btn btn-ghost app-client-toggle" id="btn-app-client-expand">▼ Подробнее</button>
        </div>
        ${suggestionsHtml}
        ${addrPart ? `<div class="app-client-addr">${escapeHtml(addrPart)}</div>` : ''}
      </div>`;

  return editBanner + `
    <div class="app-mode-view">
      ${clientSection}
      <div class="app-order-fields">
        <div class="meta-group">
          <div class="meta-label">Номер заказа</div>
          <input type="text" class="client-input" id="oa-order-number"
            placeholder="№ из приложения" value="${escapeHtml(orderNumber)}" />
        </div>
        <div class="meta-group">
          <div class="meta-label">Сумма заказа</div>
          <input type="text" inputmode="decimal" class="client-input" id="oa-order-amount"
            placeholder="0" value="${escapeHtml(orderAmount)}" />
        </div>
        <div class="meta-group">
          <div class="meta-label">Доставка</div>
          <input type="text" inputmode="decimal" class="client-input" id="oa-delivery-price"
            value="${deliveryPrice}" />
        </div>
        <div class="meta-group">
          <div class="meta-label">${pkgName}${pkgPrice ? ` · ${pkgPrice}` : ''}</div>
          <div class="cart-item-controls">
            <button type="button" class="qty-btn" id="oa-pkg-dec">−</button>
            <input type="text" inputmode="decimal" class="qty-input" id="oa-pkg-qty"
              value="${packageQty}" />
            <button type="button" class="qty-btn" id="oa-pkg-inc">+</button>
          </div>
        </div>
      </div>
    </div>`;
}

export function renderCartFooter(): string {
  const isApp = state.orderMode === 'app';
  if (!state.cart.length && !state.editingOrderId && !isApp) return '';

  const cartSum = getCartSum();
  const total = isApp
    ? (parseFloat(state.orderApp.orderAmount) || 0) + state.orderApp.deliveryPrice + cartSum
    : cartSum;

  const totalLine = `<span class="cart-total-label">Итого</span><span>${escapeHtml(total.toLocaleString('ru-RU') + ' ₽')}</span>`;

  const actionBtn = state.editingOrderId
    ? `<button type="button" class="btn btn-primary btn-create-order" id="btn-create-order">Сохранить изменения</button>
       <button type="button" class="btn btn-ghost" id="btn-cancel-edit">Отменить</button>`
    : `<button type="button" class="btn btn-primary btn-create-order" id="btn-create-order">Создать заказ</button>`;

  return `
    <div class="cart-footer">
      <div class="cart-total">${totalLine}</div>
      <div class="cart-footer-actions">${actionBtn}</div>
    </div>`;
}
