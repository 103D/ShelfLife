# ShelfLife — Telegram Bot + Mini App

Веб-версия нативного Android-приложения **ShelfLife** (учёт сроков годности),
упакованная как **Telegram-бота с Mini App**. Работает на **iPhone, Android и Desktop**
внутри Telegram, потому что Mini App — это веб-приложение.

Доменная логика (расчёт сроков, валидация EAN/GS1, категоризация «Списание / Уценка»,
поиск по штрихкоду через Open Food Facts) перенесена 1:1 из Kotlin-кода в `src/`.

## Стек

- **Бот:** [grammY](https://grammy.dev) (long polling)
- **API + раздача Mini App:** Express + TypeScript
- **БД:** SQLite (`better-sqlite3`) — каждая таблица scoped по `user_id` из Telegram
- **Mini App:** чистый HTML/CSS/JS + официальный SDK `telegram-web-app.js`
- **Аутентификация:** проверка подписи Telegram `initData` (HMAC-SHA256)

## Структура

```
telegram-bot/
├── src/
│   ├── index.ts            # точка входа: Express + grammY
│   ├── config.ts           # env
│   ├── api/server.ts       # REST API + auth middleware
│   ├── api/static.ts       # раздача собранного Mini App
│   ├── telegram/initData.ts# проверка подписи Telegram (безопасность!)
│   ├── telegram/bot.ts     # команды /start /help /report
│   ├── data/               # SQLite: продукты, справочники, настройки, кэш ШК
│   └── domain/             # порт логики: product.ts, gs1.ts
└── public/                 # Mini App (index.html, app.js, styles.css)
```

## Быстрый старт (локально)

```bash
cd telegram-bot
npm install
npm rebuild better-sqlite3      # если нативный модуль не собрался
cp .env.example .env            # впишите BOT_TOKEN
# DEV_AUTH=1 — чтобы тестировать API без Telegram (из обычного браузера)
npm run dev
```

Сервер поднимется на `http://localhost:3000` (API + Mini App).

## Настройка бота (обязательно для iPhone)

1. Создайте бота у [@BotFather](https://t.me/BotFather), получите `BOT_TOKEN`.
2. Опубликуйте сервер на **HTTPS** (Telegram Mini Apps требуют https).
   Для локальной разработки используйте туннель:
   ```bash
   ngrok http 3000        # получите https://xxxx.ngrok-free.app
   ```
3. В `.env` укажите `WEBAPP_URL=https://xxxx.ngrok-free.app` (тот же https-адрес).
4. В @BotFather: **Bot Settings → Menu Button → Configure menu button** →
   укажите тот же https-URL. Либо бот сам открывает Mini App кнопкой `web_app`
   (команда `/start`).

> ⚠️ Без HTTPS и без валидного URL Mini App не откроется. `DEV_AUTH=1`
> в продакшене использовать нельзя — он отключает проверку подписи.

## Особенности для iPhone

- Камера внутри Telegram WebView на **iOS нестабильна**. Поэтому в Mini App
  основной сценарий — **ручной ввод штрихкода**. Сканер камеры (через
  `BarcodeDetector`) включается только там, где он доступен, иначе показывается
  подсказка ввести код вручную.
- Интерфейс использует темы Telegram (`--tg-theme-*`), safe-area и haptics.

## API (кратко)

| Метод | Путь | Назначение |
|------|------|-----------|
| GET | `/api/products?q=` | список / поиск |
| POST | `/api/products` | добавить товар |
| PUT | `/api/products/:id` | изменить |
| PATCH | `/api/products/:id/status` | «Уценка»/«Отсутствует» |
| DELETE | `/api/products/:id` | удалить |
| GET | `/api/lookup/:barcode` | поиск по Open Food Facts + валидация EAN |
| GET/POST | `/api/categories`, `/api/manufacturers` | справочники |
| GET/POST | `/api/settings` | «предупреждать за N дней», категория по умолчанию |
| GET/POST | `/api/export`, `/api/import` | экспорт/импорт JSON (совместим с Android) |

Аутентификация: заголовок `X-Telegram-Init-Data` (подписанные данные Telegram).

## Развёртывание

```bash
npm run build          # tsc -> dist/
npm run serve          # node dist/index.js (запускать с переменными из .env)
```

Базу SQLite (`DB_PATH`) разместите на диске с бэкапами. Для webhooks вместо
long polling используйте `bot.api.setWebhook(...)`.
