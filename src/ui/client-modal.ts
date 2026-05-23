import { state } from '../state';
import { escapeHtml } from '../utils';
import { getClientAddresses, saveClientRecord, allClientsDeduped } from '../data/clients';
import { buildOrderNumbers, showOrderReceipt } from './receipt';
import { render } from '../render/trigger';
import type { DbClient, ClientAddress } from '../types';

type ModalTab = 'edit' | 'orders';

function formatDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm} ${hh}:${min}`;
}

function renderOrdersTab(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const orders = state.orders
    .filter((o) => !o.deletedAt && o.client.phone.replace(/\D/g, '') === digits)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!orders.length) return '<p class="panel-status" style="margin:16px 0">Нет заказов</p>';
  const orderNumbers = buildOrderNumbers();
  const STATUS_LABEL: Record<string, string> = { created: 'Создан', in_progress: 'В работе', done: 'Произведён' };
  const STATUS_CLS: Record<string, string> = { created: 'ch-s-created', in_progress: 'ch-s-progress', done: 'ch-s-done' };
  return orders.map((order) => {
    const num = orderNumbers.get(order.id) ?? '?';
    const totalStr = (order.total ?? 0).toLocaleString('ru-RU') + ' ₽';
    return `<div class="ch-row">
      <span class="ch-num">#${num}</span>
      <span class="ch-date">${escapeHtml(formatDate(order.createdAt))}</span>
      <span class="ch-items">${order.items.length} поз.</span>
      <span class="ch-total">${escapeHtml(totalStr)}</span>
      <span class="ch-status ${STATUS_CLS[order.status] ?? ''}">${escapeHtml(STATUS_LABEL[order.status] ?? order.status)}</span>
      <button type="button" class="ch-receipt-btn cm-receipt-btn" data-order-id="${order.id}">Чек</button>
    </div>`;
  }).join('');
}

function renderEditTab(draft: DbClient, addAddrVisible: boolean, editAddrIdx: number | null): string {
  const f = (id: string, label: string, val: string) =>
    `<label class="client-field">
      <span>${escapeHtml(label)}</span>
      <input type="text" id="cm-${id}" class="client-input" value="${escapeHtml(val)}" />
    </label>`;
  const addrFields = (prefix: string, a: ClientAddress) => {
    const LABELS: Record<string, string> = { street:'Улица', house:'Дом', entrance:'Подъезд', floor:'Этаж', apartment:'Квартира', intercom:'Код домофона' };
    return Object.keys(LABELS).map(fld =>
      `<label class="client-field"><span>${LABELS[fld]}</span>
       <input type="text" id="${prefix}-${fld}" class="client-input" value="${escapeHtml((a as unknown as Record<string,string>)[fld] ?? '')}" /></label>`
    ).join('');
  };

  const addresses = getClientAddresses(draft);
  const addrListHtml = addresses.map((a, i) => {
    const parts = [a.street, a.house,
      a.entrance ? `подъезд ${a.entrance}` : '',
      a.floor ? `эт. ${a.floor}` : '',
      a.apartment ? `кв. ${a.apartment}` : '',
    ].filter(Boolean).join(', ');
    if (editAddrIdx === i) {
      return `<div class="refs-add-addr-form">
        ${addrFields('cm-eaf', a)}
        <div class="refs-add-addr-actions">
          <button type="button" class="btn btn-primary" id="cm-addr-edit-save" data-idx="${i}">Сохранить</button>
          <button type="button" class="btn btn-ghost" id="cm-addr-edit-cancel">Отмена</button>
        </div>
      </div>`;
    }
    return `<div class="refs-addr-row">
      <span class="refs-addr-label">${escapeHtml(parts || 'Пустой адрес')}</span>
      <button type="button" class="btn btn-ghost refs-addr-edit-btn cm-addr-edit" data-idx="${i}" title="Редактировать">✎</button>
      <button type="button" class="refs-addr-del-btn btn btn-ghost cm-addr-del" data-idx="${i}">✕</button>
    </div>`;
  }).join('');

  const addFormHtml = addAddrVisible
    ? `<div class="refs-add-addr-form">
        ${addrFields('cm-raaf', { street:'', house:'', entrance:'', floor:'', apartment:'', intercom:'' })}
        <div class="refs-add-addr-actions">
          <button type="button" class="btn btn-primary" id="cm-addr-save">Добавить</button>
          <button type="button" class="btn btn-ghost" id="cm-addr-cancel">Отмена</button>
        </div>
      </div>`
    : `<button type="button" class="btn btn-ghost" id="cm-add-addr">+ Добавить адрес</button>`;

  return `
    <div class="refs-edit-form cm-edit-form">
      ${f('phone', 'Телефон', draft.phone)}
      ${f('name', 'Имя', draft.name)}
      ${f('street', 'Улица', draft.street)}
      ${f('house', 'Дом', draft.house)}
      ${f('entrance', 'Подъезд', draft.entrance)}
      ${f('floor', 'Этаж', draft.floor)}
      ${f('apartment', 'Квартира', draft.apartment)}
      ${f('intercom', 'Код домофона', draft.intercom)}
      <label class="client-field">
        <span>Примечания</span>
        <textarea id="cm-notes" class="client-input client-textarea" rows="3">${escapeHtml(draft.notes)}</textarea>
      </label>
      <div class="refs-addresses">
        <div class="refs-addresses-title">Адреса (${addresses.length})</div>
        ${addrListHtml}
        ${addFormHtml}
      </div>
    </div>`;
}

export function openClientModal(phoneDigits: string): void {
  const found = allClientsDeduped().find((c) => c.phone.replace(/\D/g, '') === phoneDigits);
  const emptyClient: DbClient = {
    phone: phoneDigits, name: '', street: '', house: '', entrance: '',
    floor: '', apartment: '', intercom: '', notes: '', addresses: [],
  };
  let draft: DbClient = found ? { ...found, addresses: [...(found.addresses ?? [])] } : emptyClient;
  if (!draft.street && !draft.house && draft.addresses && draft.addresses.length > 0) {
    const a = draft.addresses[0];
    draft.street = a.street; draft.house = a.house; draft.entrance = a.entrance;
    draft.floor = a.floor; draft.apartment = a.apartment; draft.intercom = a.intercom;
  }
  let tab: ModalTab = 'edit';
  let addAddrVisible = false;
  let editAddrIdx: number | null = null;
  let savedPhone = phoneDigits;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  function readInputsToDraft(): void {
    const g = (id: string) => (document.getElementById(`cm-${id}`) as HTMLInputElement | null)?.value ?? '';
    draft.phone = g('phone');
    draft.name = g('name');
    draft.street = g('street');
    draft.house = g('house');
    draft.entrance = g('entrance');
    draft.floor = g('floor');
    draft.apartment = g('apartment');
    draft.intercom = g('intercom');
    draft.notes = (document.getElementById('cm-notes') as HTMLTextAreaElement | null)?.value ?? '';
  }

  function rerender(): void {
    const ordersCount = state.orders.filter(
      (o) => !o.deletedAt && o.client.phone.replace(/\D/g, '') === savedPhone,
    ).length;
    overlay.innerHTML = `
      <div class="modal modal-wide cm-modal" role="dialog">
        <div class="cm-header">
          <span class="cm-title">${escapeHtml(draft.name || draft.phone || 'Клиент')}</span>
          <span class="cm-phone">${escapeHtml(draft.phone)}</span>
          <button type="button" class="modal-close-btn" id="cm-close">✕</button>
        </div>
        <nav class="refs-client-tabs cm-tabs">
          <button type="button" class="refs-ctab${tab === 'edit' ? ' active' : ''}" id="cm-tab-edit">Редактировать</button>
          <button type="button" class="refs-ctab${tab === 'orders' ? ' active' : ''}" id="cm-tab-orders">Заказы${ordersCount ? ` (${ordersCount})` : ''}</button>
        </nav>
        <div class="cm-body">
          ${tab === 'edit' ? renderEditTab(draft, addAddrVisible, editAddrIdx) : renderOrdersTab(draft.phone)}
        </div>
        ${tab === 'edit' ? `<div class="cm-footer"><button type="button" class="btn btn-primary" id="cm-save">Сохранить</button></div>` : ''}
      </div>`;
    attachHandlers();
  }

  function attachHandlers(): void {
    document.getElementById('cm-close')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('cm-tab-edit')?.addEventListener('click', () => {
      readInputsToDraft();
      tab = 'edit';
      rerender();
    });
    document.getElementById('cm-tab-orders')?.addEventListener('click', () => {
      readInputsToDraft();
      tab = 'orders';
      rerender();
    });

    document.getElementById('cm-save')?.addEventListener('click', () => {
      readInputsToDraft();
      const oldDigits = savedPhone;
      const newDigits = draft.phone.replace(/\D/g, '');
      if (oldDigits && oldDigits !== newDigits) {
        state.extraClients = state.extraClients.filter((c) => c.phone.replace(/\D/g, '') !== oldDigits);
      }
      saveClientRecord(draft);
      savedPhone = newDigits;
      render();
      rerender();
    });

    document.querySelectorAll<HTMLButtonElement>('.cm-addr-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        readInputsToDraft();
        const addresses = getClientAddresses(draft);
        addresses.splice(Number(btn.dataset.idx), 1);
        draft.addresses = addresses;
        editAddrIdx = null;
        rerender();
      });
    });

    document.querySelectorAll<HTMLButtonElement>('.cm-addr-edit').forEach((btn) => {
      btn.addEventListener('click', () => {
        readInputsToDraft();
        editAddrIdx = Number(btn.dataset.idx);
        addAddrVisible = false;
        rerender();
      });
    });

    document.getElementById('cm-addr-edit-cancel')?.addEventListener('click', () => {
      editAddrIdx = null;
      rerender();
    });

    document.getElementById('cm-addr-edit-save')?.addEventListener('click', () => {
      const idx = editAddrIdx;
      if (idx === null) return;
      const get = (fld: string) => (document.getElementById(`cm-eaf-${fld}`) as HTMLInputElement | null)?.value.trim() ?? '';
      const updated: ClientAddress = {
        street: get('street'), house: get('house'), entrance: get('entrance'),
        floor: get('floor'), apartment: get('apartment'), intercom: get('intercom'),
      };
      readInputsToDraft();
      const addresses = getClientAddresses(draft);
      addresses[idx] = updated;
      draft.addresses = addresses;
      editAddrIdx = null;
      rerender();
    });

    document.getElementById('cm-add-addr')?.addEventListener('click', () => {
      readInputsToDraft();
      addAddrVisible = true;
      rerender();
    });
    document.getElementById('cm-addr-cancel')?.addEventListener('click', () => {
      addAddrVisible = false;
      rerender();
    });
    document.getElementById('cm-addr-save')?.addEventListener('click', () => {
      const get = (id: string) => (document.getElementById(`cm-raaf-${id}`) as HTMLInputElement | null)?.value.trim() ?? '';
      const addr: ClientAddress = {
        street: get('street'), house: get('house'),
        entrance: get('entrance'), floor: get('floor'),
        apartment: get('apartment'), intercom: get('intercom'),
      };
      if (!addr.street && !addr.house) return;
      readInputsToDraft();
      const addresses = getClientAddresses(draft);
      addresses.push(addr);
      draft.addresses = addresses;
      addAddrVisible = false;
      rerender();
    });

    overlay.querySelectorAll<HTMLButtonElement>('.cm-receipt-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const order = state.orders.find((o) => o.id === btn.dataset.orderId);
        if (order) showOrderReceipt(order);
      });
    });
  }

  document.body.appendChild(overlay);
  rerender();
}
