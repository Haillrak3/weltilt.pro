import { state } from '../state';
import { escapeHtml, dayKeyGMT3 } from '../utils';
import type { SavedOrder, SavedOrderItem } from '../types';

function isDraftVolumeDetail(d?: string): boolean {
  return /^\d+(\.\d+)?\s*л$/i.test(d ?? '');
}

export function groupDraftItems(items: SavedOrderItem[]): SavedOrderItem[] {
  const seen = new Set<string>();
  const out: SavedOrderItem[] = [];

  for (const item of items) {
    const isOldDraft = item.productType === 'DRAFT' && isDraftVolumeDetail(item.details);
    if (!isOldDraft) { out.push(item); continue; }
    if (seen.has(item.name)) continue;
    seen.add(item.name);

    const siblings = items.filter(
      (i) => i.name === item.name && i.productType === 'DRAFT' && isDraftVolumeDetail(i.details),
    );
    const totalQty = Math.round(siblings.reduce((s, i) => s + i.qty, 0) * 1000) / 1000;
    const entries = siblings
      .map((i) => ({ vol: parseFloat(i.details!), count: Math.round(i.qty / parseFloat(i.details!)) }))
      .sort((a, b) => b.vol - a.vol);
    const details = 'Тара ' + entries.map((e) => `${e.vol}л — ${e.count} шт`).join(', ');

    out.push({ ...item, qty: totalQty, details });
  }

  return out;
}

function sortReceiptItems(items: SavedOrderItem[]): SavedOrderItem[] {
  const rank = (item: SavedOrderItem): number => {
    const isDraft = item.productType === 'DRAFT' || /^\d+(\.\d+)?\s*л$/i.test(item.details ?? '');
    if (isDraft) return 0;
    if (/тара|бутылка/i.test(item.name)) return 1;
    if (/пакет|доставка/i.test(item.name)) return 3;
    return 2;
  };
  return [...items].sort((a, b) => rank(a) - rank(b));
}

export function buildOrderNumbers(): Map<string, number> {
  const result = new Map<string, number>();
  const sorted = [...state.orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const dayCounts = new Map<string, number>();
  sorted.forEach((o) => {
    if (o.seqNum != null) {
      result.set(o.id, o.seqNum);
    } else {
      const dk = dayKeyGMT3(o.createdAt);
      const n = (dayCounts.get(dk) ?? 0) + 1;
      dayCounts.set(dk, n);
      result.set(o.id, n);
    }
  });
  return result;
}

function drawDashedLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.save();
  ctx.strokeStyle = '#cccccc'; ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.restore();
}

function canvasTruncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): [string] | [string, string] {
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const words = text.split(' ');
  let line1 = '';
  let i = 0;
  while (i < words.length) {
    const test = line1 ? `${line1} ${words[i]}` : words[i];
    if (ctx.measureText(test).width > maxWidth && line1) break;
    line1 = test;
    i++;
  }
  if (!line1) line1 = canvasTruncate(ctx, words[0], maxWidth);
  if (i >= words.length) return [line1];
  return [line1, canvasTruncate(ctx, words.slice(i).join(' '), maxWidth)];
}

