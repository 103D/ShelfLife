// Smoke-тест страницы «Карточки» (public/report.js): грузим модуль в Node с
// минимальным мок-DOM/fetch и проверяем, что init() не падает на отсутствующих
// элементах и реально доходит до загрузки карточек и настроек.
// Запуск: node src/__smoke__/report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const reportJsPath = path.resolve(here, '../../public/report.js');
const reportHtmlPath = path.resolve(here, '../../public/report.html');
const reportCssPath = path.resolve(here, '../../public/report.css');

const code = fs.readFileSync(reportJsPath, 'utf8');
const css = fs.readFileSync(reportCssPath, 'utf8');
const html = fs.readFileSync(reportHtmlPath, 'utf8');

// Длинное название — проверяем, что оно выводится целиком, а ограничение
// двумя строками делает CSS (line-clamp), а не обрезка по символам.
const LONG_NAME = 'Очень длинное название товара для проверки обрезки';
const CARD_ITEM = {
  id: 1,
  name: LONG_NAME,
  category: 'Молочное',
  daysRemaining: 3,
  expirationCategory: 'ON_SALE',
  expirationLabel: 'Уценка',
  isMarkedDown: false,
  isMissing: false,
  hasExpirationDate: true,
  expirationDate: Date.now() + 3 * 86400000,
  manufacturingDate: Date.now() - 10 * 86400000,
  hasShelfLife: true,
  shelfLifeValue: 13,
  shelfLifeUnit: 'days',
};
// id, которые реально существуют: из HTML + те, что скрипт создаёт через innerHTML.
const knownIds = new Set([
  ...[...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
  ...[...code.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
]);

const calls = [];
const listeners = [];

function mkEl(sel = '') {
  return {
    innerHTML: '',
    hidden: true,
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    style: {},
    onclick: null,
    _sel: sel,
    addEventListener(type) {
      listeners.push(sel + ':' + type);
    },
    setAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll() {
      return [];
    },
  };
}

const cache = new Map();
const documentMock = {
  readyState: 'complete',
  // Как в браузере: несуществующий id даёт null (а не заглушку).
  querySelector(sel) {
    const byId = /^#([A-Za-z0-9_-]+)$/.exec(sel);
    if (byId && !knownIds.has(byId[1])) return null;
    if (!cache.has(sel)) cache.set(sel, mkEl(sel));
    return cache.get(sel);
  },
  querySelectorAll() {
    return [];
  },
  addEventListener() {},
};

globalThis.window = { Telegram: undefined, location: { origin: 'https://example.test' } };
globalThis.document = documentMock;
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(new URL(u).pathname);
  return {
    ok: true,
    status: 200,
    async json() {
      if (u.includes('/api/report/cards')) return { items: [CARD_ITEM], total: 1, hasMore: false, groups: {} };
      if (u.includes('/api/settings')) {
        return { warningDays: 7, sort: 'date', sortDir: 'asc', statusFilter: 'all', updatedAt: 0 };
      }
      return { items: [] };
    },
  };
};

let ok = true;
try {
  await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
} catch (e) {
  ok = false;
  console.error('report.js boot FAILED:', e);
}

// Даём микротаскам выполниться (boot вызывает fetch асинхронно).
await new Promise((r) => setTimeout(r, 50));

const expected = ['/api/report/cards', '/api/settings'];
const hit = expected.filter((e) => calls.includes(e));
const settingsWired = listeners.includes('#btn-settings:click');

// Карточка отрендерена с длинным названием: title = полное имя и сам текст
// тоже полный (перенос максимум на две строки делает CSS).
const cardHtml = (cache.get('#card') || {}).innerHTML || '';
const titleOk = cardHtml.includes('title="' + LONG_NAME + '"');
const fullNameShown = cardHtml.includes('>' + LONG_NAME + '<');
const cssTwoLines =
  /\.card--stack__name[\s\S]*?-webkit-line-clamp:\s*2/.test(css) &&
  /\.list-item \.name[\s\S]*?-webkit-line-clamp:\s*2/.test(css);
// Док «Дата производства» лежит вне .view — showView обязан скрывать его
// на экранах, отличных от карточек.
const dockHiddenOutsideStack =
  /function showView\(name\)[\s\S]*?#card-date-dock'\)\.hidden\s*=\s*name !== 'stack'/.test(code);
// display:flex у дока перебивает UA-правило [hidden] — нужен явный селектор.
const dockHiddenCss = /\.card-date-dock\[hidden\][\s\S]*?display:\s*none/.test(css);
const noCharTruncation = !code.includes('MAX_TITLE_LENGTH') && !code.includes('truncate(');
// Под полем даты производства — вычисленная дата истечения из данных сервера.
const expInfoText = (cache.get('#card-exp-info') || {}).textContent || '';
const expInfoOk = expInfoText.includes('Истекает:') && expInfoText.includes('3 дн.');
// Даты: режим по умолчанию — «срок хранения» (если он известен), а даты
// продублированы текстом dd.mm.yyyy, чтобы формат нативного input не путал.
const dateLabelText = (cache.get('#card-date-label') || {}).textContent || '';
const shelfModeDefault = dateLabelText === 'Дата производства';
const expInfoHasShelf =
  expInfoText.includes('Производство:') && expInfoText.includes('срок 13 дн.');
const dateModesInHtml =
  /data-date-mode="shelf"/.test(html) && /data-date-mode="exact"/.test(html);
const hasExactModeLogic =
  code.includes('computeExpirationLocal') &&
  code.includes("canShelf ? 'shelf' : 'exact'") &&
  code.includes('endOfDayInput(v)');
// Селектор/фильтр/сортировка — только на странице настроек.
const settingsControlsWired =
  listeners.includes('#settings-sort-dir:click') &&
  listeners.includes('#settings-save:click') &&
  listeners.includes('#settings-back:click');
const topbarSortRemoved =
  documentMock.querySelector('#card-sort') === null &&
  documentMock.querySelector('#btn-sort-dir') === null &&
  documentMock.querySelector('#list-sort') === null;

console.log('boot ok:', ok);
console.log('api calls made:', calls.join(', ') || '(none)');
console.log('expected endpoints hit:', hit.length + '/' + expected.length);
console.log('settings button wired:', settingsWired);
console.log('card title has full name:', titleOk);
console.log('card shows full name (2-line clamp via CSS):', fullNameShown);
console.log('name limited to 2 lines in card & list (CSS):', cssTwoLines);
console.log('no character truncation in JS:', noCharTruncation);
console.log('date dock hidden outside stack view:', dockHiddenOutsideStack);
console.log('date dock [hidden] CSS rule present:', dockHiddenCss);
console.log('expiration info under date field:', expInfoOk, '(text:', JSON.stringify(expInfoText) + ')');
console.log('default date mode = shelf (production):', shelfModeDefault, '(label:', JSON.stringify(dateLabelText) + ')');
console.log('shelf info shows production + shelf life:', expInfoHasShelf);
console.log('date mode switch present in HTML:', dateModesInHtml);
console.log('exact-expiration mode wired (local compute/end of day):', hasExactModeLogic);
console.log('settings controls wired (sort dir / save / back):', settingsControlsWired);
console.log('sort controls removed from main/list (only settings):', topbarSortRemoved);
process.exit(
  ok &&
    hit.length === expected.length &&
    settingsWired &&
    titleOk &&
    fullNameShown &&
    cssTwoLines &&
    noCharTruncation &&
    dockHiddenOutsideStack &&
    dockHiddenCss &&
    expInfoOk &&
    shelfModeDefault &&
    expInfoHasShelf &&
    dateModesInHtml &&
    hasExactModeLogic &&
    settingsControlsWired &&
    topbarSortRemoved
    ? 0
    : 1,
);
