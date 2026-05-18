import { state } from '../state';
import { escapeHtml, normalize } from '../utils';
import { allClientsDeduped, getClientAddresses } from '../data/clients';
import { buildOrderNumbers } from '../ui/receipt';

export function renderCountriesSection(): string {
  const rows = state.countries.map((e, i) => `
    <tr class="country-row">
      <td>${escapeHtml(e.keyword)}</td>
      <td>${escapeHtml(e.country)}</td>
      <td><button type="button" class="btn btn-ghost country-del-btn" data-country-idx="${i}">✕</button></td>
    </tr>`).join('');

  return `
    <div class="countries-section">
      <div class="countries-header" id="btn-countries-toggle">
        <span>Словарь стран</span>
        <span class="countries-count">${state.countries.length}</span>
        <span class="countries-arrow">${state.countriesExpanded ? '▲' : '▼'}</span>
      </div>
      ${state.countriesExpanded ? `
        <table class="countries-table">
          <thead><tr><th>Ключевое слово</th><th>Страна</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="countries-add-row">
          <input type="text" id="country-keyword" class="client-input" placeholder="Ключевое слово (напр. kilikia)" />
          <input type="text" id="country-name" class="client-input" placeholder="Страна (напр. Армения)" />
          <button type="button" class="btn btn-primary" id="btn-country-add">Добавить</button>
        </div>
      ` : ''}
    </div>`;
}

export function renderRefsClientOrders(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const clientOrders = state.orders
    .filter((o) => o.client.phone.replace(/\D/g, '') === digits)
    .slice(0, 30);
  if (!clientOrders.length) return '<p class="panel-status">Нет заказов</p>';
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
  return `<div class="client-history">${rows}</div>`;
}

export function renderRefsEditForm(): string {
  const c = state.refsEditDraft;
  if (!c) return '';
  const f = (id: string, label: string, val: string) =>
    `<label class="client-field">
      <span>${escapeHtml(label)}</span>
      <input type="text" id="ref-edit-${id}" class="refs-edit-input client-input" data-ref="${id}" value="${escapeHtml(val)}" />
    </label>`;
  const af = (id: string, label: string) =>
    `<label class="client-field">
      <span>${escapeHtml(label)}</span>
      <input type="text" id="${id}" class="client-input" value="" />
    </label>`;

  const addresses = getClientAddresses(c);
  const addrListHtml = addresses.map((a, i) => {
    const parts = [a.street, a.house,
      a.entrance ? `подъезд ${a.entrance}` : '',
      a.floor ? `эт. ${a.floor}` : '',
      a.apartment ? `кв. ${a.apartment}` : '',
    ].filter(Boolean).join(', ');
    return `<div class="refs-addr-row">
      <span class="refs-addr-label">${escapeHtml(parts || 'Пустой адрес')}</span>
      <button type="button" class="refs-addr-del-btn btn btn-ghost" data-addr-del-idx="${i}">✕</button>
    </div>`;
  }).join('');

  const addFormHtml = state.refsAddAddrVisible
    ? `<div class="refs-add-addr-form">
        ${af('raaf-street', 'Улица')}
        ${af('raaf-house', 'Дом')}
        ${af('raaf-entrance', 'Подъезд')}
        ${af('raaf-floor', 'Этаж')}
        ${af('raaf-apartment', 'Квартира')}
        ${af('raaf-intercom', 'Код домофона')}
        <div class="refs-add-addr-actions">
          <button type="button" class="btn btn-primary" id="btn-refs-addr-save">Добавить</button>
          <button type="button" class="btn btn-ghost" id="btn-refs-addr-cancel">Отмена</button>
        </div>
      </div>`
    : `<button type="button" class="btn btn-ghost" id="btn-refs-add-addr">+ Добавить адрес</button>`;

  return `
    <div class="refs-edit-form">
      ${f('phone', 'Телефон', c.phone)}
      ${f('name', 'Имя', c.name)}
      ${f('street', 'Улица', c.street)}
      ${f('house', 'Дом', c.house)}
      ${f('entrance', 'Подъезд', c.entrance)}
      ${f('floor', 'Этаж', c.floor)}
      ${f('apartment', 'Квартира', c.apartment)}
      ${f('intercom', 'Код домофона', c.intercom)}
      <label class="client-field">
        <span>Примечания</span>
        <textarea id="ref-edit-notes" class="refs-edit-input client-input client-textarea" data-ref="notes" rows="3">${escapeHtml(c.notes)}</textarea>
      </label>
      <div class="refs-addresses">
        <div class="refs-addresses-title">Адреса (${addresses.length})</div>
        ${addrListHtml}
        ${addFormHtml}
      </div>
      <div class="refs-edit-actions">
        <button type="button" class="btn btn-primary" id="btn-refs-save">Сохранить</button>
      </div>
    </div>`;
}

