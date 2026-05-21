import { requestSms, signIn } from './api/client';
import { loadSettings } from './config/settings';
import { completeSignIn } from './data/auth';

const WHITELIST_KEY = 'orderdesk_whitelist';
const OPERATOR_NAMES_KEY = 'orderdesk_operator_names';
const SESSION_KEY = 'orderdesk_auth';
const ADMIN_LOGIN = 'hiko';
const ADMIN_PASSWORD = 'Nikifor1';

async function createServerSession(opts: { phone?: string; adminPassword?: string; authToken?: string }): Promise<void> {
  try {
    await fetch('/desk-api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
  } catch { /* offline */ }
}

export async function ensureServerSession(): Promise<void> {
  try {
    const check = await fetch('/desk-api/auth/session');
    if (check.ok) return;
    const settings = loadSettings();
    if (settings.authToken) { await createServerSession({ authToken: settings.authToken }); return; }
    const phone = sessionStorage.getItem(SESSION_KEY);
    if (phone) await createServerSession({ phone });
  } catch { /* offline */ }
}
const DEFAULTS = ['79784521921', '79651015841', '79639712635'];

function loadWhitelist(): Set<string> {
  try {
    const raw = localStorage.getItem(WHITELIST_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set(DEFAULTS);
  } catch { return new Set(DEFAULTS); }
}

async function fetchWhitelistFromServer(): Promise<Set<string> | null> {
  try {
    const res = await fetch('/desk-api/whitelist');
    if (!res.ok) return null;
    const data = await res.json() as string[];
    if (Array.isArray(data) && data.length > 0) {
      localStorage.setItem(WHITELIST_KEY, JSON.stringify(data));
      return new Set(data);
    }
  } catch { /* сервер недоступен */ }
  return null;
}

function loadOperatorNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(OPERATOR_NAMES_KEY);
    return raw ? JSON.parse(raw) as Record<string, string> : {};
  } catch { return {}; }
}

export async function syncOperatorNames(): Promise<void> {
  await fetchOperatorNamesFromServer();
}

async function fetchOperatorNamesFromServer(): Promise<Record<string, string> | null> {
  try {
    const res = await fetch('/desk-api/operator-names');
    if (!res.ok) return null;
    const data = await res.json() as Record<string, string>;
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      localStorage.setItem(OPERATOR_NAMES_KEY, JSON.stringify(data));
      return data;
    }
  } catch { /* сервер недоступен */ }
  return null;
}

export function getOperatorName(operator: string): string {
  const digits = operator.replace(/\D/g, '');
  const names = loadOperatorNames();
  return names[digits] || operator;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) return '7' + digits.slice(1);
  return digits;
}

function applyPhoneMask(input: HTMLInputElement): void {
  const PREFIX = '+7 ';
  function format(e?: Event): void {
    let digits = input.value.replace(/\D/g, '');
    if (digits.startsWith('7') || digits.startsWith('8')) digits = digits.slice(1);
    digits = digits.slice(0, 10);
    let masked = PREFIX;
    if (digits.length > 0) masked += digits.slice(0, 3);
    if (digits.length > 3) masked += ' ' + digits.slice(3, 6);
    if (digits.length > 6) masked += ' ' + digits.slice(6, 8);
    if (digits.length > 8) masked += ' ' + digits.slice(8, 10);
    input.value = masked;
    if (e) {
      const pos = masked.length;
      input.setSelectionRange(pos, pos);
    }
  }
  input.addEventListener('input', format);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && input.value === PREFIX) e.preventDefault();
  });
  input.addEventListener('focus', () => { if (!input.value) format(); });
  format();
}

export function isAuthorized(): boolean {
  if (loadSettings().authToken?.trim()) return true;
  const stored = sessionStorage.getItem(SESSION_KEY);
  return stored ? loadWhitelist().has(stored) : false;
}

