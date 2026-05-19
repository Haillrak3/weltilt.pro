import { escapeHtml } from '../utils';

interface MangoAccount {
  operatorPhone: string;
  sipUser: string;
  sipPassword: string;
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
        <h2>Mango Office — SIP аккаунты</h2>
        <p class="mango-hint">Изменения применяются сразу: демоны перезапускаются автоматически.</p>
        <table class="mango-table">
          <thead>
            <tr>
              <th>Телефон оператора</th>
              <th>SIP логин</th>
              <th>SIP пароль</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${accounts.map((acc, i) => renderRow(acc, i)).join('')}
          </tbody>
        </table>
        <div class="mango-actions">
          <button type="button" class="btn btn-ghost" id="mango-add">+ Добавить</button>
          <div style="flex:1"></div>
          ${status ? `<span class="mango-status ${status.startsWith('Ошибка') ? 'mango-status--err' : 'mango-status--ok'}">${escapeHtml(status)}</span>` : ''}
          <button type="button" class="btn btn-ghost" id="mango-cancel">Закрыть</button>
          <button type="button" class="btn btn-primary" id="mango-save">Сохранить и применить</button>
        </div>
      </div>`;

    overlay.querySelector('#mango-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelectorAll<HTMLInputElement>('.mango-input').forEach((inp) => {
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
      accounts.push({ operatorPhone: '', sipUser: '', sipPassword: '' });
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
        const res = await fetch('/desk-api/mango/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(accounts),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error ?? String(res.status));
        }
        status = 'Сохранено. Демоны перезапущены.';
      } catch (e) {
        status = `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
      }
      render();
    });
  };

  document.body.appendChild(overlay);

  fetch('/desk-api/mango/accounts')
    .then((r) => r.json())
    .then((data) => {
      accounts = Array.isArray(data) ? data : [];
      render();
    })
    .catch(() => {
      accounts = [];
      status = 'Ошибка загрузки';
      render();
    });

  // Показываем модал сразу с пустым состоянием пока грузится
  render();
}
