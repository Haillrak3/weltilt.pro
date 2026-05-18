import clientsDb from '../clients.json';
import { state } from '../state';
import { saveExtraClients } from '../storage';
import type { ClientAddress, ClientInfo, DbClient } from '../types';

function addrKey(a: ClientAddress): string {
  return [a.street, a.house, a.entrance, a.floor, a.apartment, a.intercom]
    .map((s) => s.trim().toLowerCase()).join('|');
}

export function getClientAddresses(c: DbClient): ClientAddress[] {
  if (c.addresses && c.addresses.length > 0) return c.addresses;
  const pa: ClientAddress = {
    street: c.street, house: c.house, entrance: c.entrance,
    floor: c.floor, apartment: c.apartment, intercom: c.intercom,
  };
  return (pa.street || pa.house) ? [pa] : [];
}

export function findClientByPhone(digits: string): DbClient | undefined {
  return state.extraClients.find((c) => c.phone.replace(/\D/g, '') === digits)
    ?? (clientsDb as DbClient[]).find((c) => c.phone.replace(/\D/g, '') === digits);
}

export function searchClients(phone: string): DbClient[] {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 3) return [];
  const extraDigits = new Set(state.extraClients.map((c) => c.phone.replace(/\D/g, '')));
  return [
    ...state.extraClients.filter((c) => c.phone.replace(/\D/g, '').includes(digits)),
    ...(clientsDb as DbClient[]).filter((c) => {
      const d = c.phone.replace(/\D/g, '');
      return d.includes(digits) && !extraDigits.has(d);
    }),
  ].slice(0, 7);
}

export function allClientsDeduped(): DbClient[] {
  const extraDigits = new Set(state.extraClients.map((c) => c.phone.replace(/\D/g, '')));
  return [
    ...state.extraClients,
    ...(clientsDb as DbClient[]).filter((c) => !extraDigits.has(c.phone.replace(/\D/g, ''))),
  ].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export function upsertClientRecord(client: ClientInfo & { notes: string }): void {
  const digits = client.phone.replace(/\D/g, '');
  if (digits.length < 7) return;

  const newAddr: ClientAddress = {
    street: client.street.trim(), house: client.house.trim(),
    entrance: client.entrance.trim(), floor: client.floor.trim(),
    apartment: client.apartment.trim(), intercom: client.intercom.trim(),
  };

  const idx = state.extraClients.findIndex((c) => c.phone.replace(/\D/g, '') === digits);
  if (idx >= 0) {
    const existing = state.extraClients[idx];
    const addresses = getClientAddresses(existing);
    const key = addrKey(newAddr);
    if ((newAddr.street || newAddr.house) && !addresses.some((a) => addrKey(a) === key)) {
      addresses.push(newAddr);
    }
    state.extraClients[idx] = {
      phone: client.phone.trim(), name: client.name.trim(), street: client.street.trim(),
      house: client.house.trim(), entrance: client.entrance.trim(), floor: client.floor.trim(),
      apartment: client.apartment.trim(), intercom: client.intercom.trim(),
      notes: client.notes.trim(), addresses,
    };
  } else {
    const addresses: ClientAddress[] = (newAddr.street || newAddr.house) ? [newAddr] : [];
    state.extraClients.push({
      phone: client.phone.trim(), name: client.name.trim(), street: client.street.trim(),
      house: client.house.trim(), entrance: client.entrance.trim(), floor: client.floor.trim(),
      apartment: client.apartment.trim(), intercom: client.intercom.trim(),
      notes: client.notes.trim(), addresses,
    });
  }
  saveExtraClients(state.extraClients);
}

export function saveClientRecord(client: DbClient): void {
  const digits = client.phone.replace(/\D/g, '');
  if (digits.length < 7) return;
  const idx = state.extraClients.findIndex((c) => c.phone.replace(/\D/g, '') === digits);
  if (idx >= 0) state.extraClients[idx] = { ...client };
  else state.extraClients.push({ ...client });
  saveExtraClients(state.extraClients);
}