async function showAdminPanel(overlay: HTMLElement): Promise<void> {
  const [serverList, serverNames] = await Promise.all([
    fetchWhitelistFromServer(),
    fetchOperatorNamesFromServer(),
  ]);
  const whitelist = serverList ?? loadWhitelist();
  const names = serverNames ?? loadOperatorNames();

  function collectNames(box: HTMLElement): void {
    box.querySelectorAll<HTMLInputElement>('.wl-name-input').forEach((inp) => {
      const phone = inp.dataset.wlPhone!;
      const val = inp.value.trim();
      if (val) names[phone] = val; else delete names[phone];
    });
  }

  function render(): void {
    const box = overlay.querySelector<HTMLElement>('.auth-box')!;
    box.innerHTML = `
      <div class="auth-title">Белый список</div>
      <ul class="wl-list">
        ${[...whitelist].map((num) => `
          <li class="wl-item">
            <span class="wl-phone">+${num}</span>
            <input type="text" class="wl-name-input auth-input" data-wl-phone="${num}"
              placeholder="Имя оператора" value="${(names[num] ?? '').replace(/"/g, '&quot;')}" />
            <button type="button" class="wl-del btn btn-ghost" data-num="${num}">✕</button>
          </li>`).join('')}
      </ul>
      <div class="wl-add-row">
        <input type="tel" id="wl-new-phone" class="auth-input" placeholder="+7 ___ ___ __ __" />
        <button type="button" class="btn btn-primary" id="wl-add">Добавить</button>
      </div>
      <div class="auth-error" id="wl-error"></div>
      <div class="wl-actions">
        <button type="button" class="btn btn-primary" id="wl-save">Сохранить</button>
        <button type="button" class="btn btn-ghost auth-btn" id="wl-back">← Назад</button>
      </div>`;

    box.querySelectorAll<HTMLButtonElement>('.wl-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        collectNames(box);
        const phone = btn.dataset.num!;
        whitelist.delete(phone);
        delete names[phone];
        render();
      });
    });

    const newInput = box.querySelector<HTMLInputElement>('#wl-new-phone')!;
    const errorEl = box.querySelector<HTMLElement>('#wl-error')!;
    applyPhoneMask(newInput);

    box.querySelector('#wl-add')?.addEventListener('click', () => {
      const norm = normalizePhone(newInput.value);
      if (norm.length < 10) { errorEl.textContent = 'Некорректный номер'; return; }
      collectNames(box);
      whitelist.add(norm);
      render();
    });

    newInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') box.querySelector<HTMLButtonElement>('#wl-add')!.click();
    });

    box.querySelector('#wl-save')?.addEventListener('click', async () => {
      collectNames(box);
      const saveBtn = box.querySelector<HTMLButtonElement>('#wl-save')!;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Сохранение…';
      errorEl.textContent = '';
      try {
        await Promise.all([
          fetch('/desk-api/whitelist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([...whitelist]),
          }).then((r) => { if (!r.ok) throw new Error('whitelist'); }),
          fetch('/desk-api/operator-names', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(names),
          }).then((r) => { if (!r.ok) throw new Error('names'); }),
        ]);
        localStorage.setItem(WHITELIST_KEY, JSON.stringify([...whitelist]));
        localStorage.setItem(OPERATOR_NAMES_KEY, JSON.stringify(names));
        saveBtn.textContent = 'Сохранено ✓';
        setTimeout(() => { saveBtn.disabled = false; saveBtn.textContent = 'Сохранить'; }, 1500);
      } catch {
        errorEl.textContent = 'Ошибка сохранения';
        saveBtn.disabled = false;
        saveBtn.textContent = 'Сохранить';
      }
    });

    box.querySelector('#wl-back')?.addEventListener('click', () => showAuthForm(overlay));
  }

  render();
}

function showAdminLogin(overlay: HTMLElement): void {
  const box = overlay.querySelector<HTMLElement>('.auth-box')!;
  box.innerHTML = `
    <div class="auth-title">Вход администратора</div>
    <input type="text" id="admin-login" class="auth-input" placeholder="Логин" autocomplete="username" />
    <input type="password" id="admin-pass" class="auth-input" placeholder="Пароль" autocomplete="current-password" />
    <div class="auth-error" id="admin-error"></div>
    <button type="button" class="btn btn-primary auth-btn" id="admin-submit">Войти</button>
    <button type="button" class="btn btn-ghost auth-btn" id="admin-back">← Назад</button>`;

  const loginInput = box.querySelector<HTMLInputElement>('#admin-login')!;
  const passInput = box.querySelector<HTMLInputElement>('#admin-pass')!;
  const errorEl = box.querySelector<HTMLElement>('#admin-error')!;

  loginInput.focus();

  function attempt(): void {
    if (loginInput.value.trim() === ADMIN_LOGIN && passInput.value.trim() === ADMIN_PASSWORD) {
      void createServerSession({ adminPassword: passInput.value.trim() });
      void showAdminPanel(overlay);
    } else {
      errorEl.textContent = 'Неверный логин или пароль';
      passInput.value = '';
      passInput.focus();
    }
  }

  box.querySelector('#admin-submit')?.addEventListener('click', attempt);
  loginInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { passInput.focus(); } });
  passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
  box.querySelector('#admin-back')?.addEventListener('click', () => showAuthForm(overlay));
}

