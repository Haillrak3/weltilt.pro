import { ApiError, requestSms, signIn } from '../api/client';
import { loadSettings, saveSettings, operatorFromSettings } from '../config/settings';
import { completeSignIn } from '../data/auth';
import { escapeHtml } from '../utils';
import { state } from '../state';
import { saveOrderMeta } from '../storage';

export interface AuthModalContext {
  settings: ReturnType<typeof loadSettings>;
  onSaved: () => void;
  closeable?: boolean;
}

function escapeAttr(s: string | number): string {
  return escapeHtml(String(s)).replace(/"/g, '&quot;');
}

export function openAuthModal(ctx: AuthModalContext): void {
  const settings = { ...ctx.settings };
  const closeable = ctx.closeable !== false;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-wide" role="dialog" aria-labelledby="auth-title">
      <h2 id="auth-title">Вход</h2>

      <div class="phone-row">
        <div class="field field-code">
          <span>Код страны</span>
          <div class="input-static">+7</div>
        </div>
        <label class="field field-grow">
          <span>Телефон</span>
          <input type="tel" id="input-phone" value="${escapeAttr(settings.phoneNumber)}" placeholder="9001234567" />
        </label>
      </div>
      <div class="modal-actions modal-actions-left">
        <button type="button" class="btn btn-ghost" id="btn-request-sms">Получить код</button>
        <button type="button" class="btn btn-ghost" id="btn-save-phone">Сохранить телефон</button>
      </div>
      <p id="sms-status" class="sms-status hidden"></p>

      <label class="field">
        <span>Код из SMS</span>
        <input type="text" id="input-sms-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="8" />
      </label>
      <div class="modal-actions">
        ${closeable ? '<button type="button" class="btn btn-ghost" id="btn-cancel">Закрыть</button>' : ''}
        <button type="button" class="btn btn-primary" id="btn-sign-in">Войти</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const smsStatus = overlay.querySelector('#sms-status') as HTMLElement;

  const showSmsStatus = (text: string, isError = false) => {
    smsStatus.textContent = text;
    smsStatus.classList.remove('hidden', 'error', 'ok');
    smsStatus.classList.add(isError ? 'error' : 'ok');
  };

  if (closeable) {
    overlay.querySelector('#btn-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
  }

  overlay.querySelector('#btn-save-phone')?.addEventListener('click', () => {
    const phoneNumber = (overlay.querySelector('#input-phone') as HTMLInputElement).value.trim();
    if (!phoneNumber) { showSmsStatus('Укажите номер телефона', true); return; }
    const digits = phoneNumber.replace(/\D/g, '');
    const norm = digits.startsWith('8') && digits.length === 11 ? digits.slice(1) : digits;
    ctx.settings.phoneNumber = norm;
    state.settings.phoneNumber = norm;
    saveSettings(state.settings);
    if (!state.orderMeta.operator) {
      state.orderMeta.operator = operatorFromSettings(state.settings);
      saveOrderMeta(state.orderMeta);
    }
    showSmsStatus('Телефон сохранён ✓');
    if (closeable) setTimeout(() => overlay.remove(), 800);
  });

  overlay.querySelector('#btn-request-sms')?.addEventListener('click', async () => {
    const countryCode = '+7';
    const phoneNumber = (overlay.querySelector('#input-phone') as HTMLInputElement).value.trim();
    if (!phoneNumber) { showSmsStatus('Укажите номер телефона', true); return; }
    const btn = overlay.querySelector('#btn-request-sms') as HTMLButtonElement;
    btn.disabled = true;
    showSmsStatus('Отправка запроса…');
    try {
      const info = await requestSms(countryCode, phoneNumber);
      settings.countryCode = countryCode;
      settings.phoneNumber = phoneNumber;
      const wait = info.next_request_timeout_in_seconds;
      const len  = info.code_length;
      let msg = 'Код отправлен.';
      if (len)  msg += ` Длина: ${len}.`;
      if (wait) msg += ` Повтор через ${wait} с.`;
      showSmsStatus(msg);
    } catch (e) {
      showSmsStatus(e instanceof ApiError ? e.message : 'Не удалось запросить код', true);
    } finally {
      btn.disabled = false;
    }
  });

  overlay.querySelector('#btn-sign-in')?.addEventListener('click', async () => {
    const countryCode = '+7';
    const phoneNumber = (overlay.querySelector('#input-phone') as HTMLInputElement).value.trim();
    const code        = (overlay.querySelector('#input-sms-code') as HTMLInputElement).value.trim();
    if (!phoneNumber || !code) { showSmsStatus('Укажите телефон и код из SMS', true); return; }
    const btn = overlay.querySelector('#btn-sign-in') as HTMLButtonElement;
    btn.disabled = true;
    try {
      const data = await signIn(countryCode, phoneNumber, code);
      const token = data.user?.access_token ?? data.access_token;
      if (!token) { showSmsStatus('В ответе нет токена', true); btn.disabled = false; return; }
      const saved = await completeSignIn(countryCode, phoneNumber, token);
      Object.assign(ctx.settings, saved);
      overlay.remove();
      ctx.onSaved();
    } catch (e) {
      showSmsStatus(e instanceof ApiError ? e.message : 'Ошибка входа', true);
      btn.disabled = false;
    }
  });
}