function wrapTextMulti(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = word; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

async function buildReceiptBlob(order: SavedOrder, orderNum: number | string): Promise<Blob> {
  const SCALE = 2, W = 420, PAD = 28;
  const F = 'system-ui, -apple-system, sans-serif';
  const CT = '#1a1a1a', CM = '#888888';
  const isApp = order.orderMethod === 'app' && order.orderAmount !== undefined;
  const cl = order.client;

  const dateObj = new Date(new Date(order.createdAt).getTime() + 3 * 60 * 60 * 1000);
  const dateStr = dateObj.toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const payLabel = order.payMethod === 'cash' ? 'Наличные' : 'Безналичный расчёт';

  // Phone receipt: 3-column table geometry
  const maxW = W - PAD * 2;
  const QTY_COL = 38, TOTAL_COL = 70;
  const NAME_MAX_W = maxW - QTY_COL - TOTAL_COL;
  const X_QTY = PAD + NAME_MAX_W + QTY_COL / 2;
  const X_RIGHT = W - PAD;

  // Pre-measure item name wrapping (17px font, same as drawing)
  const sortedItems = sortReceiptItems(groupDraftItems(order.items));
  const _mCtx = document.createElement('canvas').getContext('2d')!;
  _mCtx.font = `17px ${F}`;
  const itemLines = sortedItems.map((item) => {
    const suffix = item.details ? ` ${item.details}` : '';
    const name = item.productType === 'DRAFT' ? `${item.name} розлив` : `${item.name}${suffix}`;
    return wrapText(_mCtx, name, NAME_MAX_W);
  });

  // Pre-measure client field wrapping (bold 21px, same as drawing)
  _mCtx.font = `bold 21px ${F}`;
  function preWrap(label: string, value: string): string[] {
    const tagW = _mCtx.measureText(`${label}: `).width;
    return wrapTextMulti(_mCtx, value, maxW - tagW);
  }
  const fieldH = (lines: string[]) => 32 + Math.max(0, lines.length - 1) * 26;

  // Phone: labeled client fields in desired order
  const clientRows: Array<{ label: string; lines: string[] }> = [];
  if (cl.name)      clientRows.push({ label: 'Клиент',     lines: preWrap('Клиент',     cl.name) });
  if (cl.street)    clientRows.push({ label: 'Улица',      lines: preWrap('Улица',      cl.street) });
  if (cl.house)     clientRows.push({ label: 'Дом',        lines: preWrap('Дом',        cl.house) });
  if (cl.entrance)  clientRows.push({ label: 'Подъезд',    lines: preWrap('Подъезд',    cl.entrance) });
  if (cl.floor)     clientRows.push({ label: 'Этаж',       lines: preWrap('Этаж',       cl.floor) });
  if (cl.apartment) clientRows.push({ label: 'Кв. (офис)', lines: preWrap('Кв. (офис)', cl.apartment) });
  if (cl.intercom)  clientRows.push({ label: 'Домофон',    lines: preWrap('Домофон',    cl.intercom) });
  if (cl.phone)     clientRows.push({ label: 'Телефон',    lines: preWrap('Телефон',    cl.phone) });
  if (cl.notes)     clientRows.push({ label: 'Примечание', lines: preWrap('Примечание', cl.notes) });

  // App: pre-wrap individual fields
  const appW = {
    phone:     cl.phone     ? preWrap('Телефон',     cl.phone)     : null,
    name:      cl.name      ? preWrap('Имя',         cl.name)      : null,
    street:    cl.street    ? preWrap('Улица',       cl.street)    : null,
    house:     cl.house     ? preWrap('Дом',         cl.house)     : null,
    entrance:  cl.entrance  ? preWrap('Подъезд',     cl.entrance)  : null,
    floor:     cl.floor     ? preWrap('Этаж',        cl.floor)     : null,
    apartment: cl.apartment ? preWrap('Кв. (офис)',  cl.apartment) : null,
    intercom:  cl.intercom  ? preWrap('Домофон',     cl.intercom)  : null,
    notes:     cl.notes     ? preWrap('Примечание',  cl.notes)     : null,
  };

  const DIV = 23; // divider: cy+=10, line, cy+=13
  let H = PAD * 2;

  if (isApp) {
    H += 22; // date
    if (order.orderNumber) H += 30;
    H += DIV;
    if (appW.phone)     H += fieldH(appW.phone);
    if (appW.name)      H += fieldH(appW.name);
    if (appW.street)    H += fieldH(appW.street);
    if (appW.house)     H += fieldH(appW.house);
    if (appW.entrance)  H += fieldH(appW.entrance);
    if (appW.floor)     H += fieldH(appW.floor);
    if (appW.apartment) H += fieldH(appW.apartment);
    if (appW.intercom)  H += fieldH(appW.intercom);
    if (appW.notes)     H += fieldH(appW.notes);
  } else {
    H += 22; // date
    H += 28; // order number
    H += DIV;
    H += 22; // column headers
    if (order.items.length > 0) {
      H += itemLines.reduce((s, lines) => s + (lines.length === 1 ? 26 : 54), 0);
      H += Math.max(0, order.items.length - 1) * 6;
    }
    H += DIV;
    H += 24; // К ОПЛАТЕ
    H += 24; // payment
    if (order.payMethod === 'cash' && order.given) H += 20;
    if (order.payMethod === 'cash' && order.change) H += 26;
    if (clientRows.length > 0) { H += DIV; H += clientRows.reduce((s, r) => s + fieldH(r.lines), 0); }
  }

  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE; canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(SCALE, SCALE); ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);

  let cy = PAD;

  const divider = () => { cy += 10; drawDashedLine(ctx, PAD, cy, W - PAD, cy); cy += 13; };

  if (isApp) {
    ctx.font = `13px ${F}`; ctx.fillStyle = CM; ctx.textAlign = 'center';
    ctx.fillText(dateStr, W / 2, cy); cy += 22;
    if (order.orderNumber) {
      ctx.font = `bold 22px ${F}`; ctx.fillStyle = CT; ctx.textAlign = 'center';
      ctx.fillText(`№ ${order.orderNumber}`, W / 2, cy); cy += 30;
    }
    divider();
    const appField = (label: string, lines: string[]) => {
      const tag = `${label}: `;
      ctx.font = `bold 21px ${F}`; ctx.fillStyle = CM; ctx.textAlign = 'left';
      ctx.fillText(tag, PAD, cy);
      const tagW = ctx.measureText(tag).width;
      ctx.fillStyle = CT;
      ctx.fillText(lines[0], PAD + tagW, cy); cy += 32;
      for (let i = 1; i < lines.length; i++) { ctx.fillText(lines[i], PAD, cy); cy += 26; }
    };
    if (appW.phone)     appField('Телефон',    appW.phone);
    if (appW.name)      appField('Имя',        appW.name);
    if (appW.street)    appField('Улица',      appW.street);
    if (appW.house)     appField('Дом',        appW.house);
    if (appW.entrance)  appField('Подъезд',    appW.entrance);
    if (appW.floor)     appField('Этаж',       appW.floor);
    if (appW.apartment) appField('Кв. (офис)', appW.apartment);
    if (appW.intercom)  appField('Домофон',    appW.intercom);
    if (appW.notes)     appField('Примечание', appW.notes);
  } else {
    ctx.font = `13px ${F}`; ctx.fillStyle = CM; ctx.textAlign = 'center';
    ctx.fillText(dateStr, W / 2, cy); cy += 22;
    ctx.font = `bold 19px ${F}`; ctx.fillStyle = CT; ctx.textAlign = 'center';
    ctx.fillText(`№ ${orderNum}`, W / 2, cy); cy += 28;
    divider();

    // Column headers
    ctx.font = `13px ${F}`; ctx.fillStyle = CM;
    ctx.textAlign = 'left';   ctx.fillText('Наименование', PAD, cy);
    ctx.textAlign = 'center'; ctx.fillText('Кол.', X_QTY, cy);
    ctx.textAlign = 'right';  ctx.fillText('Сумма', X_RIGHT, cy);
    cy += 22;

    // Items
    for (let i = 0; i < sortedItems.length; i++) {
      const item = sortedItems[i];
      const qtyStr = Number.isInteger(item.qty) ? String(item.qty) : item.qty.toFixed(3).replace(/\.?0+$/, '');
      const lineTotal = (item.price * item.qty).toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽';
      const lines = itemLines[i];

      ctx.font = `17px ${F}`; ctx.fillStyle = CT;
      ctx.textAlign = 'left';   ctx.fillText(lines[0], PAD, cy);
      ctx.textAlign = 'center'; ctx.fillText(qtyStr, X_QTY, cy);
      ctx.font = `bold 17px ${F}`; ctx.textAlign = 'right'; ctx.fillText(lineTotal, X_RIGHT, cy);
      cy += 26;
      if (lines[1]) {
        ctx.font = `17px ${F}`; ctx.fillStyle = CT; ctx.textAlign = 'left';
        ctx.fillText(lines[1], PAD, cy);
        cy += 28;
      }
      if (i < sortedItems.length - 1) cy += 6;
    }

    divider();
    ctx.font = `bold 16px ${F}`; ctx.fillStyle = CT;
    ctx.textAlign = 'left';  ctx.fillText('К ОПЛАТЕ', PAD, cy);
    ctx.textAlign = 'right'; ctx.fillText((order.total ?? 0).toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽', X_RIGHT, cy);
    cy += 24;
    ctx.font = `bold 16px ${F}`; ctx.fillStyle = CM; ctx.textAlign = 'left';
    ctx.fillText(`Способ оплаты: ${payLabel}`, PAD, cy); cy += 24;
    if (order.payMethod === 'cash' && order.given) {
      ctx.fillText('Внесено', PAD, cy);
      ctx.textAlign = 'right'; ctx.fillText(`${order.given.toLocaleString('ru-RU')} ₽`, X_RIGHT, cy);
      cy += 20;
    }
    if (order.payMethod === 'cash' && order.change) {
      cy += 4; ctx.fillStyle = '#16a34a'; ctx.font = `bold 15px ${F}`;
      ctx.textAlign = 'left';  ctx.fillText('Сдача', PAD, cy);
      ctx.textAlign = 'right'; ctx.fillText(`${order.change.toLocaleString('ru-RU')} ₽`, X_RIGHT, cy);
      cy += 22;
    }

    if (clientRows.length > 0) {
      divider();
      for (const { label, lines } of clientRows) {
        const tag = `${label}: `;
        ctx.font = `bold 21px ${F}`; ctx.fillStyle = CM; ctx.textAlign = 'left';
        ctx.fillText(tag, PAD, cy);
        const tagW = ctx.measureText(tag).width;
        ctx.fillStyle = CT;
        ctx.fillText(lines[0], PAD + tagW, cy); cy += 32;
        for (let i = 1; i < lines.length; i++) { ctx.fillText(lines[i], PAD, cy); cy += 26; }
      }
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { if (blob) resolve(blob); else reject(new Error('toBlob failed')); }, 'image/png');
  });
}

