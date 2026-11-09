const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const INIT_DATA = tg ? tg.initData : '';
// Тёмная тема задаётся в styles.css/report.css принудительно — не
// переопределяем цвета из themeParams Telegram (иначе светлая тема ТГ
// «сломает» тёмный дизайн).
if (tg) {
  try {
    tg.setHeaderColor?.('#0e1013');
    tg.setBackgroundColor?.('#0e1013');
  } catch (_) {}
}
const BASE = window.location.origin;

const state = {
  page: 0,
  items: [],
  total: 0,
  hasMore: false,
  currentIndex: 0,
  loading: false,
  stackExhausted: false,
  listPage: 0,
  listItems: [],
  warnDays: null,
  /** Направление сортировки карточек: 'asc' — по возрастанию, 'desc' — по убыванию. */
  dir: 'asc',
  /** Поле сортировки карточек: 'date' | 'category' | 'name'. */
  sort: 'date',
  /** Фильтр по статусу: all | expired | onsale | missing | fresh. */
  status: 'all',
  /** Режим правки даты: 'shelf' (производство + срок) или 'exact' (дата истечения). */
  dateMode: null,
  /** Для какого товара выбран dateMode (сбрасываем при смене карточки). */
  dateModeProductId: null,
};

const qs = (s) => document.querySelector(s);
const qsa = (s) => Array.from(document.querySelectorAll(s));

