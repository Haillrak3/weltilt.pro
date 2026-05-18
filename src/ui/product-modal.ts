import { state } from '../state';
import { escapeHtml, formatProductName, getCountry } from '../utils';
import { addToCart } from '../data/cart';
import type { Product } from '../types';

export function openProductModal(product: Product): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const img = product.main_image;
  const imgSrc = img?.medium || img?.small || img?.large || img?.original || null;
  const imgLarge = img?.original || img?.large || img?.medium || img?.small || null;
  const imgHtml = imgSrc
    ? `<img class="product-modal-img product-modal-img-zoomable" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(product.name)}" title="Нажмите для увеличения" />`
    : '';

  const country = getCountry(product);
  const countryHtml = country
    ? `<div class="product-modal-country">${escapeHtml(country)}</div>`
    : '';

  const propsHtml = product.properties?.length
    ? product.properties
        .filter((pr) => !/стран/i.test(pr.name))
        .map((pr) =>
          `<div class="product-modal-prop">
            <span class="product-modal-prop-name">${escapeHtml(pr.name)}</span>
            <span>${escapeHtml(pr.value)}</span>
          </div>`
        ).join('')
    : '';

  overlay.innerHTML = `
    <div class="modal product-modal" role="dialog">
      ${imgHtml}
      <h2 class="product-modal-title">${formatProductName(product)}</h2>
      ${countryHtml}
      ${propsHtml ? `<div class="product-modal-props">${propsHtml}</div>` : ''}
      ${product.description ? `<p class="product-modal-desc">${escapeHtml(product.description)}</p>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="btn-close-product">Закрыть</button>
        <button type="button" class="btn btn-primary" id="btn-modal-add">В корзину</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.querySelector('#btn-close-product')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#btn-modal-add')?.addEventListener('click', () => {
    addToCart(product);
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  if (imgLarge) {
    overlay.querySelector('.product-modal-img-zoomable')?.addEventListener('click', () => {
      const zoom = document.createElement('div');
      zoom.className = 'img-zoom-overlay';
      zoom.innerHTML = `<img class="img-zoom-img" src="${escapeHtml(imgLarge)}" alt="${escapeHtml(product.name)}" />`;
      document.body.appendChild(zoom);
      zoom.addEventListener('click', () => zoom.remove());
    });
  }
}

// Re-export findProduct helper for app.ts event binding
export function findProductInCache(id: number): Product | undefined {
  const direct = state.products.find((p) => p.id === id);
  if (direct) return direct;
  for (const list of state.productsCache.values()) {
    const found = list.find((p) => p.id === id);
    if (found) return found;
  }
}