const PAGE_SIZE = 50;

export function renderRefsPage(): string {
  const q = state.refsClientSearch.trim();
  const all = allClientsDeduped();
  const lq = normalize(q);
  const digits = q.replace(/\D/g, '');
  const filtered = q
    ? all.filter((c) =>
        normalize(c.name).includes(lq) ||
        (digits && c.phone.replace(/\D/g, '').includes(digits)),
      )
    : all;

  const totalPages = q ? 1 : Math.ceil(filtered.length / PAGE_SIZE);
  const page = Math.min(state.refsPage, Math.max(0, totalPages - 1));
  const pageClients = q ? filtered : filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const rows = pageClients.map((client) => {
    const phoneDigits = client.phone.replace(/\D/g, '');
    const isExpanded = state.refsExpandedPhone === phoneDigits;
    const addr = [client.street, client.house, client.apartment ? `кв. ${client.apartment}` : '']
      .filter(Boolean).join(', ');
    const expandedHtml = isExpanded
      ? `<div class="refs-client-detail">
          <nav class="refs-client-tabs">
            <button type="button" class="refs-ctab${state.refsClientTab === 'orders' ? ' active' : ''}" data-ctab="orders" data-refs-phone="${phoneDigits}">Заказы</button>
            <button type="button" class="refs-ctab${state.refsClientTab === 'edit' ? ' active' : ''}" data-ctab="edit" data-refs-phone="${phoneDigits}">Редактировать</button>
          </nav>
          <div class="refs-client-body">
            ${state.refsClientTab === 'orders' ? renderRefsClientOrders(client.phone) : renderRefsEditForm()}
          </div>
        </div>`
      : '';
    return `
      <div class="refs-client-row${isExpanded ? ' expanded' : ''}">
        <div class="refs-client-head">
          <span class="refs-client-name">${escapeHtml(client.name || '—')}</span>
          <span class="refs-client-phone">${escapeHtml(client.phone)}</span>
          ${addr ? `<span class="refs-client-addr">${escapeHtml(addr)}</span>` : ''}
          ${client.notes ? `<span class="refs-client-notes" title="${escapeHtml(client.notes)}">${escapeHtml(client.notes)}</span>` : ''}
          <button type="button" class="refs-expand-btn" data-refs-phone="${phoneDigits}">${isExpanded ? '▲' : '▼'}</button>
        </div>
        ${expandedHtml}
      </div>`;
  }).join('');

  const paginationHtml = !q && totalPages > 1 ? `
    <div class="refs-pagination">
      <button type="button" class="btn btn-ghost refs-page-btn" id="refs-prev-page" ${page === 0 ? 'disabled' : ''}>← Назад</button>
      <span class="refs-page-info">${page + 1} / ${totalPages}</span>
      <button type="button" class="btn btn-ghost refs-page-btn" id="refs-next-page" ${page >= totalPages - 1 ? 'disabled' : ''}>Вперёд →</button>
    </div>` : '';

  return `
    <div class="refs-page">
      ${renderCountriesSection()}
      <div class="refs-toolbar">
        <input type="search" id="refs-search" class="search-input" placeholder="Поиск по имени или телефону…" value="${escapeHtml(state.refsClientSearch)}" />
        <span class="refs-count">${filtered.length} клиентов</span>
      </div>
      <div class="refs-clients-list">
        ${rows || '<p class="panel-status">Клиентов не найдено</p>'}
      </div>
      ${paginationHtml}
    </div>`;
}
