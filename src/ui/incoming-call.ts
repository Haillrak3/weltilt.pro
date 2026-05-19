import { state } from '../state';
import { saveClient } from '../storage';
import { newOrder } from '../data/orders';
import { render } from '../render/trigger';
import { findClientByPhone } from '../data/clients';

let popup: HTMLDivElement | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function fmt(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '7')
    return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  if (d.length === 10)
    return `+7 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}`;
  return raw;
}

function dismiss(): void {
  if (!popup) return;
  popup.classList.remove('call-popup--visible');
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
  const el = popup;
  setTimeout(() => { el.remove(); }, 280);
  popup = null;
}

function toDbPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '7') return '8' + d.slice(1);
  if (d.length === 10) return '8' + d;
  return raw;
}

function startOrder(phone: string): void {
  state.currentPage = 'products';
  newOrder();
  const dbPhone = toDbPhone(phone);
  state.client.phone = dbPhone;
  const found = findClientByPhone(dbPhone.replace(/\D/g, ''));
  if (found) {
    Object.assign(state.client, {
      name: found.name, street: found.street, house: found.house,
      entrance: found.entrance, floor: found.floor,
      apartment: found.apartment, intercom: found.intercom, notes: found.notes ?? '',
    });
  }
  saveClient(state.client);
  render();
  dismiss();
}

export function showIncomingCall(from: string): void {
  dismiss();

  popup = document.createElement('div');
  popup.className = 'call-popup';
  popup.innerHTML = `
    <div class="call-popup__header">
      <span class="call-popup__label">Входящий звонок</span>
      <button class="call-popup__close" type="button" aria-label="Закрыть">✕</button>
    </div>
    <div class="call-popup__phone">${fmt(from)}</div>
    <div class="call-popup__actions">
      <button class="call-popup__btn call-popup__btn--primary" type="button">Начать заказ</button>
      <button class="call-popup__btn" type="button">Закрыть</button>
    </div>
  `;

  document.body.appendChild(popup);
  requestAnimationFrame(() => popup?.classList.add('call-popup--visible'));

  popup.querySelector('.call-popup__close')!
    .addEventListener('click', dismiss);
  popup.querySelector('.call-popup__btn--primary')!
    .addEventListener('click', () => startOrder(from));
  popup.querySelectorAll<HTMLButtonElement>('.call-popup__btn:not(.call-popup__btn--primary)')[0]
    ?.addEventListener('click', dismiss);

  dismissTimer = setTimeout(dismiss, 30_000);
}

function myPhone(): string {
  const session = sessionStorage.getItem('orderdesk_auth') ?? '';
  const settingsPhone = (state.settings.phoneNumber ?? '').replace(/\D/g, '');
  return session || settingsPhone;
}

export async function initMangoSse(): Promise<void> {
  let sipUser: string | undefined;
  try {
    const resp = await fetch('/desk-api/mango/accounts');
    const accounts = await resp.json() as Array<{ operatorPhone: string; sipUser: string }>;
    const phone = myPhone();
    sipUser = accounts.find((a) => a.operatorPhone.replace(/\D/g, '') === phone)?.sipUser;
  } catch {
    return;
  }
  if (!sipUser) return;

  let es: EventSource | null = null;

  const connect = () => {
    es = new EventSource('/desk-api/mango/events');
    es.addEventListener('incoming_call', (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as { from: string; sipUser: string };
        if (d.from && d.sipUser === sipUser) showIncomingCall(d.from);
      } catch {}
    });
    es.onerror = () => {
      es?.close();
      setTimeout(connect, 5000);
    };
  };

  connect();
}
