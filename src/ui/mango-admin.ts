import { escapeHtml } from '../utils';

interface MangoAccount {
  operatorPhone: string;
  sipUser: string;
  sipPassword: string;
  c2cLogin: string;
  c2cPassword: string;
  c2cUserId: string;
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function renderRow(acc: MangoAccount, idx: number): string {
  return `
    <tr class="mango-row" data-idx="${idx}">
      <td><input class="mango-input" data-field="operatorPhone" data-idx="${idx}"
            placeholder="79001234567" value="${escapeAttr(acc.operatorPhone)}" /></td>
      <td><input class="mango-input" data-field="sipUser" data-idx="${idx}"
            placeholder="user12" value="${escapeAttr(acc.sipUser)}" /></td>
      <td><input class="mango-input mango-input--pass" data-field="sipPassword" data-idx="${idx}"
            placeholder="пароль" value="${escapeAttr(acc.sipPassword)}" /></td>
      <td class="mango-col-divider"></td>
      <td><input class="mango-input" data-field="c2cLogin" data-idx="${idx}"
            placeholder="e-mail или SIP ID" value="${escapeAttr(acc.c2cLogin)}" /></td>
      <td><input class="mango-input mango-input--pass" data-field="c2cPassword" data-idx="${idx}"
            placeholder="пароль" value="${escapeAttr(acc.c2cPassword)}" /></td>
      <td><input class="mango-input" data-field="c2cUserId" data-idx="${idx}"
            placeholder="user12" value="${escapeAttr(acc.c2cUserId)}" /></td>
      <td><button type="button" class="mango-del-btn" data-idx="${idx}" title="Удалить">✕</button></td>
    </tr>`;
}

export function openMangoAdmin(): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  let accounts: MangoAccount[] = [];
  let status = '';

  const render = () => {
    overlay.innerHTML = `
      <div class="modal modal-wide mango-modal" role="dialog">
        <h2>Mango Office — настройки телефонии</h2>

        <div class="mango-col-legend">
          <div class="mango-legend-group">
            <span class="mango-section-badge mango-badge-sip">MangoSIP</span>
            <span>Входящие звонки — SIP-демон регистрируется на ВАТС, сигнализирует о входящих.</span>
          </div>
          <div class="mango-legend-group">
            <span class="mango-section-badge mango-badge-c2c">Click-to-Call</span>
            <span>Исходящие звонки — данные от расширения браузера. ВАТС звонит оператору, затем соединяет с клиентом.</span>
          </div>
        </div>

        <p class="mango-hint">Изменения применяются сразу: SIP-демоны перезапускаются автоматически.</p>

        <div class="mango-table-wrap">
          <table class="mango-table">
            <thead>
              <tr>
                <th rowspan="2">Телефон оператора</th>
                <th colspan="2" class="mango-th-group mango-th-sip">
                  <span class="mango-section-badge mango-badge-sip">MangoSIP</span>
                </th>
                <th rowspan="2" class="mango-col-divider-th"></th>
                <th colspan="3" class="mango-th-group mango-th-c2c">
                  <span class="mango-section-badge mango-badge-c2c">Click-to-Call</span>
                </th>
                <th rowspan="2"></th>
              </tr>
              <tr>
                <th>Логин</th>
                <th>Пароль</th>
                <th>Логин</th>
                <th>Пароль</th>
                <th title="Необязательно. SIP-логин или номер расширения; если пусто — используется логин">USER_ID <span class="mango-opt">(необяз.)</span></th>
              </tr>
            </thead>
            <tbody>
              ${accounts.map((acc, i) => renderRow(acc, i)).join('')}
            </tbody>
          </table>
        </div>

        <div class="mango-actions">
          <button type="button" class="btn btn-ghost" id="mango-add">+ Добавить оператора</button>
          <div style="flex:1"></div>
          ${status ? `<span class="mango-status ${status.startsWith('Ошибка') ? 'mango-status--err' : 'mango-status--ok'}">${escapeHtml(status)}</span>` : ''}
          <button type="button" class="btn btn-ghost" id="mango-cancel">Закрыть</button>
          <button type="button" class="btn btn-primary" id="mango-save">Сохранить и применить</button>
        </div>
      </div>`;

    overlay.querySelector('#mango-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelectorAll<HTMLInputElement>('.mango-input[data-idx]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const idx = Number(inp.dataset.idx);
        const field = inp.dataset.field as keyof MangoAccount;
        if (accounts[idx]) accounts[idx][field] = inp.value;
      });
    });

    overlay.querySelectorAll<HTMLButtonElement>('.mango-del-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        accounts.splice(Number(btn.dataset.idx), 1);
        status = '';
        render();
      });
    });

    overlay.querySelector('#mango-add')?.addEventListener('click', () => {
      accounts.push({ operatorPhone: '', sipUser: '', sipPassword: '', c2cLogin: '', c2cPassword: '', c2cUserId: '' });
      status = '';
      render();
      const rows = overlay.querySelectorAll('.mango-row');
      (rows[rows.length - 1]?.querySelector('input') as HTMLInputElement | null)?.focus();
    });

    overlay.querySelector('#mango-save')?.addEventListener('click', async () => {
      const btn = overlay.querySelector('#mango-save') as HTMLButtonElement;
      btn.disabled = true;
      status = 'Сохранение…';
      render();
      try {
        const res = await fetch('/desk-api/mango-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(accounts),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(e.error ?? String(res.status));
        }
        status = 'Сохранено. Демоны перезапущены.';
      } catch (e) {
        status = `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
      }
      render();
    });
  };

  document.body.appendChild(overlay);

  fetch('/desk-api/mango-accounts')
    .then((r) => r.json())
    .then((data: unknown) => {
      accounts = (Array.isArray(data) ? data : []).map((a: Partial<MangoAccount>) => ({
        operatorPhone: a.operatorPhone ?? '',
        sipUser:       a.sipUser       ?? '',
        sipPassword:   a.sipPassword   ?? '',
        c2cLogin:      a.c2cLogin      ?? '',
        c2cPassword:   a.c2cPassword   ?? '',
        c2cUserId:     a.c2cUserId     ?? '',
      }));
      render();
    })
    .catch(() => {
      status = 'Ошибка загрузки';
      render();
    });

  render();
}
