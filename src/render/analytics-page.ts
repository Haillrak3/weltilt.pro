import { state } from '../state';
import { escapeHtml } from '../utils';
import { filteredOrders, buildFilterToolbar } from './orders-page';
import { getOperatorName } from '../auth';
import type { AnalyticsPeriod, SavedOrder } from '../types';

function periodKey(isoDate: string, period: AnalyticsPeriod): string {
  const d = new Date(new Date(isoDate).getTime() + 3 * 60 * 60 * 1000);
  if (period === 'month') return d.toISOString().slice(0, 7);
  if (period === 'week') {
    const day = d.getUTCDay() || 7;
    const thu = new Date(d.getTime() + (4 - day) * 86400000);
    const year = thu.getUTCFullYear();
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const weekStart = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
    const week = Math.round((thu.getTime() - weekStart.getTime()) / (7 * 86400000)) + 1;
    return `${year}-W${String(week).padStart(2, '0')}`;
  }
  return d.toISOString().slice(0, 10);
}

function periodLabel(key: string, period: AnalyticsPeriod): string {
  if (period === 'month') {
    const [y, m] = key.split('-');
    const months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
    return `${months[parseInt(m) - 1]} ${y}`;
  }
  if (period === 'week') {
    const [yearStr, weekStr] = key.split('-W');
    const year = parseInt(yearStr);
    const week = parseInt(weekStr);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const mon = new Date(jan4.getTime() - (jan4Day - 1) * 86400000 + (week - 1) * 7 * 86400000);
    const sun = new Date(mon.getTime() + 6 * 86400000);
    const fmt = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return `Нед. ${week} · ${fmt(mon)}–${fmt(sun)}`;
  }
  const [, m, d] = key.split('-');
  return `${d}.${m}`;
}

function renderRevenueTab(orders: SavedOrder[]): string {
  const period = state.analyticsPeriod;
  const map = new Map<string, { count: number; revenue: number }>();
  for (const o of orders) {
    const key = periodKey(o.createdAt, period);
    const e = map.get(key) ?? { count: 0, revenue: 0 };
    map.set(key, { count: e.count + 1, revenue: e.revenue + o.total });
  }

  const periodPicker = `
    <div class="rev-period-picker">
      <button type="button" class="rev-period-btn${period === 'day' ? ' active' : ''}" data-an-period="day">По дням</button>
      <button type="button" class="rev-period-btn${period === 'week' ? ' active' : ''}" data-an-period="week">По неделям</button>
      <button type="button" class="rev-period-btn${period === 'month' ? ' active' : ''}" data-an-period="month">По месяцам</button>
    </div>`;

  if (!map.size) {
    return periodPicker + '<p class="stat-empty" style="margin-top:16px">Нет данных за выбранный период</p>';
  }

  const totalOrders = orders.length;
  const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
  const totalAvg = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

  const rows = [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, { count, revenue }]) => {
      const avg = count > 0 ? Math.round(revenue / count) : 0;
      return `<tr>
        <td class="rev-td rev-period-cell">${escapeHtml(periodLabel(key, period))}</td>
        <td class="rev-td rev-num">${count}</td>
        <td class="rev-td rev-num">${revenue.toLocaleString('ru-RU')} ₽</td>
        <td class="rev-td rev-num rev-accent">${avg.toLocaleString('ru-RU')} ₽</td>
      </tr>`;
    }).join('');

  return periodPicker + `
    <div class="rev-table-wrap">
      <table class="rev-table">
        <thead>
          <tr>
            <th class="rev-th">Период</th>
            <th class="rev-th rev-num">Заказов</th>
            <th class="rev-th rev-num">Выручка</th>
            <th class="rev-th rev-num">Средний чек</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr class="rev-total-row">
            <td class="rev-td rev-period-cell">Итого</td>
            <td class="rev-td rev-num">${totalOrders}</td>
            <td class="rev-td rev-num">${totalRevenue.toLocaleString('ru-RU')} ₽</td>
            <td class="rev-td rev-num rev-accent">${totalAvg.toLocaleString('ru-RU')} ₽</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
}

export function renderAnalyticsPage(): string {
  const orders = filteredOrders();
  const tab = state.analyticsTab;

  const tabNav = `
    <div class="an-tabs">
      <button type="button" class="an-tab${tab === 'overview' ? ' active' : ''}" data-an-tab="overview">Обзор</button>
      <button type="button" class="an-tab${tab === 'revenue' ? ' active' : ''}" data-an-tab="revenue">Выручка</button>
    </div>`;

  if (tab === 'revenue') {
    return `<div class="analytics-page">
      ${buildFilterToolbar()}
      ${tabNav}
      ${renderRevenueTab(orders)}
    </div>`;
  }

  const byStore = new Map<string, number>();
  orders.forEach((o) => byStore.set(o.storeId, (byStore.get(o.storeId) ?? 0) + 1));
  const storeRows = [...byStore.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, cnt]) =>
      `<div class="stat-row">
        <span class="stat-label">Магазин ${escapeHtml(id)}</span>
        <span class="stat-count">${cnt}</span>
      </div>`,
    ).join('') || '<p class="stat-empty">Нет данных</p>';

  const STATUS_LABEL: Record<string, string> = { created: 'Создан', in_progress: 'В работе', done: 'Произведён' };
  const STATUS_ORDER = ['created', 'in_progress', 'done'];
  const byStatus = new Map<string, number>();
  orders.forEach((o) => byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1));
  const statusRows = STATUS_ORDER
    .filter((s) => byStatus.has(s))
    .map((s) =>
      `<div class="stat-row">
        <span class="stat-label">${escapeHtml(STATUS_LABEL[s])}</span>
        <span class="stat-count">${byStatus.get(s)}</span>
      </div>`,
    ).join('') || '<p class="stat-empty">Нет данных</p>';

  const byOperator = new Map<string, number>();
  orders.forEach((o) => {
    const raw = (o.operator ?? '').trim();
    const key = raw ? getOperatorName(raw) : '—';
    byOperator.set(key, (byOperator.get(key) ?? 0) + 1);
  });
  const operatorRows = [...byOperator.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) =>
      `<div class="stat-row">
        <span class="stat-label">${escapeHtml(name)}</span>
        <span class="stat-count">${count}</span>
      </div>`,
    ).join('') || '<p class="stat-empty">Нет данных</p>';

  return `<div class="analytics-page">
    ${buildFilterToolbar()}
    ${tabNav}
    <div class="stat-summary">Всего заказов за период: <strong>${orders.length}</strong></div>
    <div class="stats-grid">
      <div class="stat-card">
        <h3 class="stat-card-title">По магазинам</h3>
        <div class="stat-rows">${storeRows}</div>
      </div>
      <div class="stat-card">
        <h3 class="stat-card-title">По статусам</h3>
        <div class="stat-rows">${statusRows}</div>
      </div>
      <div class="stat-card">
        <h3 class="stat-card-title">По операторам</h3>
        <div class="stat-rows stat-rows-scroll">${operatorRows}</div>
      </div>
    </div>
  </div>`;
}