export function showChangeCalculator(
  total: number,
  onDone: (given: number, change: number) => void,
  initialGiven?: number,
): void {
  const DENOMS = [50, 100, 200, 500, 1000, 2000, 5000];
  const totalStr = total.toLocaleString('ru-RU', { minimumFractionDigits: 0 });
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal change-modal" role="dialog" aria-modal="true">
      <div class="change-title">Расчёт сдачи</div>
      <div class="change-due">К оплате: <strong>${totalStr} ₽</strong></div>
      <div class="change-denoms">
        ${DENOMS.map((d) => `<button type="button" class="btn btn-ghost change-denom" data-denom="${d}">${d.toLocaleString('ru-RU')} ₽</button>`).join('')}
        <button type="button" class="btn btn-ghost" id="change-clear">Сбросить</button>
      </div>
      <input type="text" inputmode="decimal" id="change-given" class="change-given-input" placeholder="Сумма наличных…" />
      <div class="change-result" id="change-result">&nbsp;</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary" id="change-confirm">Подтвердить</button>
        <button type="button" class="btn btn-ghost" id="change-skip">Без сдачи</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector<HTMLInputElement>('#change-given')!;
  const resultEl = overlay.querySelector<HTMLElement>('#change-result')!;
  if (initialGiven) input.value = String(initialGiven);
  function refresh(): void {
    const given = parseFloat(input.value.replaceAll(',', '.')) || 0;
    if (given <= 0) { resultEl.innerHTML = '&nbsp;'; resultEl.className = 'change-result'; return; }
    const diff = given - total;
    if (diff < 0) { resultEl.textContent = `Не хватает: ${Math.abs(diff).toLocaleString('ru-RU')} ₽`; resultEl.className = 'change-result change-result--short'; }
    else { resultEl.textContent = `Сдача: ${diff.toLocaleString('ru-RU')} ₽`; resultEl.className = 'change-result change-result--ok'; }
  }
  if (initialGiven) refresh();
  input.addEventListener('input', refresh);
  overlay.querySelectorAll<HTMLButtonElement>('.change-denom').forEach((btn) => {
    btn.addEventListener('click', () => { input.value = String((parseFloat(input.value) || 0) + parseInt(btn.dataset.denom!, 10)); refresh(); });
  });
  overlay.querySelector('#change-clear')?.addEventListener('click', () => { input.value = ''; refresh(); });
  const finish = (given: number, change: number) => { overlay.remove(); onDone(given, change); };
  overlay.querySelector('#change-confirm')?.addEventListener('click', () => { const given = parseFloat(input.value.replaceAll(',', '.')) || 0; finish(given, Math.max(0, given - total)); });
  overlay.querySelector('#change-skip')?.addEventListener('click', () => finish(0, 0));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(0, 0); });
  input.focus();
}

