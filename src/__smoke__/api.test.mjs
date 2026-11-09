// Интеграционный тест бэкенда: поднимает Express-приложение в памяти (DEV_AUTH),
// прогоняет CRUD товаров, категоризацию сроков, валидацию GS1, справочники,
// экспорт/импорт. Без сети (Open Food Facts мокается не нужен — используем кэш/ручной ввод).
// Запуск: node --test src/__smoke__/api.test.mjs  (или просто node src/__smoke__/api.test.mjs)
process.env.BOT_TOKEN = '123:test';
process.env.DEV_AUTH = '1';
process.env.DB_PATH = ':memory:';
process.env.WEBAPP_STATIC_DIR = './public';
// UTC — чтобы календарная арифметика дат в тестах была детерминирована.
process.env.TZ = 'UTC';

const { test } = await import('node:test');
const assert = await import('node:assert/strict');

// Импортируем как tsx-скомпилированный модуль через tsx loader.
const { createApp } = await import('../api/server.ts');

const app = createApp();

// Минимальный fetch-обёртка над Express-приложением.
async function call(method, url, body) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-json */
    }
    return { status: res.status, json, text };
  } finally {
    server.close();
  }
}

await test('health', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

await test('product CRUD + expiration categorization', async () => {
  // Одиночное создание отключено: добавление — только из Android (sync import).
  let r = await call('POST', '/api/products', { barcode: '4810268038006', name: 'Молоко' });
  assert.equal(r.status, 403);

  // Создаём товары через sync-import (путь Android-приложения).
  r = await call('POST', '/api/import', {
    products: [
      {
        // Просрочен (expirationDate в прошлом).
        barcode: '4810268038006',
        name: 'Молоко',
        quantity: 2,
        hasExpirationDate: true,
        expirationDate: 1000,
        category: 'Молочка',
        updatedAt: Date.now(),
      },
      {
        // Истекает через 2 дня => при warningDays=7 это ON_SALE.
        barcode: '4601234567897',
        name: 'Йогурт',
        hasExpirationDate: true,
        expirationDate: Date.now() + 2 * 86400000,
        updatedAt: Date.now(),
      },
    ],
  });
  assert.equal(r.json.importedCount, 2);

  // Категоризация сроков считается на чтении.
  r = await call('GET', '/api/products');
  assert.equal(r.json.length, 2);
  const milk = r.json.find((p) => p.barcode === '4810268038006');
  assert.equal(milk.expirationCategory, 'EXPIRED');
  assert.equal(milk.expirationLabel, 'Списание');
  const yoghurt = r.json.find((p) => p.barcode === '4601234567897');
  assert.equal(yoghurt.expirationCategory, 'ON_SALE');

  // Поиск.
  r = await call('GET', '/api/products?q=Молоко');
  assert.equal(r.json.length, 1);

  // PUT меняет ТОЛЬКО срок годности; название при этом не трогаем.
  const id = r.json[0].id;
  const newExp = Date.now() + 30 * 86400000;
  r = await call('PUT', `/api/products/${id}`, { hasExpirationDate: true, expirationDate: newExp });
  assert.equal(r.json.name, 'Молоко');
  assert.equal(r.json.expirationDate, newExp);

  // PUT сохраняет название, категорию и количество.
  r = await call('PUT', `/api/products/${id}`, {
    name: 'Молоко 2.5%', category: 'Молочка', quantity: 2,
    hasExpirationDate: true, expirationDate: newExp,
  });
  assert.equal(r.json.name, 'Молоко 2.5%');
  assert.equal(r.json.category, 'Молочка');

  // Статусы через PATCH — на главной (ближайшей по сроку) партии.
  r = await call('PATCH', `/api/products/${id}/status`, { isMarkedDown: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.isMarkedDown, true);
  r = await call('PATCH', `/api/products/${id}/status`, { isMarkedDown: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.isMarkedDown, false);

  // Удаление запрещено везде.
  r = await call('DELETE', `/api/products/${id}`);
  assert.equal(r.status, 403);
  r = await call('GET', '/api/products');
  assert.equal(r.json.length, 2);
});

await test('PUT manufacturingDate -> expirationDate из срока хранения (Android parity)', async () => {
  const mfg = Date.UTC(2024, 0, 15);
  let r = await call('POST', '/api/import', {
    products: [
      {
        barcode: '4600000000017',
        name: 'Срок хранения',
        quantity: 1,
        hasExpirationDate: true,
        expirationDate: Date.UTC(2024, 0, 24),
        manufacturingDate: mfg,
        hasShelfLife: true,
        shelfLifeValue: 10,
        shelfLifeUnit: 'days',
        updatedAt: Date.now(),
      },
    ],
  });
  assert.equal(r.status, 200);

  r = await call('GET', '/api/products?q=Срок хранения');
  const id = r.json[0].id;

  // Меняем дату производства на 01.02.2024; срок 10 дней => +10 дней => 11.02.2024
  // (день производства больше не вычитается).
  const newMfg = Date.UTC(2024, 1, 1);
  r = await call('PUT', `/api/products/${id}`, { manufacturingDate: newMfg });
  assert.equal(r.status, 200);
  assert.equal(r.json.manufacturingDate, newMfg);
  assert.equal(r.json.expirationDate, Date.UTC(2024, 1, 11, 23, 59, 59, 999));
  assert.equal(r.json.hasExpirationDate, true);
  // Срок хранения mini-app не меняет — значение осталось из Android.
  assert.equal(r.json.shelfLifeValue, 10);
  assert.equal(r.json.shelfLifeUnit, 'days');
});

await test('PUT: дата истечения напрямую (EXACT_DATE) и запрет производства без срока хранения', async () => {
  // Товар со сроком хранения: дату истечения можно задать напрямую.
  let r = await call('GET', '/api/products?q=Срок хранения');
  const shelfId = r.json[0].id;
  const exact = Date.UTC(2024, 5, 1, 23, 59, 59, 999);
  r = await call('PUT', `/api/products/${shelfId}`, { hasExpirationDate: true, expirationDate: exact });
  assert.equal(r.status, 200);
  assert.equal(r.json.expirationDate, exact);
  assert.equal(r.json.hasExpirationDate, true);
  // Дату производства напрямую не трогали.
  assert.equal(r.json.manufacturingDate, Date.UTC(2024, 1, 1));

  // Товар без срока хранения: manufacturingDate запрещён, дата истечения — можно.
  r = await call('GET', '/api/products?q=Молоко');
  const milkId = r.json[0].id;
  r = await call('PUT', `/api/products/${milkId}`, { manufacturingDate: Date.UTC(2024, 0, 1) });
  assert.equal(r.status, 400);

  const milkExp = Date.UTC(2024, 4, 5, 23, 59, 59, 999);
  r = await call('PUT', `/api/products/${milkId}`, { hasExpirationDate: true, expirationDate: milkExp });
  assert.equal(r.status, 200);
  assert.equal(r.json.expirationDate, milkExp);

  // PUT без дат (только название) не должен обнулять срок.
  r = await call('PUT', `/api/products/${milkId}`, { name: 'Молоко 3.2%' });
  assert.equal(r.status, 200);
  assert.equal(r.json.expirationDate, milkExp);
  assert.equal(r.json.hasExpirationDate, true);

  // manufacturingDate: null у товара со сроком — срок очищается.
  r = await call('PUT', `/api/products/${shelfId}`, { manufacturingDate: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.expirationDate, null);
  assert.equal(r.json.hasExpirationDate, false);
});

await test('import: авто-категории пересчитываются, ручные сохраняются', async () => {
  let r = await call('POST', '/api/import', {
    products: [
      {
        barcode: '4600000000101',
        name: "Чипсы картофельные Lay's сыр 70 гр",
        category: 'Сыр', // старая/ошибочная авто-категория
        quantity: 1,
        hasExpirationDate: false,
        updatedAt: Date.now(),
      },
      {
        barcode: '4600000000102',
        name: 'Мой ручной товар',
        category: 'Личная категория', // ручная категория — не трогаем
        quantity: 1,
        hasExpirationDate: false,
        updatedAt: Date.now(),
      },
    ],
  });
  assert.equal(r.status, 200);

  r = await call('GET', '/api/products?q=' + encodeURIComponent('Чипсы картофельные'));
  assert.equal(r.json[0].category, 'Чипсы');

  r = await call('GET', '/api/products?q=' + encodeURIComponent('Мой ручной'));
  assert.equal(r.json[0].category, 'Личная категория');
});

await test('GS1 validation', async () => {
  // Валидный EAN-13 Беларуси.
  let r = await call('GET', '/api/lookup/4810268038006');
  assert.equal(r.json.validLength, true);
  assert.equal(r.json.validChecksum, true);
  assert.equal(r.json.country, 'Беларусь');

  // Невалидная контрольная сумма.
  r = await call('GET', '/api/lookup/4810268038007');
  assert.equal(r.json.validChecksum, false);
});

await test('settings + dictionaries', async () => {
  let r = await call('POST', '/api/settings/warning-days', { days: 10 });
  assert.equal(r.json.warningDays, 10);

  r = await call('POST', '/api/categories', { name: 'Напитки' });
  assert.ok(r.json.some((c) => c.name === 'Напитки'));

  r = await call('POST', '/api/manufacturers', {
    prefix: '481',
    name: 'Белпродукт',
    defaultCategory: 'Молочка',
  });
  assert.ok(r.json.some((m) => m.prefix === '481'));
});

await test('export/import round-trip', async () => {
  // Экспорт текущего состояния.
  let r = await call('GET', '/api/export');
  assert.equal(r.status, 200);
  const exported = JSON.parse(r.text);
  assert.ok(Array.isArray(exported.products));

  // Импорт того же набора — не должен падать.
  r = await call('POST', '/api/import', { products: exported.products });
  assert.equal(r.json.ok, true);
  assert.ok(r.json.importedCount >= 0);
});

console.log('✅ Все backend-тесты выполнены');
