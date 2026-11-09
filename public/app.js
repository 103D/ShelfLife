// ShelfLife Mini App — cross-platform (works on iPhone inside Telegram).
// Talks to the Express backend; auth via Telegram initData (sent as a header).

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor?.('#0e1013');
    tg.setBackgroundColor?.('#0e1013');
    tg.enableClosingConfirmation?.();
  } catch (_) {
    /* older clients */
  }
}

const INIT_DATA = tg?.initData ?? '';
const state = {
  tab: 'list',
  products: [],
  settings: { warningDays: 7, defaultCategory: '' },
  categories: [],
  query: '',
};

// ---------- API ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': INIT_DATA,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    toast('Ошибка авторизации Telegram');
    throw new Error('unauthorized');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

// ---------- UI helpers ----------
const $content = document.getElementById('content');

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
  tg?.HapticFeedback?.notificationOccurred?.('success');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function fmtDate(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function badge(p) {
  // Статус главной (ближайшей по сроку) партии, без дублей:
  // «Отсутствует» > «Уценён» (ручной) > «Списание»/«Уценка» (по сроку).
  if (p.isMissing) return '<span class="badge missing">Отсутствует</span>';
  if (p.isMarkedDown) return '<span class="badge marked">Уценён</span>';
  if (p.expirationCategory === 'EXPIRED') return '<span class="badge expired">Списание</span>';
  if (p.expirationCategory === 'ON_SALE') return '<span class="badge onsale">Уценка</span>';
  return '';
}

function daysText(p) {
  if (p.daysRemaining == null) return 'без срока';
  const d = p.daysRemaining;
  if (d < 0) return `просрочен ${Math.abs(d)} дн.`;
  if (d === 0) return 'истекает сегодня';
  return `осталось ${d} дн.`;
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    render();
  });
});
document.getElementById('btn-refresh').addEventListener('click', loadAndRender);

async function loadData() {
  const [products, settings, categories] = await Promise.all([
    api(state.query ? `/api/products?q=${encodeURIComponent(state.query)}` : '/api/products'),
    api('/api/settings'),
    api('/api/categories').catch(() => []),
  ]);
  state.products = products;
  state.settings = settings;
  state.categories = categories;
}

async function loadAndRender() {
  $content.innerHTML = '<div class="loader">Загрузка…</div>';
  try {
    await loadData();
    render();
  } catch (e) {
    $content.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`;
  }
}

function render() {
  if (state.tab === 'list') renderList();
  else if (state.tab === 'settings') renderSettings();
  // Вкладка «Сканер» скрыта: товары добавляются только из Android-приложения,
  // Mini App — для просмотра и синхронизации.
  else renderList();
}

// ---------- Screen: product list ----------
function renderList() {
  const stats = {
    EXPIRED: state.products.filter((p) => p.expirationCategory === 'EXPIRED').length,
    ON_SALE: state.products.filter((p) => p.expirationCategory === 'ON_SALE').length,
    ALL: state.products.length,
  };
  let html = `
    <input class="search" id="search" placeholder="Поиск по названию или штрихкоду…" value="${esc(state.query)}" />
    <div class="row" style="margin-bottom:12px">
      <span class="chip">Всего ${stats.ALL}</span>
      <span class="chip">🔴 ${stats.EXPIRED}</span>
      <span class="chip">🟠 ${stats.ON_SALE}</span>
    </div>
  `;
  if (state.products.length === 0) {
    html += `<div class="empty">Нет товаров. Откройте вкладку «Сканер», чтобы добавить.</div>`;
  } else {
    for (const p of state.products) {
      html += `
        <div class="card" data-id="${p.id}">
          <div class="name">${esc(p.name)} ${badge(p)}</div>
          <div class="meta">
            ${esc(daysText(p))}${p.hasExpirationDate ? ` · до ${esc(fmtDate(p.expirationDate))}` : ''}
            ${p.category ? ` · ${esc(p.category)}` : ''} × ${p.quantity}
            ${p.batches && p.batches.length > 1 ? ` · ${p.batches.length} партии` : ''}
          </div>
          <div class="row" style="margin-top:8px">
            <button class="btn secondary btn-edit" data-id="${p.id}">✏️ Изменить</button>
            <button class="btn secondary btn-status" data-id="${p.id}" data-field="isMarkedDown">${p.isMarkedDown ? '↩️ Снять уценку' : '🏷️ Уценка'}</button>
            <button class="btn secondary btn-status" data-id="${p.id}" data-field="isMissing">${p.isMissing ? '↩️ На полку' : '⚪ Отсутствует'}</button>
          </div>
        </div>`;
    }
  }
  $content.innerHTML = html;

  const search = document.getElementById('search');
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.query = search.value.trim();
      loadAndRender();
    }, 300);
  });

  $content.querySelectorAll('.btn-edit').forEach((b) =>
    b.addEventListener('click', () => openProductForm(Number(b.dataset.id))),
  );
  $content.querySelectorAll('.btn-status').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.id);
      const field = b.dataset.field;
      const p = state.products.find((x) => x.id === id);
      if (!p) return;
      try {
        await api(`/api/products/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ [field]: !p[field] }),
        });
        await loadAndRender();
      } catch (e) {
        toast(e.message);
      }
    }),
  );

}