function api(path, opts = {}) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    opts.headers || {}
  );
  if (INIT_DATA) headers['X-Telegram-Init-Data'] = INIT_DATA;
  return fetch(BASE + path, { ...opts, headers }).then(async (r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function toast(msg) {
  const t = qs('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), 2200);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Название в карточке и списке показываем полностью и переносим максимум на
 * две строки (CSS line-clamp). Обрезка по символам убрана: она не давала
 * прочитать длинные названия. Полное имя по-прежнему доступно в атрибуте
 * title, а в карточке — по тапу (toast).
 */

/** dd.mm.yyyy из epoch-миллисекунд. */
function fmtDate(ms) {
  const d = new Date(ms);
  return (
    String(d.getDate()).padStart(2, '0') +
    '.' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '.' +
    d.getFullYear()
  );
}

/** yyyy-mm-dd из epoch-миллисекунд для <input type="date"> (локальная дата). */
function toDateInput(ms) {
  const d = new Date(ms);
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

/** «Истекает: dd.mm.yyyy · N дн.» — из данных, посчитанных сервером. */
function expirationInfoText(p) {
  if (!p.expirationDate) return 'Дата истечения: — (нет срока хранения)';
  let tail = '';
  if (p.daysRemaining != null) {
    tail = p.daysRemaining <= 0 ? ' · просрочен' : ' · ' + p.daysRemaining + ' дн.';
  }
  return 'Истекает: ' + fmtDate(p.expirationDate) + tail;
}

/**
 * Дата истечения из даты производства + срока хранения — как в Android:
 * прибавляем value-1 календарных дней (день производства — первый день),
 * месяцы считаем календарно с клампингом, затем ставим 23:59:59 последнего
 * дня. Считаем в таймзоне телефона, поэтому результат совпадает с Android,
 * даже если сервер живёт в UTC.
 */
function computeExpirationLocal(mfgMs, value, unit) {
  if (mfgMs == null || !value) return null;
  // День производства больше не вычитается: 10 дней от 01.01 -> 11.01.
  const n = value;
  const d = new Date(mfgMs);
  if (unit === 'months') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  } else {
    d.setDate(d.getDate() + n);
  }
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Полночь выбранной в <input type="date"> даты (локальная TZ). */
function fromDateInput(v) {
  return new Date(v + 'T00:00:00').getTime();
}

/** Конец выбранного дня (локальная TZ): срок действует весь последний день. */
function endOfDayInput(v) {
  const d = new Date(v + 'T00:00:00');
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * Быстрое сохранение даты товара (нажал → изменил → сохранил).
 * Срок хранения: правится дата производства, дата истечения пересчитывается.
 * Иначе — сохраняется сама дата истечения.
 */
async function saveProductDate(p, value) {
  const isShelf = !!(p.hasShelfLife && p.shelfLifeValue > 0);
  let body;
  if (isShelf) {
    if (!value) {
      body = { manufacturingDate: null, hasExpirationDate: false, expirationDate: null };
    } else {
      const ms = fromDateInput(value);
      body = {
        manufacturingDate: ms,
        hasExpirationDate: true,
        expirationDate: computeExpirationLocal(ms, p.shelfLifeValue, p.shelfLifeUnit),
      };
    }
  } else {
    body = value
      ? { hasExpirationDate: true, expirationDate: endOfDayInput(value) }
      : { hasExpirationDate: false, expirationDate: null };
  }
  const updated = await api('/api/products/' + p.id, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  Object.assign(p, updated);
  return { isShelf };
}

function statusBadge(p) {
  if (p.isMissing) return { label: '⚪ отсутствует', cls: 'missing' };
  if (p.isMarkedDown) return { label: '🏷 уценен', cls: 'marked' };
  if (p.expirationCategory === 'EXPIRED') return { label: '🔴 списание', cls: 'expired' };
  if (p.expirationCategory === 'ON_SALE') return { label: '🟠 уценка', cls: 'onsale' };
  return { label: '✅ свежий', cls: 'other' };
}

// ---------- Stack ----------
async function loadPage(page) {
  state.loading = true;
  try {
    const res = await api('/api/report/cards?page=' + page + '&sort=' + state.sort + '&dir=' + state.dir + '&status=' + state.status);
    state.page = page;
    state.items = res.items || [];
    state.total = res.total || 0;
    state.hasMore = !!res.hasMore;
    state.currentIndex = 0;
    state.stackExhausted = state.items.length === 0 && !state.hasMore;
    if (state.stackExhausted) {
      showList();
      return;
    }
    renderCard();
  } catch (e) {
    toast('Не удалось загрузить карточки');
  } finally {
    state.loading = false;
  }
}

/** Синхронизировать активные чипы фильтра статусов (main и settings). */
function updateStatusChips() {
  const active = state.status;
  qsa('#main-filter .chip, #settings-filter .chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.status === active)
  );
}

/** Фильтр по статусу для списка (та же семантика, что в /api/report/cards). */
function matchesStatus(p, status) {
  if (status === 'missing') return !!p.isMissing;
  if (status === 'marked') return !!p.isMarkedDown;
  if (status === 'expired') return p.expirationCategory === 'EXPIRED';
  if (status === 'onsale') return p.expirationCategory === 'ON_SALE';
  if (status === 'fresh') return p.expirationCategory === 'OTHER';
  return true;
}

/** Синхронизировать иконку направления сортировки карточек (в topbar и в settings). */
function updateSortIcon() {
  qsa('#settings-sort-dir').forEach((b) => {
    b.textContent = state.dir === 'asc' ? '↑' : '↓';
    b.setAttribute(
      'aria-label',
      state.dir === 'asc' ? 'Сортировка по сроку: по возрастанию' : 'Сортировка по сроку: по убыванию'
    );
  });
}

/** Загрузить период уценки из настроек (синхронизируется с Android). */
async function loadWarnDays() {
  try {
    const s = await api('/api/settings');
    if (!s) return;
    state.warnDays = s.warningDays != null ? s.warningDays : 7;
    state.sort = s.sort || 'date';
    // Сервер отдаёт `sortDir`/`statusFilter`; старые сборки mini-app ждали
    // `dir`/`status`. Читаем оба варианта, иначе фильтр не восстанавливался.
    state.dir = s.sortDir || s.dir || 'asc';
    state.status = s.statusFilter || s.status || 'all';
    const sSel = qs('#settings-warn-days');
    if (sSel && s.warningDays != null) sSel.value = String(s.warningDays);
    const sSortSel = qs('#settings-sort');
    if (sSortSel) sSortSel.value = state.sort;
    updateStatusChips();
    updateSortIcon();
  } catch (_) {}
}

function currentProduct() {
  return state.items[state.currentIndex];
}

function renderCard() {
  const p = currentProduct();
  qs('#card-date-dock').hidden = true;
  if (!p) {
    qs('#stack-view').hidden = true;
    qs('#empty-view').hidden = false;
    return;
  }
  const card = qs('#card');
  const badge = statusBadge(p);
  const days = p.daysRemaining == null ? 'без срока' : p.daysRemaining + ' дн.';
  const cat = p.category || '—';
  card.innerHTML =
    '<div class="card--stack__inner">' +
    '  <div class="card--stack__badge ' + badge.cls + '">' + badge.label + '</div>' +
    '  <div class="card--stack__name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
    '  <div class="card--stack__meta">[' + esc(cat) + '] · ' + esc(days) + '</div>' +
    '  <div class="card--stack__actions">' +
    '    <button class="btn secondary" id="card-marked">' + (p.isMarkedDown ? '↩️ Снять уценку' : '🏷️ Уценка') + '</button>' +
    '    <button class="btn secondary" id="card-missing">' + (p.isMissing ? '↩️ На полку' : '⚪ Отсутствует') + '</button>' +
    '  </div>' +
    '</div>';
  // Тап по названию показывает полное имя (в TG нативный title не всплывает).
  const nameEl = card.querySelector ? card.querySelector('.card--stack__name') : null;
  if (nameEl) {
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toast(p.name);
    });
  }
  const counterText = 'Товар ' + (state.currentIndex + 1) + ' из ' + state.total;
  qs('#card-counter').textContent = counterText;
  const navCounter = qs('#card-counter-nav');
  if (navCounter) navCounter.textContent = (state.currentIndex + 1) + ' / ' + state.total;
  qs('#btn-prev').disabled = state.page === 0 && state.currentIndex === 0;
  qs('#btn-next').disabled =
    state.currentIndex + 1 >= state.items.length && !state.hasMore;
  resetCardTransform();

  // ---- Даты: два режима, как в Android (ExpirationMode) ----
  // 'shelf' — вводим дату производства, срок считается из shelfLifeValue;
  // 'exact' — вводим дату истечения напрямую (для товаров без срока хранения
  // и для случаев, когда на упаковке указана именно дата истечения).
  const canShelf = !!(p.hasShelfLife && p.shelfLifeValue > 0);
  if (state.dateModeProductId !== p.id) {
    state.dateModeProductId = p.id;
    state.dateMode = canShelf ? 'shelf' : 'exact';
  }
  if (state.dateMode === 'shelf' && !canShelf) state.dateMode = 'exact';
  const isShelf = state.dateMode === 'shelf';

  qsa('#date-mode .chip').forEach((b) => {
    const shelfBtn = b.dataset.dateMode === 'shelf';
    if (shelfBtn) b.hidden = !canShelf;
    b.classList.toggle('active', b.dataset.dateMode === state.dateMode);
  });

  const dock = qs('#card-date-dock');
  dock.hidden = false;
  const dateLabel = qs('#card-date-label');
  const input = qs('#card-date');
  const expInfo = qs('#card-exp-info');
  if (isShelf) {
    if (dateLabel) dateLabel.textContent = 'Дата производства';
    if (input) input.value = p.manufacturingDate ? toDateInput(p.manufacturingDate) : '';
    // Дублируем даты текстом в dd.mm.yyyy: нативный input показывает формат
    // локали (например, 10/08/2026), из-за чего даты путались.
    const mfgText = p.manufacturingDate ? fmtDate(p.manufacturingDate) : '—';
    const shelfText = p.shelfLifeValue + ' ' + (p.shelfLifeUnit === 'months' ? 'мес.' : 'дн.');
    if (expInfo) {
      expInfo.textContent =
        'Производство: ' + mfgText + ' · срок ' + shelfText + '\n' + expirationInfoText(p);
    }
  } else {
    if (dateLabel) dateLabel.textContent = 'Дата истечения';
    if (input) input.value = p.expirationDate ? toDateInput(p.expirationDate) : '';
    if (expInfo) expInfo.textContent = expirationInfoText(p);
  }

  // onchange (а не addEventListener): renderCard вызывается многократно, и
  // накопленные слушатели отправляли бы несколько PUT подряд.
  if (input) {
    input.onchange = async () => {
      const v = input.value;
      try {
        let bodyDate;
        if (isShelf) {
          if (!v) {
            // Очистили производство — срок вычислить нельзя.
            bodyDate = { manufacturingDate: null, hasExpirationDate: false, expirationDate: null };
          } else {
            const ms = fromDateInput(v);
            bodyDate = {
              manufacturingDate: ms,
              hasExpirationDate: true,
              expirationDate: computeExpirationLocal(ms, p.shelfLifeValue, p.shelfLifeUnit),
            };
          }
        } else {
          bodyDate = v
            ? { hasExpirationDate: true, expirationDate: endOfDayInput(v) }
            : { hasExpirationDate: false, expirationDate: null };
        }
        const updated = await api('/api/products/' + p.id, {
          method: 'PUT',
          body: JSON.stringify(bodyDate),
        });
        Object.assign(p, updated);
        renderCard();
        toast(isShelf ? 'Дата производства обновлена' : 'Дата истечения обновлена');
      } catch (e) {
        toast('Ошибка');
      }
    };
  }
  const btnMarked = qs('#card-marked');
  if (btnMarked) {
    btnMarked.addEventListener('click', (e) => {
      e.stopPropagation();
      setStatus(p, 'isMarkedDown', !p.isMarkedDown);
    });
  }
  const btnMissing = qs('#card-missing');
  if (btnMissing) {
    btnMissing.addEventListener('click', (e) => {
      e.stopPropagation();
      setStatus(p, 'isMissing', !p.isMissing);
    });
  }
}

/** Переключить статус главной (ближайшей) партии и обновить карточку. */
async function setStatus(p, field, value) {
  try {
    const updated = await api('/api/products/' + p.id + '/status', {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    });
    Object.assign(p, updated);
    renderCard();
    toast(field === 'isMarkedDown'
      ? (updated.isMarkedDown ? '🏷️ Уценка' : '↩️ Уценка снята')
      : (updated.isMissing ? '⚪ Отсутствует' : '↩️ На полке'));
  } catch (e) {
    toast('Ошибка');
  }
}

function resetCardTransform() {
  const card = qs('#card');
  card.style.transition = 'transform 0.25s ease';
  card.style.transform = 'translateX(0) perspective(1200px) scale(1)';
  card.classList.remove('swiped-left', 'swiped-right');
}

function advance(delta) {
  if (state.loading) return;
  if (state.items.length === 0) return;
  const next = state.currentIndex + delta;
  if (next >= 0 && next < state.items.length) {
    state.currentIndex = next;
    renderCard();
    return;
  }
  if (delta > 0 && state.hasMore) {
    loadPage(state.page + 1);
    return;
  }
  if (delta < 0 && state.page > 0) {
    loadPage(state.page - 1);
    return;
  }
  // exhausted
  if (delta > 0) showList();
}

function markCurrent(action) {
  const p = currentProduct();
  if (!p) return;
  api('/api/products/' + p.id + '/action', {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
    .then(() => {
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
      state.currentIndex = Math.min(state.currentIndex + 1, state.items.length);
      if (state.currentIndex >= state.items.length && state.hasMore) {
        loadPage(state.page + 1);
      } else if (state.currentIndex >= state.items.length && !state.hasMore) {
        showList();
      } else {
        renderCard();
      }
    })
    .catch(() => toast('Ошибка отметки'));
}

function showList() {
  qs('#stack-view').hidden = true;
  qs('#list-view').hidden = false;
  qs('#settings-view').hidden = true;
  // Док «Дата производства» относится только к карточкам.
  qs('#card-date-dock').hidden = true;
  const tabs = qsa('#tabs .tab');
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === 'list'));
  loadList();
}

// ---------- List ----------
async function loadList() {
  try {
    const q = qs('#list-search').value.trim();
    const res = await api('/api/products?q=' + encodeURIComponent(q));
    let items = Array.isArray(res) ? res : (res.items || []);
    // Статусный фильтр — тот же, что у карточек (чипы на главном экране/в настройках).
    if (state.status && state.status !== 'all') {
      items = items.filter((p) => matchesStatus(p, state.status));
    }
    // Сортировка общая с карточками — задаётся на странице настроек.
    const sort = state.sort;
    const dir = state.dir;
    items.sort((a, b) => {
      let cmp = 0;
      if (sort === 'date') cmp = (a.daysRemaining ?? 1e9) - (b.daysRemaining ?? 1e9);
      else if (sort === 'category') cmp = (a.category || '').localeCompare(b.category || '', 'ru');
      else cmp = (a.name || '').localeCompare(b.name || '', 'ru');
      return dir === 'desc' ? -cmp : cmp;
    });
    state.listItems = items;
    state.listPage = 0;
    renderList();
  } catch (e) {
    toast('Не удалось загрузить список');
  }
}

function renderList() {
  const container = qs('#list');
  const empty = qs('#list-empty');
  const pager = qs('#list-pager');
  const perPage = 20;
  const total = state.listItems.length;
  const start = state.listPage * perPage;
  const pageItems = state.listItems.slice(start, start + perPage);
  if (pageItems.length === 0) {
    container.innerHTML = '';
    empty.hidden = false;
    pager.hidden = true;
    return;
  }
  empty.hidden = true;
  container.innerHTML = pageItems.map((p) => {
    const b = statusBadge(p);
    const days = p.daysRemaining == null ? 'без срока' : p.daysRemaining + ' дн.';
    const isShelf = !!(p.hasShelfLife && p.shelfLifeValue > 0);
    const dateMs = isShelf ? p.manufacturingDate : p.expirationDate;
    const dateLabel = isShelf ? 'Производство' : 'Срок';
    const dateText = dateMs ? fmtDate(dateMs) : '—';
    return (
      '<div class="list-item">' +
      '  <div class="row">' +
      '    <span class="name" title="' + esc(p.name) + '">' + esc(p.name) + '</span>' +
      '    <span class="badge ' + b.cls + '">' + b.label + '</span>' +
      '  </div>' +
      '  <div class="meta">[' + esc(p.category || '—') + '] · ' + esc(days) + '</div>' +
      '  <button class="date-edit" data-id="' + p.id + '" title="Изменить дату">' +
      '    📅 ' + esc(dateLabel) + ': ' + esc(dateText) + ' <span class="pen">✏️</span>' +
      '  </button>' +
      '</div>'
    );
  }).join('');
  if (total > perPage) {
    pager.hidden = false;
    pager.innerHTML =
      '<button class="btn secondary" id="list-prev" ' + (state.listPage === 0 ? 'disabled' : '') + '>←</button>' +
      '<span>' + (state.listPage + 1) + ' / ' + Math.ceil(total / perPage) + '</span>' +
      '<button class="btn secondary" id="list-next" ' + (start + perPage >= total ? 'disabled' : '') + '>→</button>';
    qs('#list-prev').onclick = () => { if (state.listPage > 0) { state.listPage--; renderList(); } };
    qs('#list-next').onclick = () => { if (start + perPage < total) { state.listPage++; renderList(); } };
  } else {
    pager.hidden = true;
  }
}

// ---------- Init ----------

/** Переключение между экранами: 'stack' | 'list' | 'settings' | 'empty'. */
function showView(name) {
  qs('#stack-view').hidden = name !== 'stack';
  qs('#list-view').hidden = name !== 'list';
  qs('#settings-view').hidden = name !== 'settings';
  qs('#empty-view').hidden = name !== 'empty';
  // Главный фильтр нужен на карточках и в списке; в настройках он дублируется.
  const mainFilter = qs('#main-filter');
  if (mainFilter) mainFilter.hidden = name === 'settings';
  // Док «Дата производства» лежит вне .view, поэтому скрываем его отдельно:
  // иначе он остаётся висеть в списке и на странице настроек.
  qs('#card-date-dock').hidden = name !== 'stack' || !currentProduct();
}

function init() {
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setupSwipeBehavior({ verticalOnly: false }); } catch (e) {}
  }

  qsa('#tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      qsa('#tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
      if (btn.dataset.tab === 'tinder') {
        qs('#stack-view').hidden = false;
        qs('#list-view').hidden = true;
        qs('#settings-view').hidden = true;
        qs('#empty-view').hidden = true;
        // Док показываем только если есть текущий товар.
        qs('#card-date-dock').hidden = !currentProduct();
        if (state.items.length === 0 && !state.loading) loadPage(0);
      } else {
        showList();
      }
    });
  });

  // В topbar нет кнопки обновления — элемент опционален. Без проверки на null
  // здесь падал TypeError, и init() обрывался ДО loadWarnDays()/loadPage(0) и
  // до привязки обработчиков настроек: карточки пустые, ⚙ не реагирует.
  const btnRefresh = qs('#btn-refresh');
  if (btnRefresh) btnRefresh.addEventListener('click', () => loadPage(0));
  updateStatusChips();
  loadWarnDays();
  updateSortIcon();
  qs('#btn-prev').addEventListener('click', () => advance(-1));
  qs('#btn-next').addEventListener('click', () => advance(1));

  // ----- Главный фильтр статусов (карточки + список) -----
  qsa('#main-filter .chip').forEach((b) =>
    b.addEventListener('click', () => {
      state.status = b.dataset.status;
      updateStatusChips();
      loadPage(0);
      if (qs('#list-view') && !qs('#list-view').hidden) loadList();
    })
  );

  // ----- Быстрое изменение даты из списка: нажал → изменил → сохранил -----
  qs('#list').addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.date-edit');
    if (!btn) return;
    e.stopPropagation();
    const p = state.listItems.find((x) => String(x.id) === btn.dataset.id);
    if (!p) return;
    const isShelf = !!(p.hasShelfLife && p.shelfLifeValue > 0);
    const cur = isShelf ? p.manufacturingDate : p.expirationDate;
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'date-edit-input';
    input.value = cur ? toDateInput(cur) : '';
    btn.replaceWith(input);
    input.focus();
    try { input.showPicker && input.showPicker(); } catch (_) {}
    input.addEventListener('change', async () => {
      try {
        const { isShelf: wasShelf } = await saveProductDate(p, input.value);
        toast(wasShelf ? 'Дата производства обновлена' : 'Дата истечения обновлена');
        loadList();
      } catch (_) {
        toast('Ошибка');
      }
    });
  });

  // ----- Settings view -----
  qs('#btn-settings').addEventListener('click', () => showView('settings'));
  qs('#settings-back').addEventListener('click', () => showView('stack'));
  qsa('#settings-filter .chip').forEach((b) =>
    b.addEventListener('click', () => {
      state.status = b.dataset.status;
      updateStatusChips();
      loadPage(0);
    })
  );
  const settingsWarn = qs('#settings-warn-days');
  if (settingsWarn) {
    settingsWarn.addEventListener('change', async () => {
      try {
        await api('/api/settings/warning-days', {
          method: 'POST',
          body: JSON.stringify({ days: Number(settingsWarn.value), updatedAt: Date.now() }),
        });
        state.warnDays = Number(settingsWarn.value);
        loadWarnDays();
        toast('Период уценки обновлён');
      } catch (e) {
        toast('Ошибка');
      }
    });
  }
  const settingsSort = qs('#settings-sort');
  if (settingsSort) {
    settingsSort.addEventListener('change', () => {
      state.sort = settingsSort.value;
      loadPage(0);
    });
  }
  qs('#settings-sort-dir').addEventListener('click', () => {
    state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    updateSortIcon();
    loadPage(0);
  });
  qs('#settings-save').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          warningDays: state.warnDays,
          sort: state.sort,
          // Канонические имена полей сервера (см. /api/settings).
          sortDir: state.dir,
          statusFilter: state.status,
          updatedAt: Date.now(),
        }),
      });
      loadPage(0);
      toast('Настройки сохранены');
      showView('stack');
    } catch (e) {
      toast('Ошибка сохранения');
    }
  });

  // Переключение режима правки даты: по сроку хранения или по дате истечения.
  qsa('#date-mode .chip').forEach((b) =>
    b.addEventListener('click', () => {
      const p = currentProduct();
      if (!p) return;
      if (b.dataset.dateMode === 'shelf' && !(p.hasShelfLife && p.shelfLifeValue > 0)) return;
      state.dateMode = b.dataset.dateMode;
      renderCard();
    })
  );

  qs('#list-search').addEventListener('input', () => loadList());

  // Swipe handlers
  const card = qs('#card');
  let startX = 0;
  let startY = 0;
  let dragging = false;
  card.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    dragging = true;
    card.style.transition = 'none';
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > Math.abs(dy)) {
      card.style.transform = 'translateX(' + dx + 'px) perspective(1200px) scale(1)';
    }
  }, { passive: true });
  card.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    card.style.transition = 'transform 0.25s ease';
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) {
        card.classList.add('swiped-left');
        markCurrent('markeddown');
      } else {
        card.classList.add('swiped-right');
        markCurrent('missing');
      }
    } else {
      card.style.transform = 'translateX(0) perspective(1200px) scale(1)';
    }
  }, { passive: true });

  loadPage(0);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
