import { state } from '../state';
import { escapeHtml } from '../utils';
import { NO_CATEGORY_ID, PENDING_ID, LOCAL_CATEGORY_ID } from '../types';

export function noCategoryBtn(): string {
  const items = state.vendorProducts.filter((p) => !p.subcategory);
  if (!items.length && !state.vendorProductsLoading) return '';
  const count = items.length ? ` <span class="muted">(${items.length})</span>` : '';
  const loading = state.vendorProductsLoading && !items.length ? ' <span class="muted">…</span>' : '';
  const active = state.selectedSubcategoryId === NO_CATEGORY_ID ? ' active' : '';
  return `
    <div class="cat-group cat-group-nocat">
      <button type="button" class="cat-parent${active}" id="btn-no-category">
        <span class="chevron">○</span>
        Без категории${count}${loading}
      </button>
    </div>`;
}

export function pendingBtn(): string {
  const items = state.pendingProducts;
  const count = items.length ? ` <span class="muted">(${items.length})</span>` : '';
  const loading = state.pendingProductsLoading ? ' <span class="muted">…</span>' : '';
  const active = state.selectedSubcategoryId === PENDING_ID ? ' active' : '';
  return `
    <div class="cat-group cat-group-pending">
      <button type="button" class="cat-parent${active}" id="btn-pending">
        <span class="chevron">◎</span>
        На модерации${count}${loading}
      </button>
    </div>`;
}

export function localProductsBtn(): string {
  const count = state.localProducts.length;
  const countStr = count ? ` <span class="muted">(${count})</span>` : '';
  const active = state.selectedSubcategoryId === LOCAL_CATEGORY_ID ? ' active' : '';
  return `
    <div class="cat-group cat-group-local">
      <button type="button" class="cat-parent${active}" id="btn-local-products">
        <span class="chevron">☆</span>
        Свои товары${countStr}
      </button>
    </div>`;
}

export function renderCategoryTree(): string {
  if (state.categoriesLoading) {
    return '<p class="panel-status">Загрузка категорий…</p>';
  }
  if (state.categoriesError) {
    return `<p class="panel-status error">${escapeHtml(state.categoriesError)}</p>`;
  }
  if (!state.categories.length) {
    return '<p class="panel-status">Категории не найдены</p>';
  }

  const categoriesHtml = state.categories
    .map((node, index) => {
      const { category, subcategories, expanded, loading } = node;
      const count = category.products_count != null ? ` (${category.products_count})` : '';

      let subsHtml = '';
      if (expanded && loading) {
        subsHtml = '<ul class="sub-list"><li class="sub-item muted">Загрузка…</li></ul>';
      } else if (expanded && subcategories) {
        subsHtml = `<ul class="sub-list">${
          subcategories.length
            ? subcategories.map((sub) => {
                const active = state.selectedSubcategoryId === sub.id ? ' active' : '';
                const subCount = sub.products_count != null
                  ? ` <span class="muted">(${sub.products_count})</span>`
                  : '';
                return `<li class="sub-item">
                    <button type="button" class="sub-btn${active}" data-sub-id="${sub.id}">
                      ${escapeHtml(sub.name)}${subCount}
                    </button>
                  </li>`;
              }).join('')
            : '<li class="sub-item muted">Нет подкатегорий</li>'
        }</ul>`;
      }

      const rootActive = state.selectedSubcategoryId === category.id ? ' active' : '';
      return `
        <div class="cat-group">
          <button type="button" class="cat-parent${expanded ? ' expanded' : ''}${rootActive}" data-cat-index="${index}">
            <span class="chevron">${expanded ? '▾' : '▸'}</span>
            ${escapeHtml(category.name)}${count}
          </button>
          ${subsHtml}
        </div>`;
    })
    .join('') + noCategoryBtn() + pendingBtn();

  return localProductsBtn() + categoriesHtml;
}