export function showOrderReceipt(order: SavedOrder): void {
  const isApp = order.orderMethod === 'app' && order.orderAmount !== undefined;
  const orderNum = buildOrderNumbers().get(order.id) ?? '?';
  const dateObj = new Date(new Date(order.createdAt).getTime() + 3 * 60 * 60 * 1000);
  const dateStr = dateObj.toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const payLabel = order.payMethod === 'cash' ? 'Наличные' : 'Безналичный расчёт';
  const totalStr = (order.total ?? 0).toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽';

  const addrLine = [order.client.street, order.client.house, order.client.apartment ? `кв. ${order.client.apartment}` : ''].filter(Boolean).join(', ');
  const addrExtra = [
    order.client.entrance ? `подъезд ${order.client.entrance}` : '',
    order.client.floor ? `эт. ${order.client.floor}` : '',
    order.client.intercom ? `домофон ${order.client.intercom}` : '',
  ].filter(Boolean).join(', ');
  const clientBlock = [
    order.client.name && `<div class="rc-name">${escapeHtml(order.client.name)}</div>`,
    order.client.phone && `<div class="rc-phone">${escapeHtml(order.client.phone)}</div>`,
    addrLine && `<div class="rc-addr">${escapeHtml(addrLine)}</div>`,
    addrExtra && `<div class="rc-addr-extra">${escapeHtml(addrExtra)}</div>`,
    order.client.notes && `<div class="rc-notes">Примечание: ${escapeHtml(order.client.notes)}</div>`,
  ].filter(Boolean).join('');

  let modalBody: string;
  if (isApp) {
    modalBody = `
      <div class="receipt-head">
        <div class="receipt-datetime">${escapeHtml(dateStr)}</div>
        ${order.orderNumber ? `<div class="receipt-app-num-big">№ ${escapeHtml(order.orderNumber)}</div>` : ''}
      </div>
      <div class="receipt-divider"></div>
      ${clientBlock ? `<div class="receipt-client">${clientBlock}</div>` : ''}`;
  } else {
    const itemsHtml = sortReceiptItems(groupDraftItems(order.items)).map((item) => {
      const qtyStr = Number.isInteger(item.qty) ? String(item.qty) : item.qty.toFixed(3).replace(/\.?0+$/, '');
      const lineTotal = (item.price * item.qty).toLocaleString('ru-RU', { minimumFractionDigits: 0 });
      return `<tr>
        <td class="ri-name">${escapeHtml(item.productType === 'DRAFT' ? `${item.name} розлив` : item.name)}${item.details ? `<span class="ri-details">${escapeHtml(item.details)}</span>` : ''}</td>
        <td class="ri-qty">${escapeHtml(qtyStr)} × ${item.price.toLocaleString('ru-RU')} ₽</td>
        <td class="ri-total">${escapeHtml(lineTotal)} ₽</td>
      </tr>`;
    }).join('');
    modalBody = `
      <div class="receipt-head">
        <div class="receipt-datetime">${escapeHtml(dateStr)}</div>
        <div class="receipt-num">Заказ #${orderNum}</div>
      </div>
      <div class="receipt-divider"></div>
      <table class="receipt-items">${itemsHtml}</table>
      <div class="receipt-divider"></div>
      <div class="receipt-total-row"><span>Итого</span><span class="receipt-total-amt">${escapeHtml(totalStr)}</span></div>
      <div class="receipt-pay">${escapeHtml(payLabel)}</div>
      ${order.payMethod === 'cash' && order.given ? `<div class="receipt-given"><span>Внесено</span><span>${order.given.toLocaleString('ru-RU')} ₽</span></div>` : ''}
      ${order.payMethod === 'cash' && order.change ? `<div class="receipt-change"><span>Сдача</span><span>${order.change.toLocaleString('ru-RU')} ₽</span></div>` : ''}
      ${clientBlock ? `<div class="receipt-divider"></div><div class="receipt-client">${clientBlock}</div>` : ''}`;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal receipt-modal" role="dialog" aria-modal="true">
      ${modalBody}
      <div id="receipt-preview" class="receipt-preview-wrap"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost receipt-action-btn" id="btn-view-receipt">Посмотреть</button>
        <button type="button" class="btn btn-ghost receipt-action-btn" id="btn-copy-receipt">Скопировать</button>
        ${isApp ? `<button type="button" class="btn btn-ghost receipt-action-btn" id="btn-copy-amount">Скопировать инфо</button>` : ''}
        <button type="button" class="btn btn-primary receipt-action-btn" id="btn-close-receipt">Закрыть</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let previewUrl: string | null = null;
  const close = () => {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    overlay.remove();
  };
  overlay.querySelector('#btn-close-receipt')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const viewBtn = overlay.querySelector<HTMLButtonElement>('#btn-view-receipt')!;
  const previewDiv = overlay.querySelector<HTMLDivElement>('#receipt-preview')!;
  viewBtn.addEventListener('click', async () => {
    if (previewUrl) {
      previewDiv.innerHTML = '';
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      viewBtn.textContent = 'Посмотреть';
      return;
    }
    viewBtn.disabled = true; viewBtn.textContent = '…';
    try {
      const blob = await buildReceiptBlob(order, orderNum);
      previewUrl = URL.createObjectURL(blob);
      previewDiv.innerHTML = `<img src="${previewUrl}" alt="Чек" class="receipt-preview-img" />`;
      viewBtn.textContent = 'Скрыть';
    } catch {
      viewBtn.textContent = 'Ошибка';
      setTimeout(() => { viewBtn.textContent = 'Посмотреть'; }, 2000);
    } finally {
      viewBtn.disabled = false;
    }
  });

  const copyAmountBtn = overlay.querySelector<HTMLButtonElement>('#btn-copy-amount');
  if (copyAmountBtn) {
    copyAmountBtn.addEventListener('click', async () => {
      const parts: string[] = [];
      if (order.orderNumber) parts.push(`№${order.orderNumber}`);
      parts.push(`${Math.round(order.total)} руб`);
      const infoStr = parts.join('   ');
      try {
        await navigator.clipboard.writeText(infoStr);
        copyAmountBtn.textContent = 'Скопировано!';
      } catch {
        copyAmountBtn.textContent = infoStr;
      }
      setTimeout(() => { copyAmountBtn.textContent = 'Скопировать информацию'; }, 2000);
    });
  }
  const copyBtn = overlay.querySelector<HTMLButtonElement>('#btn-copy-receipt')!;
  copyBtn.addEventListener('click', async () => {
    copyBtn.disabled = true; copyBtn.textContent = '…';
    try {
      const blob = await buildReceiptBlob(order, orderNum);
      if (window.isSecureContext && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        copyBtn.textContent = 'Скопировано!';
      } else {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'popup,width=400,height=600');
        setTimeout(() => URL.revokeObjectURL(url), 15000);
        copyBtn.textContent = 'Открыто в новой вкладке';
      }
      setTimeout(() => { copyBtn.textContent = 'Скопировать картинкой'; copyBtn.disabled = false; }, 2000);
    } catch {
      copyBtn.textContent = 'Ошибка копирования';
      setTimeout(() => { copyBtn.textContent = 'Скопировать картинкой'; copyBtn.disabled = false; }, 2000);
    }
  });
}
