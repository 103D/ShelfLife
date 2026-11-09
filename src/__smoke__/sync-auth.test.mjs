// Тест авторизации нативного клиента (sync token) при DEV_AUTH=0.
// initData подписывается HMAC с тем же алгоритмом, что verifyInitData на сервере.
// Запуск: npm test (включает этот файл) или npx tsx src/__smoke__/sync-auth.test.mjs
process.env.BOT_TOKEN = '123:test';
process.env.DEV_AUTH = '0';
process.env.DB_PATH = ':memory:';
process.env.WEBAPP_STATIC_DIR = './public';

import crypto from 'node:crypto';

const { test } = await import('node:test');
const assert = await import('node:assert/strict');

const { createApp } = await import('../api/server.ts');

const BOT_TOKEN = '123:test';
const app = createApp();

/** Строит валидный Telegram initData для пользователя (алгоритм verifyInitData). */
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

const USER = { id: 42, first_name: 'Test', username: 'tester' };
const INIT_DATA = makeInitData(USER);

/** fetch-обёртка с поддержкой произвольных заголовков. */
async function call(method, url, { body, headers = {} } = {}) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
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

const initDataHeaders = () => ({ 'X-Telegram-Init-Data': INIT_DATA });

test('initData auth works (Mini App path)', async () => {
  const r = await call('GET', '/api/me', { headers: initDataHeaders() });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.id, 42);
});

test('no credentials -> 401', async () => {
  const r = await call('GET', '/api/me');
  assert.equal(r.status, 401);
});

test('bogus initData -> 401', async () => {
  const r = await call('GET', '/api/me', { headers: { 'X-Telegram-Init-Data': 'user=x&hash=bad' } });
  assert.equal(r.status, 401);
});

test('mint sync token via initData', async () => {
  const r = await call('GET', '/api/sync-token', { headers: initDataHeaders() });
  assert.equal(r.status, 200);
  assert.ok(r.json.token.startsWith('sl_'), 'token should have sl_ prefix');
  // Повторный вызов возвращает тот же активный токен (без ротации).
  const r2 = await call('GET', '/api/sync-token', { headers: initDataHeaders() });
  assert.equal(r2.json.token, r.json.token);
});

test('token auth resolves to same user', async () => {
  const tok = (await call('GET', '/api/sync-token', { headers: initDataHeaders() })).json.token;
  const r = await call('GET', '/api/me', { headers: { 'X-Api-Token': tok } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.id, 42);
});

test('invalid token -> 401', async () => {
  const r = await call('GET', '/api/me', { headers: { 'X-Api-Token': 'sl_deadbeef' } });
  assert.equal(r.status, 401);
});

test('token cannot mint another token (403)', async () => {
  const tok = (await call('GET', '/api/sync-token', { headers: initDataHeaders() })).json.token;
  const r = await call('GET', '/api/sync-token', { headers: { 'X-Api-Token': tok } });
  assert.equal(r.status, 403);
});

test('import via token lands under token user', async () => {
  const tok = (await call('GET', '/api/sync-token', { headers: initDataHeaders() })).json.token;
  const products = [
    { barcode: '4006381333931', name: 'Немецкий тест', hasExpirationDate: true, expirationDate: Date.now() + 86400000 },
  ];
  const imp = await call('POST', '/api/import', { body: { products }, headers: { 'X-Api-Token': tok } });
  assert.equal(imp.status, 200);
  assert.equal(imp.json.importedCount, 1);

  // Тот же пользователь видит товар и по initData.
  const me = await call('GET', '/api/me', { headers: initDataHeaders() });
  assert.equal(me.json.count, 1);
});

test('rotate token invalidates the old one', async () => {
  const oldTok = (await call('GET', '/api/sync-token', { headers: initDataHeaders() })).json.token;
  const rot = await call('POST', '/api/sync-token', { headers: initDataHeaders() });
  assert.equal(rot.status, 200);
  assert.notEqual(rot.json.token, oldTok);
  // Старый токен больше не работает.
  const old = await call('GET', '/api/me', { headers: { 'X-Api-Token': oldTok } });
  assert.equal(old.status, 401);
  // Новый работает.
  const neu = await call('GET', '/api/me', { headers: { 'X-Api-Token': rot.json.token } });
  assert.equal(neu.status, 200);
});

console.log('✅ sync-auth тесты выполнены');
