import { state } from '../state';
import { escapeHtml, normalize } from '../utils';
import { allClientsDeduped } from '../data/clients';

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
    const addr = [client.street, client.house, client.apartment ? `кв. ${client.apartment}` : '']
      .filter(Boolean).join(', ');
    return `
      <button type="button" class="refs-client-row" data-refs-phone="${phoneDigits}">
        <span class="refs-client-name">${escapeHtml(client.name || '—')}</span>
        <span class="refs-client-phone">${escapeHtml(client.phone)}</span>
        ${addr ? `<span class="refs-client-addr">${escapeHtml(addr)}</span>` : ''}
        ${client.notes ? `<span class="refs-client-notes" title="${escapeHtml(client.notes)}">${escapeHtml(client.notes)}</span>` : ''}
      </button>`;
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
