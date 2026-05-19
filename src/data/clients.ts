import clientsDb from '../clients.json';
import { state } from '../state';
import { saveExtraClients } from '../storage';
import type { ClientAddress, ClientInfo, DbClient } from '../types';

function normPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  return d.length === 11 && d[0] === '7' ? '8' + d.slice(1) : d;
}

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

export function getAllClientPhones(c: DbClient): string[] {
  const fullNorm = normPhone(c.phone);
  const parts = c.phone.split(/\s+/).filter(Boolean).map(normPhone);
  const extra = (c.phones ?? []).map(normPhone);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of [fullNorm, ...parts, ...extra]) {
    if (p.length >= 7 && p.length <= 11 && !seen.has(p)) { seen.add(p); result.push(p); }
  }
  return result;
}

function clientMatchesPhone(c: DbClient, d: string): boolean {
  return getAllClientPhones(c).some((p) => p === d);
}

function clientContainsDigits(c: DbClient, digits: string): boolean {
  return getAllClientPhones(c).some((p) => p.includes(digits));
}

export function findClientByPhone(raw: string): DbClient | undefined {
  const d = normPhone(raw);
  return state.extraClients.find((c) => clientMatchesPhone(c, d))
    ?? (clientsDb as DbClient[]).find((c) => clientMatchesPhone(c, d));
}

export function searchClients(phone: string): DbClient[] {
  const digits = normPhone(phone);
  if (digits.length < 3) return [];
  const extraNorms = new Set(state.extraClients.map((c) => normPhone(c.phone)));
  return [
    ...state.extraClients.filter((c) => clientContainsDigits(c, digits)),
    ...(clientsDb as DbClient[]).filter((c) => {
      return clientContainsDigits(c, digits) && !extraNorms.has(normPhone(c.phone));
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
  const hasAddr = !!(newAddr.street || newAddr.house);

  const idx = state.extraClients.findIndex((c) => c.phone.replace(/\D/g, '') === digits);
  if (idx >= 0) {
    const existing = state.extraClients[idx];
    const addresses = getClientAddresses(existing);
    if (hasAddr && !addresses.some((a) => addrKey(a) === addrKey(newAddr))) {
      addresses.push(newAddr);
    }
    state.extraClients[idx] = {
      phone: client.phone.trim(), name: client.name.trim(), street: client.street.trim(),
      house: client.house.trim(), entrance: client.entrance.trim(), floor: client.floor.trim(),
      apartment: client.apartment.trim(), intercom: client.intercom.trim(),
      notes: client.notes.trim(), addresses,
    };
  } else {
    // Первый заказ — взять адреса из clientsDb чтобы не потерять их
    const dbClient = findClientByPhone(digits);
    const addresses: ClientAddress[] = dbClient ? [...getClientAddresses(dbClient)] : [];
    if (hasAddr && !addresses.some((a) => addrKey(a) === addrKey(newAddr))) {
      addresses.push(newAddr);
    }
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
