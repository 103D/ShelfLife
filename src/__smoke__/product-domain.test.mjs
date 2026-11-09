// Characterization-тест доменной логики сроков (src/domain/product.ts).
// Проверяет паритет с Android `domain/model/Product.kt` для daysRemaining /
// expirationCategory и computeExpirationDate.
// Запуск: npx tsx src/__smoke__/product-domain.test.mjs
// Фиксируем UTC, чтобы арифметика календарных дней/месяцев была детерминирована.
process.env.TZ = 'UTC';
const { test } = await import('node:test');
const assert = await import('node:assert/strict');

const {
  daysRemaining,
  isExpired,
  isExpiringSoonWithin,
  expirationCategory,
  computeExpirationDate,
  EXPIRATION_LABELS,
} = await import('../domain/product.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

// Фиксируем «сейчас», чтобы границы суток были детерминированы.
const realNow = Date.now;
function withNow(fn) {
  Date.now = () => NOW;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

const P = (expirationDate, hasExpirationDate = true) => ({ expirationDate, hasExpirationDate });

test('daysRemaining: совпадает с Kotlin Duration.toDays() (усечение к нулю)', () => {
  withNow(() => {
    assert.equal(daysRemaining(P(NOW)), 0); // истекает сегодня
    assert.equal(daysRemaining(P(NOW + DAY)), 1);
    assert.equal(daysRemaining(P(NOW + 7 * DAY)), 7);
    assert.equal(daysRemaining(P(NOW - DAY)), -1); // просрочен вчера
    assert.equal(daysRemaining(P(NOW + DAY - 1)), 0); // < суток — 0
    assert.equal(daysRemaining(P(null)), null);
    assert.equal(daysRemaining(P(NOW, false)), null); // без срока
  });
});

test('expirationCategory: EXPIRED / ON_SALE / OTHER при warningDays=7', () => {
  withNow(() => {
    assert.equal(expirationCategory(P(NOW), 7), 'EXPIRED');
    assert.equal(expirationCategory(P(NOW - 3 * DAY), 7), 'EXPIRED');
    assert.equal(expirationCategory(P(NOW + DAY), 7), 'ON_SALE'); // завтра
    assert.equal(expirationCategory(P(NOW + 7 * DAY), 7), 'ON_SALE');
    assert.equal(expirationCategory(P(NOW + 8 * DAY), 7), 'OTHER');
    assert.equal(expirationCategory(P(null), 7), 'OTHER'); // без срока
    assert.equal(EXPIRATION_LABELS.EXPIRED, 'Списание');
    assert.equal(EXPIRATION_LABELS.ON_SALE, 'Уценка');
  });
});

test('isExpired / isExpiringSoonWithin', () => {
  withNow(() => {
    assert.equal(isExpired(P(NOW)), true);
    assert.equal(isExpired(P(NOW + DAY)), false);
    assert.equal(isExpiringSoonWithin(P(NOW + DAY), 7), true);
    assert.equal(isExpiringSoonWithin(P(NOW), 7), false); // уже просрочен
    assert.equal(isExpiringSoonWithin(P(NOW + 8 * DAY), 7), false);
  });
});

// computeExpirationDate повторяет Android (`ProductDetailViewModel`):
//   Calendar.add(DAY_OF_YEAR | MONTH, value), месяцы календарные с клампингом,
//   затем HOUR=23, MINUTE=59, SECOND=59 — срок действует весь последний день.
// День производства больше не вычитается: 10 дней от 15.01 -> 25.01.
const EOD = (y, m, d) => Date.UTC(y, m, d, 23, 59, 59, 999);

test('computeExpirationDate: паритет с Android (value, 23:59:59, календарные месяцы)', () => {
  const mfg = Date.UTC(2024, 0, 15); // 15.01.2024
  // days: 10 дней -> +10 дней
  assert.equal(computeExpirationDate(mfg, 10, 'days'), EOD(2024, 0, 25));
  // 1 день -> истекает в конце следующего дня
  assert.equal(computeExpirationDate(mfg, 1, 'days'), EOD(2024, 0, 16));
  // months: 2 месяца -> +2 месяца
  assert.equal(computeExpirationDate(mfg, 2, 'months'), EOD(2024, 2, 15));
  // Клампинг дня: 31.01 + 2 месяца -> 31.03.2024
  assert.equal(computeExpirationDate(Date.UTC(2024, 0, 31), 2, 'months'), EOD(2024, 2, 31));
  assert.equal(computeExpirationDate(null, 10, 'days'), null);
  assert.equal(computeExpirationDate(mfg, 0, 'days'), null);
});

// Регрессия по реальному товару: Vitalnan, срок 20 дней, производство 08.10.2026.
// Срок действует по 28.10.2026 включительно (день производства не вычитается).
test('computeExpirationDate: 20 дней с 08.10.2026 -> 28.10.2026 23:59:59', () => {
  const mfg = Date.UTC(2026, 9, 8);
  const exp = computeExpirationDate(mfg, 20, 'days');
  assert.equal(exp, EOD(2026, 9, 28));
  assert.equal(new Date(exp).getUTCDate(), 28);
  assert.equal(new Date(exp).getUTCHours(), 23);
});
