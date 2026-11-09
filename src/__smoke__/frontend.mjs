// Smoke-тест фронтенда: грузим public/app.js в Node с минимальным мок-DOM/fetch,
// чтобы убедиться, что модуль boot-ится без ошибок и дерётся с нужными эндпоинтами.
// Запуск: node src/__smoke__/frontend.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(here, '../../public/app.js');

const calls = [];
function mkEl(extra = {}) {
  return {
    innerHTML: '',
    hidden: true,
    textContent: '',
    value: '',
    checked: false,
    addEventListener() {},
    dataset: {},
    querySelectorAll() {
      return [];
    },
    classList: { add() {}, remove() {}, toggle() {} },
    ...extra,
  };
}

const elements = {};
const documentMock = {
  getElementById(id) {
    return (elements[id] ??= mkEl());
  },
  querySelectorAll() {
    return [];
  },
};
const windowMock = { Telegram: undefined };

globalThis.window = windowMock;
globalThis.document = documentMock;
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify([]);
    },
    async json() {
      return [];
    },
  };
};

let ok = true;
try {
  const code = fs.readFileSync(appPath, 'utf8');
  // evaluated as a module so top-level code (incl. loadAndRender) runs.
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  ok = true;
} catch (e) {
  ok = false;
  console.error('app.js boot FAILED:', e);
}

// Даём микротаскам выполниться (boot вызывает fetch асинхронно).
await new Promise((r) => setTimeout(r, 50));

const expected = ['/api/products', '/api/settings', '/api/categories'];
const hit = expected.filter((e) => calls.includes(e));
console.log('boot ok:', ok);
console.log('api calls made:', calls.join(', ') || '(none)');
console.log('expected endpoints hit:', hit.length + '/' + expected.length);
process.exit(ok && hit.length === expected.length ? 0 : 1);
