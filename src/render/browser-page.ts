import { escapeHtml } from '../utils';

export function renderBrowserPage(): string {
  const url = '';
  return `
    <div class="browser-page">
      <div class="browser-bar">
        <button type="button" class="browser-nav-btn" id="btn-browser-back" title="Назад">&#8592;</button>
        <button type="button" class="browser-nav-btn" id="btn-browser-forward" title="Вперёд">&#8594;</button>
        <button type="button" class="browser-nav-btn" id="btn-browser-reload" title="Обновить">&#8635;</button>
        <input type="url" class="browser-url-input" id="browser-url-input"
          placeholder="Введите адрес сайта..."
          value="${escapeHtml(url)}" />
        <button type="button" class="btn btn-ghost browser-go-btn" id="btn-browser-go">Перейти</button>
        <button type="button" class="btn btn-ghost browser-shortcut-btn" data-url="/desk-tg/" title="Telegram">&#9992; TG</button>
      </div>
      ${url
        ? `<iframe class="browser-frame" id="browser-iframe" src="${escapeHtml(url)}"
             sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
             referrerpolicy="no-referrer"></iframe>`
        : `<div class="browser-empty">
             <span>&#127760;</span>
             <p>Введите адрес в строку выше</p>
           </div>`
      }
    </div>`;
}
