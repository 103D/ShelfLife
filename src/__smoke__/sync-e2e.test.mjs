import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'shelflife-sync-e2e-'));
// Вся авторизация — как в проде: Mini App через initData (HMAC bot token),
// Android — через sync-токен X-Api-Token. DEV_AUTH выключен.
process.env.DEV_AUTH = '0';
process.env.BOT_TOKEN = '123:test';
process.env.DB_PATH = join(dir, 'test.db');

const BOT_TOKEN = '123:test';
const { createApp } = await import('../api/server.ts');

/** Валидный Telegram initData для пользователя (алгоритм verifyInitData). */
function makeInitData(user) {
  const p = new URLSearchParams();
  p.set('auth_date', String(Math.floor(Date.now() / 1000)));
  p.set('user', JSON.stringify(user));
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  p.set('hash', hash);
  return p.toString();
}

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const initData = makeInitData({ id: 777, first_name: 'E2E' });
  const I = { 'X-Telegram-Init-Data': initData };

  // 1) Mini App выпускает sync-токен через initData (как кнопка «Получить ключ»).
  let r = await fetch(`${base}/api/sync-token`, { headers: I });
  assert.equal(r.status, 200);
  const { token } = await r.json();
  assert.ok(token.startsWith('sl_'), 'token prefix');
  console.log('mini-app minted token:', token.slice(0, 8) + '...');

  const T = { 'Content-Type': 'application/json', 'X-Api-Token': token };

  // 2) PUSH с телефона (формат Android SyncService.postImport).
  const phone = [
    {
      barcode: '111', name: 'Молоко', quantity: 2,
      hasExpirationDate: true, hasShelfLife: false,
      expirationDate: Date.now() + 86400000, manufacturingDate: null,
      shelfLifeValue: 0, shelfLifeUnit: 'days',
      isMarkedDown: false, isMissing: false, category: 'Молочка',
      updatedAt: Date.now(),
    },
    {
      barcode: '222', name: 'Хлеб', quantity: 1,
      hasExpirationDate: false, hasShelfLife: false,
      expirationDate: null, manufacturingDate: null,
      shelfLifeValue: 0, shelfLifeUnit: 'days',
      isMarkedDown: false, isMissing: false, category: '',
      updatedAt: Date.now(),
    },
  ];
  r = await fetch(`${base}/api/import`, {
    method: 'POST', headers: T, body: JSON.stringify({ products: phone }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).importedCount, 2);
  console.log('push ok: 2 products');

  // 3) Бот видит те же данные (та же user_id-область): /api/products + /api/me.
  r = await fetch(`${base}/api/products`, { headers: { 'X-Api-Token': token } });
  assert.equal(r.status, 200);
  const list = await r.json();
  assert.equal(list.length, 2);
  assert.ok(list.some((p) => p.name === 'Молоко' && p.category === 'Молочка'));
  r = await fetch(`${base}/api/me`, { headers: { 'X-Api-Token': token } });
  assert.equal((await r.json()).count, 2);
  console.log('bot sees same data: products=2, me.count=2');

  // 4) PULL: GET /api/export — все 13 ключей, которые парсит Android jsonToProduct.
  r = await fetch(`${base}/api/export`, { headers: { 'X-Api-Token': token } });
  assert.equal(r.status, 200);
  const exp = await r.json();
  assert.equal(exp.products.length, 2);
  for (const k of ['barcode', 'name', 'quantity', 'hasExpirationDate', 'hasShelfLife',
    'expirationDate', 'manufacturingDate', 'shelfLifeValue', 'shelfLifeUnit',
    'isMarkedDown', 'isMissing', 'category', 'updatedAt']) {
    assert.ok(k in exp.products[0], `export has ${k}`);
  }
  console.log('pull ok: export has all 13 keys');

  // 5) Sync-токен НЕ управляет токенами (утечка не даёт самопродления).
  for (const [method, url] of [['GET', '/api/sync-token'], ['POST', '/api/sync-token'], ['DELETE', '/api/sync-token']]) {
    r = await fetch(`${base}${url}`, { method, headers: { 'X-Api-Token': token } });
    assert.equal(r.status, 403, `${method} ${url} must be 403`);
  }
  console.log('token cannot manage tokens: 403 x3 ok');

  // 6) Чужой токен отклоняется.
  r = await fetch(`${base}/api/products`, { headers: { 'X-Api-Token': 'sl_deadbeef' } });
  assert.equal(r.status, 401);
  console.log('bad token rejected: 401 ok');

  // 7) Несколько токенов: второй ключ (второе устройство) работает параллельно.
  r = await fetch(`${base}/api/sync-tokens`, { headers: I });
  assert.equal(r.status, 200);
  let tokList = await r.json();
  assert.equal(tokList.tokens.length, 1);
  assert.ok(!tokList.tokens[0].preview.includes(token.slice(6, 20)), 'preview is masked');
  r = await fetch(`${base}/api/sync-tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...I },
    body: JSON.stringify({ name: 'Pixel 8' }),
  });
  assert.equal(r.status, 201);
  const tokenB = (await r.json()).token;
  assert.ok(tokenB.startsWith('sl_') && tokenB !== token);
  r = await fetch(`${base}/api/products`, { headers: { 'X-Api-Token': tokenB } });
  assert.equal((await r.json()).length, 2);
  console.log('second device token works in parallel: ok');

  // 8) Отзыв одного токена не ломает второй.
  r = await fetch(`${base}/api/sync-tokens`, { headers: I });
  tokList = await r.json();
  const victim = tokList.tokens.find((t) => t.preview !== undefined && tokList.tokens.indexOf(t) === 0);
  assert.ok(victim, 'token list has ids');
  r = await fetch(`${base}/api/sync-tokens/${victim.id}`, { method: 'DELETE', headers: I });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/api/products`, { headers: { 'X-Api-Token': token } });
  assert.equal(r.status, 401, 'revoked token rejected');
  r = await fetch(`${base}/api/products`, { headers: { 'X-Api-Token': tokenB } });
  assert.equal((await r.json()).length, 2, 'second token still works');
  console.log('per-device revoke: ok');

  // 9) Лимит токенов (5) enforced.
  for (let i = 0; i < 4; i++) {
    r = await fetch(`${base}/api/sync-tokens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...I },
      body: JSON.stringify({ name: `dev${i}` }),
    });
    assert.equal(r.status, 201);
  }
  r = await fetch(`${base}/api/sync-tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...I },
    body: JSON.stringify({ name: 'overflow' }),
  });
  assert.equal(r.status, 409);
  console.log('token limit 5: ok');

  console.log('SYNC E2E: ALL OK');
} finally {
  server.close();
}