function showCodeStep(overlay: HTMLElement, normalized: string): void {
  const box = overlay.querySelector<HTMLElement>('.auth-box')!;
  const digits = normalized.slice(1); // 10 цифр без ведущей '7'
  const hint = `+7 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`;

  const renderCodeBox = (errorText = '', resendLabel = 'Отправить повторно'): void => {
    box.innerHTML = `
      <div class="auth-title">Код из SMS</div>
      <div class="auth-phone-hint">${hint}</div>
      <input type="text" id="auth-code" class="auth-input auth-code-input" placeholder="______" maxlength="6" inputmode="numeric" autocomplete="one-time-code" />
      <div class="auth-error" id="auth-error">${errorText}</div>
      <button type="button" class="btn btn-primary auth-btn" id="auth-submit">Войти</button>
      <button type="button" class="btn btn-ghost auth-btn" id="auth-resend">${resendLabel}</button>
      <button type="button" class="btn btn-ghost auth-btn" id="auth-back">← Изменить номер</button>`;

    const codeInput = box.querySelector<HTMLInputElement>('#auth-code')!;
    const errorEl = box.querySelector<HTMLElement>('#auth-error')!;
    codeInput.focus();

    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.replace(/\D/g, '');
    });

    async function attempt(): Promise<void> {
      const code = codeInput.value.replace(/\D/g, '');
      if (!code) return;
      errorEl.textContent = '';
      try {
        const data = await signIn('+7', digits, code);
        const token = data.user?.access_token ?? data.access_token;
        await completeSignIn('+7', digits, token);
        sessionStorage.setItem(SESSION_KEY, normalized);
        void createServerSession({ phone: normalized });
        overlay.remove();
        (overlay as HTMLElement & { _onSuccess?: () => void })._onSuccess?.();
      } catch (e) {
        renderCodeBox(e instanceof Error ? e.message : 'Ошибка входа');
      }
    }

    async function resend(): Promise<void> {
      const resendBtn = box.querySelector<HTMLButtonElement>('#auth-resend')!;
      resendBtn.disabled = true;
      resendBtn.textContent = 'Отправка…';
      try {
        await requestSms('+7', digits);
        renderCodeBox();
      } catch (e) {
        renderCodeBox(e instanceof Error ? e.message : 'Ошибка отправки');
      }
    }

    box.querySelector('#auth-submit')?.addEventListener('click', () => { void attempt(); });
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { void attempt(); } });
    box.querySelector('#auth-resend')?.addEventListener('click', () => { void resend(); });
    box.querySelector('#auth-back')?.addEventListener('click', () => showAuthForm(overlay));
  };

  renderCodeBox();
}

function showAuthForm(overlay: HTMLElement): void {
  const box = overlay.querySelector<HTMLElement>('.auth-box')!;
  box.innerHTML = `
    <div class="auth-title">Введите номер телефона</div>
    <input type="tel" id="auth-phone" class="auth-input" placeholder="+7 ___ ___ __ __" autocomplete="tel" />
    <div class="auth-error" id="auth-error"></div>
    <button type="button" class="btn btn-primary auth-btn" id="auth-submit">Получить код</button>
    <button type="button" class="btn btn-ghost auth-btn auth-admin-btn" id="auth-admin">Администратор</button>`;

  const input = box.querySelector<HTMLInputElement>('#auth-phone')!;
  const errorEl = box.querySelector<HTMLElement>('#auth-error')!;

  applyPhoneMask(input);
  input.focus();

  async function attempt(): Promise<void> {
    const serverList = await fetchWhitelistFromServer();
    const normalized = normalizePhone(input.value);
    const whitelist = serverList ?? loadWhitelist();
    if (!whitelist.has(normalized)) {
      errorEl.textContent = 'Номер не найден';
      input.select();
      return;
    }
    errorEl.textContent = '';
    const submitBtn = box.querySelector<HTMLButtonElement>('#auth-submit')!;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправка…';
    try {
      await requestSms('+7', normalized.slice(1));
      showCodeStep(overlay, normalized);
    } catch (e) {
      errorEl.textContent = e instanceof Error ? e.message : 'Ошибка отправки SMS';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Получить код';
    }
  }

  box.querySelector('#auth-submit')?.addEventListener('click', () => { void attempt(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { void attempt(); } });
  box.querySelector('#auth-admin')?.addEventListener('click', () => showAdminLogin(overlay));
}

export function showAuthScreen(onSuccess: () => void): void {
  const overlay = document.createElement('div');
  overlay.id = 'auth-overlay';
  (overlay as HTMLElement & { _onSuccess?: () => void })._onSuccess = onSuccess;
  overlay.innerHTML = `<div class="auth-box"></div>`;
  document.body.appendChild(overlay);
  showAuthForm(overlay);
}