// ---------- Screen: scanner / add product ----------
// Добавление товаров из Mini App отключено: товары добавляются только
// из Android-приложения. Mini App — просмотр, синхронизация, настройки.
function renderScan() {
  state.tab = 'list';
  renderList();
}

async function doLookup() {
  // Добавление из Mini App отключено — только просмотр и редактирование.
  toast('Добавление товаров — из Android-приложения');
  state.tab = 'list';
  renderList();
}

// Optional camera scanning using BarcodeDetector when available (Android Chrome).
// On iOS this is often unavailable, so we gracefully inform the user.
function scanWithCamera() {
  // Камера в Mini App отключена вместе с добавлением товаров.
  toast('Добавление товаров — из Android-приложения');
}

// ---------- Product form (edit only) ----------
// Создание новых товаров из Mini App отключено (id == null больше не приходит
// из UI — товары добавляются из Android). Редактирование существующих — можно.
function openProductForm(id, prefill = {}) {
  const existing = id ? state.products.find((p) => p.id === id) : null;
  if (!existing) {
    toast('Добавление товаров — из Android-приложения');
    state.tab = 'list';
    renderList();
    return;
  }
  const p = existing || {
    barcode: prefill.barcode ?? '',
    name: prefill.name ?? '',
    quantity: 1,
    hasExpirationDate: false,
    expirationDate: null,
    category: prefill.country && state.settings.defaultCategory === '' ? '' : state.settings.defaultCategory,
  };
  const expVal = p.expirationDate ? new Date(p.expirationDate).toISOString().slice(0, 10) : '';
  const catOptions = ['', ...state.categories.map((c) => c.name)]
    .map((c) => `<option value="${esc(c)}" ${p.category === c ? 'selected' : ''}>${esc(c || '— без категории —')}</option>`)
    .join('');

  $content.innerHTML = `
    <div class="section-title">${existing ? 'Изменение товара' : 'Новый товар'}</div>
    <div class="field"><label>Штрихкод</label><input id="f-barcode" value="${esc(p.barcode)}" inputmode="numeric" /></div>
    <div class="field"><label>Название</label><input id="f-name" value="${esc(p.name)}" /></div>
    <div class="field"><label>Количество</label><input id="f-qty" type="number" min="1" value="${p.batches && p.batches.length ? p.batches[0].quantity : p.quantity}" inputmode="numeric" /></div>
    <div class="field"><label>Категория</label><select id="f-cat">${catOptions}</select></div>
    <div class="field">
      <label><input type="checkbox" id="f-hasexp" ${p.hasExpirationDate ? 'checked' : ''} /> Есть срок годности</label>
    </div>
    <div class="field"><label>Срок годности</label><input id="f-exp" type="date" value="${esc(expVal)}" /></div>
    <div class="section-title" style="margin-top:12px">Партии (несколько дат)</div>
    <div id="batches-list"></div>
    <div class="field"><label>Дата новой партии</label><input id="b-exp" type="date" /></div>
    <button class="btn secondary" id="b-add">+ Добавить партию</button>
    <button class="btn secondary" id="b-add-marked">+ Партия с уценкой</button>
    <button class="btn secondary" id="b-add-missing">+ Партия (отсутствует)</button>
    <button class="btn" id="f-save">${existing ? 'Сохранить' : 'Добавить'}</button>
    <button class="btn secondary" id="f-cancel">Отмена</button>
  `;

  document.getElementById('f-cancel').addEventListener('click', () => {
    state.tab = 'list';
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'list'));
    render();
  });
  function renderBatches() {
    const list = document.getElementById('batches-list');
    if (!list) return;
    const batches = existing.batches || [];
    if (batches.length === 0) {
      list.innerHTML = '<div class="meta" style="color:#888">Партий нет</div>';
      return;
    }
    list.innerHTML = batches.map((b, i) => `
      <div class="card" style="padding:8px;margin-bottom:6px">
        <div class="meta">${b.expirationDate ? esc(fmtDate(b.expirationDate)) : 'без даты'} × ${b.quantity}${b.isMarkedDown ? ' 🏷' : ''}${b.isMissing ? ' ⚪' : ''}</div>
        <div class="row" style="margin-top:4px">
          <button class="btn secondary btn-b-toggle" data-i="${i}" data-field="isMarkedDown">${b.isMarkedDown ? '↩️ Снять уценку' : '🏷️ Уценка'}</button>
          <button class="btn secondary btn-b-toggle" data-i="${i}" data-field="isMissing">${b.isMissing ? '↩️ На полку' : '⚪ Отсутствует'}</button>
          <button class="btn secondary btn-b-del" data-i="${i}">🗑️</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('.btn-b-toggle').forEach((btn) => btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.i);
      const field = btn.dataset.field;
      const b = batches[i];
      await api(`/api/products/${existing.id}/batches/${b.id}`, { method: 'PATCH', body: JSON.stringify({ [field]: !b[field] }) });
      loadAndRender();
    }));
    list.querySelectorAll('.btn-b-del').forEach((btn) => btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.i);
      const b = batches[i];
      try {
        await api(`/api/products/${existing.id}/batches/${b.id}`, { method: 'DELETE' });
        loadAndRender();
      } catch (e) {
        toast(e.message);
      }
    }));
  }
  renderBatches();
  document.getElementById('b-add').addEventListener('click', async () => {
    const expStr = document.getElementById('b-exp').value;
    await api(`/api/products/${existing.id}/batches`, { method: 'POST', body: JSON.stringify({ expirationDate: expStr ? new Date(expStr + 'T23:59:59').getTime() : null, quantity: 1 }) });
    toast('Партия добавлена');
    loadAndRender();
  });
  document.getElementById('b-add-marked').addEventListener('click', async () => {
    const expStr = document.getElementById('b-exp').value;
    await api(`/api/products/${existing.id}/batches`, { method: 'POST', body: JSON.stringify({ expirationDate: expStr ? new Date(expStr + 'T23:59:59').getTime() : null, quantity: 1, isMarkedDown: true }) });
    toast('Партия с уценкой добавлена');
    loadAndRender();
  });
  document.getElementById('b-add-missing').addEventListener('click', async () => {
    const expStr = document.getElementById('b-exp').value;
    await api(`/api/products/${existing.id}/batches`, { method: 'POST', body: JSON.stringify({ expirationDate: expStr ? new Date(expStr + 'T23:59:59').getTime() : null, quantity: 1, isMissing: true }) });
    toast('Партия (отсутствует) добавлена');
    loadAndRender();
  });
  document.getElementById('f-save').addEventListener('click', async () => {
    const barcode = document.getElementById('f-barcode').value.trim();
    const name = document.getElementById('f-name').value.trim();
    const hasExp = document.getElementById('f-hasexp').checked;
    const expStr = document.getElementById('f-exp').value;
    const body = {
      barcode,
      name,
      quantity: Number(document.getElementById('f-qty').value) || 1,
      category: document.getElementById('f-cat').value,
      hasExpirationDate: hasExp,
      expirationDate: hasExp && expStr ? new Date(expStr + 'T23:59:59').getTime() : null,
      hasShelfLife: false,
      shelfLifeValue: 0,
      shelfLifeUnit: 'days',
    };
    try {
      if (existing) await api(`/api/products/${existing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/products', { method: 'POST', body: JSON.stringify(body) });
      toast('Сохранено');
      state.tab = 'list';
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'list'));
      loadAndRender();
    } catch (e) {
      toast(e.message);
    }
  });
}

