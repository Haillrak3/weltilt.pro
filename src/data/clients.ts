import clientsDb from '../clients.json';
import { state } from '../state';
import { saveExtraClients } from '../storage';
import { render } from '../render/trigger';
import type { ClientAddress, ClientInfo, DbClient } from '../types';

function normPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  return d.length === 11 && d[0] === '7' ? '8' + d.slice(1) : d;
}

// ── Серверный синк ────────────────────────────────────────────────────────────

function syncClientToServer(client: DbClient): void {
  fetch('/desk-api/clients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(client),
  }).catch(() => {});
}

function mergeServerClient(c: DbClient): boolean {
  const norm = normPhone(c.phone);
  const idx = state.extraClients.findIndex((e) => normPhone(e.phone) === norm);
  if (idx >= 0) {
    const local = state.extraClients[idx];
    // Берём адреса с максимальным количеством
    const localAddrs = local.addresses ?? [];
    const serverAddrs = c.addresses ?? [];
    const merged: DbClient = { ...c, addresses: serverAddrs.length >= localAddrs.length ? serverAddrs : localAddrs };
    if (JSON.stringify(local) === JSON.stringify(merged)) return false;
    state.extraClients[idx] = merged;
  } else {
    state.extraClients.push(c);
  }
  return true;
}

let _searchTimer: ReturnType<typeof setTimeout> | null = null;
let _lastSearchDigits = '';

function scheduleServerSearch(phone: string): void {
  const digits = normPhone(phone);
  if (digits.length < 3) return;
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    if (digits === _lastSearchDigits) return;
    _lastSearchDigits = digits;
    fetch(`/desk-api/clients?phone=${digits}&exact=false`)
      .then((r) => r.json() as Promise<{ ok: boolean; data?: DbClient[] }>)
      .then(({ ok: ok_, data }) => {
        if (!ok_ || !Array.isArray(data)) return;
        let changed = false;
        for (const c of data) if (mergeServerClient(c)) changed = true;
        if (changed) { saveExtraClients(state.extraClients); render(); }
      })
      .catch(() => {});
  }, 250);
}

function fetchClientFromServer(phone: string): void {
  const d = normPhone(phone);
  if (d.length < 7) return;
  fetch(`/desk-api/clients?phone=${d}`)
    .then((r) => r.json() as Promise<{ ok: boolean; data?: DbClient }>)
    .then(({ ok: ok_, data }) => {
      if (!ok_ || !data) return;
      if (mergeServerClient(data)) { saveExtraClients(state.extraClients); render(); }
    })
    .catch(() => {});
}

export function addrKey(a: ClientAddress): string {
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
  const found = state.extraClients.find((c) => clientMatchesPhone(c, d))
    ?? (clientsDb as DbClient[]).find((c) => clientMatchesPhone(c, d));
  if (!found) fetchClientFromServer(raw);
  return found;
}

export function searchClients(phone: string): DbClient[] {
  const digits = normPhone(phone);
  if (digits.length < 3) return [];
  scheduleServerSearch(phone);
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
  syncClientToServer(state.extraClients.find((c) => c.phone.replace(/\D/g, '') === digits)!);
}

export function findAddrIdx(client: DbClient, addr: { street: string; house: string; entrance: string; floor: string; apartment: string; intercom: string }): number {
  const addresses = getClientAddresses(client);
  const k = (a: { street: string; house: string; entrance: string; floor: string; apartment: string; intercom: string }) =>
    [a.street, a.house, a.entrance, a.floor, a.apartment, a.intercom].map((s) => s.trim().toLowerCase()).join('|');
  return addresses.findIndex((a) => k(a) === k(addr));
}

export function updateClientAddress(phone: string, idx: number, addr: ClientAddress): void {
  const digits = normPhone(phone);
  console.log('[updateAddr] phone:', phone, '→ digits:', digits, 'idx:', idx, 'addr:', addr);
  if (digits.length < 7 || idx < 0) { console.log('[updateAddr] EARLY EXIT: bad digits or idx'); return; }
  let clientIdx = state.extraClients.findIndex((c) => normPhone(c.phone) === digits);
  console.log('[updateAddr] clientIdx in extraClients:', clientIdx);
  if (clientIdx < 0) {
    const dbClient = findClientByPhone(digits);
    console.log('[updateAddr] dbClient from findClientByPhone:', dbClient);
    if (!dbClient) { console.log('[updateAddr] EARLY EXIT: dbClient not found'); return; }
    state.extraClients.push({ ...dbClient });
    clientIdx = state.extraClients.length - 1;
    console.log('[updateAddr] pushed to extraClients, new clientIdx:', clientIdx);
  }
  const existing = state.extraClients[clientIdx];
  const addresses = [...getClientAddresses(existing)];
  console.log('[updateAddr] addresses before update:', addresses, 'will update idx', idx);
  if (idx >= addresses.length) { console.log('[updateAddr] EARLY EXIT: idx >= addresses.length', idx, addresses.length); return; }
  addresses[idx] = addr;
  // Синхронизируем плоские поля — автоподстановка по телефону читает именно их
  const flatUpdate = idx === 0
    ? { street: addr.street, house: addr.house, entrance: addr.entrance, floor: addr.floor, apartment: addr.apartment, intercom: addr.intercom }
    : {};
  state.extraClients[clientIdx] = { ...existing, ...flatUpdate, addresses };
  saveExtraClients(state.extraClients);
  console.log('[updateAddr] DONE, saved. extraClients[clientIdx]:', state.extraClients[clientIdx]);
  syncClientToServer(state.extraClients[clientIdx]);
  void fetch(`/desk-api/v1/clients/${encodeURIComponent(digits)}/addresses/${idx}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(addr),
  }).then((r) => r.json() as Promise<{ ok: boolean; data?: DbClient }>)
    .then(({ ok: ok_, data }) => { if (ok_ && data && mergeServerClient(data)) saveExtraClients(state.extraClients); })
    .catch(() => {});
}

export async function addAddressToClient(phone: string, addr: ClientAddress): Promise<DbClient | null> {
  const digits = normPhone(phone);
  if (digits.length < 7) return null;
  try {
    const res = await fetch(`/desk-api/v1/clients/${encodeURIComponent(digits)}/addresses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addr),
    });
    const json = await res.json() as { ok: boolean; data?: DbClient };
    if (!json.ok || !json.data) return null;
    const updated = json.data;
    if (mergeServerClient(updated)) saveExtraClients(state.extraClients);
    return updated;
  } catch { return null; }
}

export function saveClientRecord(client: DbClient): void {
  const digits = client.phone.replace(/\D/g, '');
  if (digits.length < 7) return;
  const idx = state.extraClients.findIndex((c) => c.phone.replace(/\D/g, '') === digits);
  if (idx >= 0) state.extraClients[idx] = { ...client };
  else state.extraClients.push({ ...client });
  saveExtraClients(state.extraClients);
  syncClientToServer(client);
}