// ---------- Screen: settings ----------
async function renderSettings() {
  let categories = state.categories;
  // Список ключей синхронизации (Android). Загружаем отдельно:
  // рендер не должен падать, если ключи ещё не выпущены/недоступны.
  let tokens = [];
  try {
    tokens = (await api('/api/sync-tokens'))?.tokens || [];
  } catch (_) {
    /* показываем пустой список — пользователь сможет создать ключ позже */
  }
  $content.innerHTML = `
    <div class="section-title">Уведомления об истечении</div>
    <div class="field">
      <label>Предупреждать за (дней до окончания срока)</label>
      <select id="s-warn">
        ${[3, 5, 7, 10, 14]
          .map((d) => `<option value="${d}" ${state.settings.warningDays === d ? 'selected' : ''}>За ${d} дней</option>`)
          .join('')}
      </select>
    </div>

    <div class="section-title">Добавление товаров</div>
    <div class="field">
      <label>Категория по умолчанию</label>
      <input id="s-default-cat" value="${esc(state.settings.defaultCategory)}" placeholder="Например: Молочка" />
    </div>

    <div class="section-title">Категории</div>
    <div id="cat-list">
      ${categories.map((c) => `<span class="chip">${esc(c.name)} <button class="cat-del" data-name="${esc(c.name)}" style="border:none;background:none;color:var(--danger);cursor:pointer">✕</button></span>`).join('') || '<span class="empty">Пока нет</span>'}
    </div>
    <div class="field" style="margin-top:8px">
      <input id="s-new-cat" placeholder="Новая категория" />
      <button class="btn secondary" id="s-add-cat" style="margin-top:8px">Добавить категорию</button>
    </div>

    <div class="section-title">Данные</div>
    <input type="file" id="s-import" accept="application/json" />
    </div>
    <button class="btn secondary" id="s-export">⬇️ Экспорт JSON</button>
    <div class="section-title">Синхронизация с Android</div>
    <div id="sync-token-list">
      ${tokens.length === 0
        ? '<span class="empty">Пока нет ключей</span>'
        : tokens.map((t) => `
          <div class="chip" style="display:flex;align-items:center;gap:6px;justify-content:space-between;width:100%;margin:4px 0">
            <span>${esc(t.name || 'Без имени')} · <code>${esc(t.preview)}</code></span>
            <button class="sync-revoke" data-id="${t.id}" style="border:none;background:none;color:var(--danger);cursor:pointer">✕</button>
          </div>`).join('')}
    </div>
    <div class="field" style="margin-top:8px">
      <input id="s-sync-name" placeholder="Название устройства (например, «Pixel 8»)" />
      <button class="btn secondary" id="s-sync-create" style="margin-top:8px">🔑 Создать ключ</button>
    </div>
    <div id="s-sync-new" hidden style="margin-top:8px">
      <label>Новый ключ (показывается один раз):</label>
      <input id="s-sync-token" readonly style="width:100%;margin-top:4px" />
      <button class="btn secondary" id="s-sync-copy" style="margin-top:8px">📋 Копировать</button>
    </div>
    <p class="empty">
      Каждый ключ вставляется в Android: Настройки → Синхронизация → Добавить аккаунт.
      Ключ даёт доступ только к вашим товарам и не даёт контроль над ботом.
    </p>
  `;

  document.getElementById('s-warn').addEventListener('change', async (e) => {
    state.settings = await api('/api/settings/warning-days', {
      method: 'POST',
      body: JSON.stringify({ days: Number(e.target.value), updatedAt: Date.now() }),
    });
    toast('Сохранено');
  });
  document.getElementById('s-default-cat').addEventListener('change', async (e) => {
    state.settings = await api('/api/settings/default-category', {
      method: 'POST',
      body: JSON.stringify({ category: e.target.value.trim(), updatedAt: Date.now() }),
    });
    toast('Сохранено');
  });
  document.getElementById('s-add-cat').addEventListener('click', async () => {
    const name = document.getElementById('s-new-cat').value.trim();
    if (!name) return;
    await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
    toast('Категория добавлена');
    renderSettings();
  });
  $content.querySelectorAll('.cat-del').forEach((b) =>
    b.addEventListener('click', async () => {
      await api('/api/categories', { method: 'DELETE', body: JSON.stringify({ name: b.dataset.name }) });
      renderSettings();
    }),
  );
  document.getElementById('s-export').addEventListener('click', () => {
    // The export endpoint needs the initData header, so fetch as a blob.
    fetch('/api/export', { headers: { 'X-Telegram-Init-Data': INIT_DATA } })
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'shelflife-export.json';
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => toast('Ошибка экспорта'));
  });
  document.getElementById('s-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Импорт заменит ВСЕ текущие товары. Продолжить?')) return;
    const text = await file.text();
    const json = JSON.parse(text);
    await api('/api/import', { method: 'POST', body: JSON.stringify(json) });
    toast('Импорт завершён');
    loadAndRender();
  });


  // --- Синхронизация с Android (несколько ключей) ---
  const syncInput = document.getElementById('s-sync-token');
  const syncNewBox = document.getElementById('s-sync-new');

  document.getElementById('s-sync-create').addEventListener('click', async () => {
    const name = document.getElementById('s-sync-name').value.trim();
    try {
      const { token } = await api('/api/sync-tokens', { method: 'POST', body: JSON.stringify({ name }) });
      if (token) {
        syncInput.value = token;
        syncNewBox.hidden = false;
        toast('Ключ создан');
      } else {
        toast('Не удалось создать ключ');
      }
    } catch (e) {
      toast(e.message || 'Ошибка создания ключа');
    }
  });

  document.getElementById('s-sync-copy').addEventListener('click', async () => {
    const value = syncInput.value.trim();
    if (!value) return toast('Сначала создайте ключ');
    try {
      await navigator.clipboard.writeText(value);
      toast('Ключ скопирован');
    } catch (_) {
      syncInput.select();
      toast('Нажмите Ctrl/⌘+C');
    }
  });

  document.querySelectorAll('.sync-revoke').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Отозвать этот ключ? Устройство перестанет синхронизироваться.')) return;
      await api('/api/sync-tokens/' + b.dataset.id, { method: 'DELETE' });
      toast('Ключ отозван');
      renderSettings();
    })
  );
}

// ---------- boot ----------
loadAndRender();


