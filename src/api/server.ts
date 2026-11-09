import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { verifyInitData, type TelegramUser } from '../telegram/initData.js';
import * as products from '../data/productRepository.js';
import * as dict from '../data/dictionaryRepository.js';
import * as settingsRepo from '../data/settingsRepository.js';
import * as barcode from '../data/barcodeService.js';
import * as syncTokens from '../data/syncTokenRepository.js';
import {
  expirationCategory,
  daysRemaining,
  computeExpirationDate,
  EXPIRATION_LABELS,
  type Product,
  type ProductExpiration,
  type NewProduct,
  type ImportProduct,
} from '../domain/product.js';
import { isValidChecksum, isValidLength, countryName } from '../domain/gs1.js';
import { classifyCategory, AUTO_CATEGORIES } from '../data/categoryClassifier.js';

/**
 * Категории, которые приходят от старых версий Android/импорта и должны быть
 * пересчитаны классификатором. Пользовательские категории (не из этого
 * списка) сохраняем как есть.
 */
const LEGACY_AUTO_CATEGORIES = new Set([
  '',
  'другое',
  'питьевой йогурт',
  'колбасы',
  'кириешки',
  'сырок',
  'exponent',
  'exponenta',
  'amiran',
  'амиран',
]);
const AUTO_CATEGORY_SET = new Set(AUTO_CATEGORIES.map((c) => c.toLowerCase()));

function isAutoCategory(category: string): boolean {
  const c = category.trim().toLowerCase();
  return LEGACY_AUTO_CATEGORIES.has(c) || AUTO_CATEGORY_SET.has(c);
}


declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tgUser?: TelegramUser;
      userId?: number;
      /** How the caller authenticated: Telegram initData (Mini App), a sync
       *  token (native Android), or dev mode. Sync tokens may NOT mint more
       *  tokens — only initData/dev can. */
      authVia?: 'initData' | 'token' | 'dev';
    }
  }
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // ---- Auth middleware ----
  // Three ways in:
  //   1. DEV_AUTH=1        -> fixed dev user (dev only).
  //   2. Telegram initData -> Mini App (HMAC signed by Telegram with bot token).
  //   3. X-Api-Token       -> native Android client (sync token minted in the
  //                           Mini App); scoped to that token's user only.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (config.devAuth) {
      req.userId = config.devUserId;
      req.tgUser = { id: config.devUserId, first_name: 'Dev' };
      req.authVia = 'dev';
      return next();
    }

    // 1) Telegram initData (Mini App).
    const initData =
      (req.header('X-Telegram-Init-Data') ??
        (req.header('Authorization') ?? '').replace(/^tma\s+/i, '')) || '';
    if (initData) {
      const parsed = verifyInitData(initData);
      if (parsed && parsed.user) {
        req.tgUser = parsed.user;
        req.userId = parsed.user.id;
        req.authVia = 'initData';
        console.log('[auth] initData OK user_id=', parsed.user.id, req.method, req.path);
        return next();
      }
      console.log('[auth] initData INVALID/EXPIRED for', req.method, req.path);
    }

    // 2) Sync token (native Android client).
    const syncToken = req.header('X-Api-Token') ?? '';
    if (syncToken) {
      const tokenId = syncTokens.findUserIdByToken(syncToken);
      if (tokenId != null) {
        req.userId = tokenId;
        req.tgUser = { id: tokenId };
        req.authVia = 'token';
        console.log('[auth] token OK user_id=', tokenId, req.method, req.path);
        return next();
      }
      console.log('[auth] token NOT FOUND', syncToken.slice(0, 8) + '…', req.method, req.path);
    } else if (!initData) {
      console.log('[auth] no initData/token for', req.method, req.path);
    }

    return res.status(401).json({ error: 'Unauthorized: invalid initData or token' });
  });

  const uid = (req: Request): number => req.userId as number;

  function decorate(p: Product, warningDays: number) {
    const cat: ProductExpiration = expirationCategory(p, warningDays);
    return {
      ...p,
      daysRemaining: daysRemaining(p),
      expirationCategory: cat,
      expirationLabel: EXPIRATION_LABELS[cat],
    };
  }

  function validateProduct(body: any): NewProduct | string {
    const barcodeVal = String(body?.barcode ?? '').trim();
    if (!barcodeVal) return 'barcode is required';
    const nameVal = String(body?.name ?? '').trim();
    if (!nameVal) return 'name is required';
    const quantity = Math.max(1, Math.floor(Number(body?.quantity ?? 1)) || 1);
    // Авто-категории (пустая, «Другое», старые/брендовые) пересчитываем по
    // названию: иначе Android при sync возвращает прежние ошибочные значения.
    const incomingCategory = String(body?.category ?? '').trim();
    const categoryVal = isAutoCategory(incomingCategory)
      ? classifyCategory(nameVal)
      : incomingCategory;
    return {
      barcode: barcodeVal,
      name: nameVal,
      quantity,
      hasExpirationDate: !!body.hasExpirationDate,
      hasShelfLife: !!body.hasShelfLife,
      expirationDate: body.expirationDate == null ? null : Number(body.expirationDate) || null,
      manufacturingDate:
        body.manufacturingDate == null ? null : Number(body.manufacturingDate) || null,
      shelfLifeValue: Math.max(0, Math.floor(Number(body?.shelfLifeValue ?? 0)) || 0),
      shelfLifeUnit: body.shelfLifeUnit === 'months' ? 'months' : 'days',
      isMarkedDown: !!body.isMarkedDown,
      isMissing: !!body.isMissing,
      category: categoryVal,
      batches: Array.isArray(body?.batches)
        ? body.batches.map((b: any) => ({
            id: Number(b.id) || 0,
            expirationDate: b.expirationDate == null ? null : Number(b.expirationDate) || null,
            manufacturingDate: b.manufacturingDate == null ? null : Number(b.manufacturingDate) || null,
            shelfLifeValue: Math.max(0, Math.floor(Number(b?.shelfLifeValue ?? 0)) || 0),
            shelfLifeUnit: b.shelfLifeUnit === 'months' ? 'months' : 'days',
            quantity: Math.max(1, Math.floor(Number(b?.quantity ?? 1)) || 1),
            isMarkedDown: !!b.isMarkedDown,
            isMissing: !!b.isMissing,
            createdAt: Number(b?.createdAt) || 0,
            updatedAt: Number(b?.updatedAt) || 0,
          }))
        : undefined,
    };
  }

  // ---- Settings ----
  app.get('/api/settings', (req, res) => {
    res.json(settingsRepo.getSettings(uid(req)));
  });
  app.post('/api/settings/warning-days', (req, res) => {
    const days = Number(req.body?.days);
    const updatedAt = req.body?.updatedAt != null ? Number(req.body.updatedAt) || 0 : undefined;
    res.json(settingsRepo.setWarningDays(uid(req), days, updatedAt));
  });
  app.post('/api/settings', (req, res) => {
    const b = req.body || {};
    // Имена полей приходят в двух вариантах: mini-app исторически шлёт
    // `dir`/`status`, Android и новый клиент — `sortDir`/`statusFilter`.
    // Принимаем оба, иначе выбор в настройках молча игнорировался.
    res.json(
      settingsRepo.setSettings(uid(req), {
        warningDays: b.warningDays,
        sort: b.sort,
        sortDir: b.sortDir ?? b.dir,
        statusFilter: b.statusFilter ?? b.status,
        updatedAt: b.updatedAt,
      }),
    );
  });
  app.post('/api/settings/default-category', (req, res) => {
    const category = String(req.body?.category ?? '');
    const updatedAt = req.body?.updatedAt != null ? Number(req.body.updatedAt) || 0 : undefined;
    res.json(settingsRepo.setDefaultCategory(uid(req), category, updatedAt));
  });

  // ---- Products ----
  app.get('/api/products', (req, res) => {
    const s = settingsRepo.getSettings(uid(req));
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const list = q ? products.searchProducts(uid(req), q) : products.getAllProducts(uid(req));
    res.json(list.map((p) => decorate(p, s.warningDays)));
  });

  app.get('/api/products/count', (req, res) => {
    res.json({ count: products.getProductCount(uid(req)) });
  });

  app.get('/api/products/suggestions', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return res.json([]);
    res.json(products.searchNameSuggestions(uid(req), q));
  });

  app.get('/api/products/by-barcode/:barcode', (req, res) => {
    const s = settingsRepo.getSettings(uid(req));
    const p = products.getProductByBarcode(uid(req), req.params.barcode);
    res.json(p ? decorate(p, s.warningDays) : null);
  });

  // ---- Delta sync (объявлено ДО /api/products/:id, иначе :id перехватит 'delta') ----
  app.get('/api/products/delta', (req, res) => {
    const since = Number(req.query.since) || 0;
    res.json({ products: products.getAllProductsForExport(uid(req), since || undefined) });
  });

  /** Пакетное применение вставок/обновлений (delta push). */
  app.post('/api/products/upsert', (req, res) => {
    const arr = Array.isArray(req.body?.products) ? req.body.products : null;
    if (!arr) return res.status(400).json({ error: 'body must contain a products[] array' });
    res.json({ ok: true, upsertedCount: products.upsertProducts(uid(req), arr) });
  });

  app.get('/api/products/:id', (req, res) => {
    const s = settingsRepo.getSettings(uid(req));
    const p = products.getProductById(uid(req), Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(decorate(p, s.warningDays));
  });

  // Создание одиночных товаров отключено: добавление — только из Android
  // (массовый POST /api/import — это и есть sync). Mini App: просмотр,
  // редактирование, удаление.
  app.post('/api/products', (_req, res) => {
    return res.status(403).json({ error: 'Adding products is available in the Android app only' });
  });

  // Mini App может менять ТОЛЬКО срок годности (hasExpirationDate + expirationDate).
  // Всё остальное (название, количество, статусы) — из Android-приложения.
  app.put('/api/products/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = products.getProductById(uid(req), id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const body = req.body ?? {};
    const next: NewProduct = {
      ...existing,
      name: body.name != null && String(body.name).trim() ? String(body.name).trim() : existing.name,
      category: body.category !== undefined ? String(body.category) : existing.category,
      quantity:
        body.quantity != null ? Math.max(1, Math.floor(Number(body.quantity)) || 1) : existing.quantity,
    };

    // Даты меняет Mini App. Два режима, как в Android (ExpirationMode):
    //  - SHELF_LIFE: задаётся manufacturingDate, expirationDate вычисляется;
    //  - EXACT_DATE: задаётся expirationDate напрямую.
    // Клиент, который считает срок в локальной таймзоне, присылает обе даты —
    // тогда явная expirationDate имеет приоритет (сервер в UTC не знает TZ).
    const hasMfg = body.manufacturingDate !== undefined;
    const hasExp = body.expirationDate !== undefined;
    if (hasMfg) {
      const mfg = body.manufacturingDate == null ? null : Number(body.manufacturingDate) || null;
      if (!existing.hasShelfLife) {
        // Нет срока хранения — правится только дата истечения, а не производство.
        return res
          .status(400)
          .json({ error: 'manufacturingDate is not editable: product has no shelf life' });
      }
      next.manufacturingDate = mfg;
      if (mfg == null) {
        // Производство очистили — срок вычислить нельзя.
        next.hasExpirationDate = false;
        next.expirationDate = null;
      } else if (hasExp && body.expirationDate != null) {
        next.hasExpirationDate = body.hasExpirationDate !== false;
        next.expirationDate = Number(body.expirationDate) || null;
      } else {
        const computed = computeExpirationDate(mfg, existing.shelfLifeValue, existing.shelfLifeUnit);
        next.hasExpirationDate = computed != null;
        next.expirationDate = computed;
      }
    } else if (hasExp) {
      const exp = body.expirationDate == null ? null : Number(body.expirationDate) || null;
      next.hasExpirationDate = !!body.hasExpirationDate && exp != null;
      next.expirationDate = next.hasExpirationDate ? exp : null;
    }
    // Если дат в запросе нет — оставляем существующие (PUT только названия и т.п.).
    if (next.hasExpirationDate && next.expirationDate == null) {
      return res.status(400).json({ error: 'expirationDate is required when hasExpirationDate is true' });
    }
    // Обновляем главную (ближайшую по сроку) партию: дату и количество.
    if (next.batches && next.batches.length) {
      next.batches[0] = {
        ...next.batches[0],
        manufacturingDate:
          body.manufacturingDate !== undefined ? next.manufacturingDate : next.batches[0].manufacturingDate,
        expirationDate: next.expirationDate,
        quantity: next.quantity,
      };
    }
    products.updateProduct(uid(req), id, next);
    const s = settingsRepo.getSettings(uid(req));
    res.json(decorate(products.getProductById(uid(req), id)!, s.warningDays));
  });



  // ---- Batches (несколько дат/партий у товара) ----
  app.post('/api/products/:id/batches', (req, res) => {
    const userId = uid(req);
    const id = Number(req.params.id);
    if (!products.getProductById(userId, id)) return res.status(404).json({ error: 'Not found' });
    const body = req.body ?? {};
    const batchId = products.addBatch(userId, id, {
      expirationDate: body.expirationDate == null ? null : Number(body.expirationDate) || null,
      manufacturingDate: body.manufacturingDate == null ? null : Number(body.manufacturingDate) || null,
      shelfLifeValue: Math.max(0, Math.floor(Number(body?.shelfLifeValue ?? 0)) || 0),
      shelfLifeUnit: body.shelfLifeUnit === 'months' ? 'months' : 'days',
      quantity: Math.max(1, Math.floor(Number(body?.quantity ?? 1)) || 1),
      isMarkedDown: !!body.isMarkedDown,
      isMissing: !!body.isMissing,
    });
    res.status(201).json({ ok: true, batchId });
  });

  app.delete('/api/products/:id/batches/:batchId', (req, res) => {
    const userId = uid(req);
    const id = Number(req.params.id);
    const product = products.getProductById(userId, id);
    if (!product) return res.status(404).json({ error: 'Not found' });
    if (product.batches.length <= 1) {
      return res.status(400).json({ error: 'Нельзя удалить последнюю партию' });
    }
    const ok = products.deleteBatch(userId, id, Number(req.params.batchId));
    if (!ok) return res.status(404).json({ error: 'Batch not found' });
    res.json({ ok: true });
  });

  app.patch('/api/products/:id/batches/:batchId', (req, res) => {
    const body = req.body ?? {};
    const ok = products.updateBatch(uid(req), Number(req.params.id), Number(req.params.batchId), {
      expirationDate: body.expirationDate === undefined ? undefined : (body.expirationDate == null ? null : Number(body.expirationDate) || null),
      manufacturingDate: body.manufacturingDate === undefined ? undefined : (body.manufacturingDate == null ? null : Number(body.manufacturingDate) || null),
      shelfLifeValue: body.shelfLifeValue === undefined ? undefined : Math.max(0, Math.floor(Number(body.shelfLifeValue)) || 0),
      shelfLifeUnit: body.shelfLifeUnit === undefined ? undefined : (body.shelfLifeUnit === 'months' ? 'months' : 'days'),
      quantity: body.quantity === undefined ? undefined : Math.max(1, Math.floor(Number(body.quantity)) || 1),
      isMarkedDown: body.isMarkedDown === undefined ? undefined : !!body.isMarkedDown,
      isMissing: body.isMissing === undefined ? undefined : !!body.isMissing,
    });
    if (!ok) return res.status(404).json({ error: 'Batch not found' });
    res.json({ ok: true });
  });

  // Статусы (уценка/отсутствует) хранятся на партии и отображаются на товаре.
  // PATCH задаёт статус главной (ближайшей по сроку) партии явным значением.
  // Body: { isMarkedDown?: boolean, isMissing?: boolean }.
  app.patch('/api/products/:id/status', (req, res) => {
    const userId = uid(req);
    const id = Number(req.params.id);
    const product = products.getProductById(userId, id);
    if (!product) return res.status(404).json({ error: 'Not found' });
    const body = req.body ?? {};
    if (body.isMarkedDown !== undefined) {
      products.setProductMarkedDown(userId, id, !!body.isMarkedDown);
    }
    if (body.isMissing !== undefined) {
      products.setProductMissing(userId, id, !!body.isMissing);
    }
    const updated = products.getProductById(userId, id)!;
    const s = settingsRepo.getSettings(userId);
    res.json(decorate(updated, s.warningDays));
  });

  // Удаление запрещено везде: ни Mini App, ни Android не удаляют товары.
  // (Массовая очистка DELETE /api/products и импорт-замена остаются
  // техническими операциями настроек/синхронизации.)
  app.delete('/api/products/:id', (_req, res) => {
    return res.status(403).json({ error: 'Deleting products is disabled' });
  });

  app.delete('/api/products', (req, res) => {
    products.deleteAllProducts(uid(req));
    res.json({ ok: true });
  });

  // ---- Report (Tinder-style stack) ----
  // Возвращает только 3 приоритетные группы: expired -> onSale -> missing.
  // Веб-мини-приложение показывает стек карточек и физический свайп.
  app.get('/api/report/cards', (req, res) => {
    const userId = uid(req);
    const page = Math.max(0, Number(req.query.page) || 0);
    const sortParam = String(req.query.sort ?? 'date');
    const sort = sortParam === 'category' || sortParam === 'name' ? sortParam : 'date';
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
    const statusParam = String(req.query.status ?? 'all');
    const status = ['expired', 'onsale', 'marked', 'missing', 'fresh'].includes(statusParam) ? statusParam : 'all';
    const perPage = 20;
    const warningDays = settingsRepo.getSettings(userId).warningDays;
    const rep = products.getProductsByPriority(userId, warningDays);
    // Фильтр по статусу: all (по умолчанию), expired, onsale, missing, fresh.
    let all;
    if (status === 'expired') all = [...rep.expired];
    else if (status === 'onsale') all = [...rep.onSale];
    // «Уценён» — только подтверждённая (ручная) уценка.
    else if (status === 'marked') all = products.getAllProducts(userId).filter((p) => p.isMarkedDown);
    else if (status === 'missing') all = [...rep.missing];
    else if (status === 'fresh') all = [...rep.other];
    // 'all' = все товары, включая свежие. Раньше `other` (свежие) сюда не
    // попадал, поэтому стопка карточек была пустой у пользователей, у которых
    // нет ни списаний, ни уценки, ни отсутствующих.
    else all = [...rep.expired, ...rep.onSale, ...rep.missing, ...rep.other];
    // Сортировка карточек: по дате, категории или названию + направление.
    const nameCmp = (a: typeof all[number], b: typeof all[number]) =>
      (a.name ?? '').localeCompare(b.name ?? '', 'ru');
    all.sort((a, b) => {
      if (sort === 'date') {
        const an = a.expirationDate == null;
        const bn = b.expirationDate == null;
        // Товары без срока — всегда в конце.
        if (an || bn) return an && bn ? nameCmp(a, b) : (an ? 1 : -1);
        const cmp = (a.expirationDate as number) - (b.expirationDate as number);
        return dir === 'asc' ? cmp : -cmp;
      }
      if (sort === 'category') {
        const ac = (a.category ?? '').trim();
        const bc = (b.category ?? '').trim();
        // Без категории — в конец.
        if (!ac || !bc) {
          if (!ac && !bc) return nameCmp(a, b);
          return ac ? -1 : 1;
        }
        const cmp = ac.localeCompare(bc, 'ru') || nameCmp(a, b);
        return dir === 'asc' ? cmp : -cmp;
      }
      const cmp = nameCmp(a, b);
      return dir === 'asc' ? cmp : -cmp;
    });
    const total = all.length;
    const start = page * perPage;
    const items = all.slice(start, start + perPage);
    const nextPage = start + perPage < total;
    res.json({
      items: items.map((p) => decorate(p, warningDays)),
      total,
      page,
      sort,
      dir,
      status,
      hasMore: nextPage,
      groups: {
        expired: rep.expired.length,
        onSale: rep.onSale.length,
        missing: rep.missing.length,
        other: rep.other.length,
      },
    });
  });

  // Смена статуса (swipe): set или clear на главной партии.
  // left => уценен, right => отсутствует; unmarkeddown/unmissing — снять.
  app.post('/api/products/:id/action', (req, res) => {
    const userId = uid(req);
    const id = Number(req.params.id);
    if (!products.getProductById(userId, id)) return res.status(404).json({ error: 'Not found' });
    const body = req.body ?? {};
    const action = String(body.action ?? '').trim().toLowerCase();
    if (action === 'markeddown') {
      products.setProductMarkedDown(userId, id, true);
      res.json({ ok: true });
      return;
    }
    if (action === 'unmarkeddown' || action === 'clear-markeddown') {
      products.setProductMarkedDown(userId, id, false);
      res.json({ ok: true });
      return;
    }
    if (action === 'missing') {
      products.setProductMissing(userId, id, true);
      res.json({ ok: true });
      return;
    }
    if (action === 'unmissing' || action === 'clear-missing') {
      products.setProductMissing(userId, id, false);
      res.json({ ok: true });
      return;
    }
    res.status(400).json({ error: 'Unknown action: ' + action });
  });

  // ---- Barcode lookup ----
  app.get('/api/lookup/:barcode', async (req, res) => {
    const bc = req.params.barcode;
    const result = await barcode.lookupBarcode(uid(req), bc);
    res.json({
      barcode: bc,
      validLength: isValidLength(bc),
      validChecksum: isValidChecksum(bc),
      country: countryName(bc),
      result: result ? { ...result, category: classifyCategory(result.name ?? '') } : null,
    });
  });

  app.post('/api/lookup/manual', (req, res) => {
    const bc = String(req.body?.barcode ?? '').trim();
    const name = String(req.body?.name ?? '').trim();
    if (!bc || !name) return res.status(400).json({ error: 'barcode and name are required' });
    barcode.saveManualName(uid(req), bc, name);
    res.json({ ok: true });
  });

  // ---- Dictionaries ----
  app.get('/api/categories', (req, res) => {
    res.json(dict.getCategories(uid(req)));
  });
  app.post('/api/categories', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    dict.addCategory(uid(req), name);
    res.status(201).json(dict.getCategories(uid(req)));
  });
  app.delete('/api/categories', (req, res) => {
    dict.deleteCategory(uid(req), String(req.body?.name ?? ''));
    res.json(dict.getCategories(uid(req)));
  });

  app.get('/api/manufacturers', (req, res) => {
    res.json(dict.getManufacturers(uid(req)));
  });
  app.post('/api/manufacturers', (req, res) => {
    const prefix = String(req.body?.prefix ?? '').trim();
    const name = String(req.body?.name ?? '').trim();
    if (!prefix || !name) return res.status(400).json({ error: 'prefix and name are required' });
    dict.upsertManufacturer(uid(req), prefix, name, String(req.body?.defaultCategory ?? ''));
    res.status(201).json(dict.getManufacturers(uid(req)));
  });
  app.delete('/api/manufacturers/:id', (req, res) => {
    dict.deleteManufacturer(uid(req), Number(req.params.id));
    res.json(dict.getManufacturers(uid(req)));
  });

  // ---- Export / Import ----
  app.get('/api/export', (req, res) => {
    const startedAt = Date.now();
    const list = products.getAllProductsForExport(uid(req));
    const payload = {
      version: 1,
      exportDate: Date.now(),
      productCount: list.length,
      products: list.map((p) => ({
        barcode: p.barcode,
        name: p.name,
        quantity: p.quantity,
        hasExpirationDate: p.hasExpirationDate,
        hasShelfLife: p.hasShelfLife,
        expirationDate: p.expirationDate,
        manufacturingDate: p.manufacturingDate,
        shelfLifeValue: p.shelfLifeValue,
        shelfLifeUnit: p.shelfLifeUnit,
        isMarkedDown: p.isMarkedDown,
        isMissing: p.isMissing,
        category: p.category,
        updatedAt: p.updatedAt,
        batches: p.batches,
      })),
    };
    // Компактный JSON: без отступов тело меньше на 20–30%, что заметно на
    // мобильной сети при первом (полном) экспорте.
    const body = JSON.stringify(payload);
    console.log(
      `[export] user=${uid(req)} products=${list.length} bytes=${Buffer.byteLength(body)} ms=${Date.now() - startedAt}`,
    );
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="shelflife-export.json"');
    res.send(body);
  });

  app.post('/api/import', (req, res) => {
    const startedAt = Date.now();
    const arr = Array.isArray(req.body?.products) ? req.body.products : null;
    if (!arr) return res.status(400).json({ error: 'body must contain a products[] array' });
    const cleaned: ImportProduct[] = [];
    for (const raw of arr) {
      const parsed = validateProduct(raw);
      if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
      cleaned.push({ ...parsed, batches: parsed.batches, updatedAt: Number(raw?.updatedAt) || Date.now() });
    }
    const count = products.importProductsMerged(uid(req), cleaned);
    console.log(
      `[import] user=${uid(req)} products=${cleaned.length} imported=${count} ms=${Date.now() - startedAt}`,
    );
    res.json({ ok: true, importedCount: count });
  });

  // Batch settings endpoint - applies settings for a user
  app.post('/api/batch', (req, res) => {
    const { settings } = req.body;
    if (!settings) return res.status(400).json({ error: 'body must contain settings object' });
    const count = settingsRepo.setSettings(uid(req), settings);
    res.json({ ok: true, updatedCount: count });
  });
  // ---- Sync tokens (native Android clients, one per device) ----
  // Minting is restricted to initData/dev: a sync token itself must not be able
  // to mint more tokens (otherwise a leaked token could perpetuate itself).
  function requireNonTokenAuth(req: Request, res: Response): boolean {
    if (req.authVia === 'token') {
      res.status(403).json({ error: 'Forbidden: sync tokens cannot manage tokens' });
      return false;
    }
    return true;
  }

  // Returns the user's sync token, creating one on first use.
  // Kept for backwards compatibility (old Android builds, single-device flow).
  app.get('/api/sync-token', (req, res) => {
    if (!requireNonTokenAuth(req, res)) return;
    res.json({ token: syncTokens.getOrCreateToken(uid(req)) });
  });

  // List active tokens (masked previews + device names + ids for revocation).
  app.get('/api/sync-tokens', (req, res) => {
    if (!requireNonTokenAuth(req, res)) return;
    res.json({ tokens: syncTokens.listTokens(uid(req)), max: syncTokens.MAX_TOKENS_PER_USER });
  });

  // Mint a new named token (one per device). Body: { name?: string }.
  // Returns the FULL token once — the client must display/copy it immediately.
  app.post('/api/sync-tokens', (req, res) => {
    if (!requireNonTokenAuth(req, res)) return;
    try {
      const token = syncTokens.createToken(uid(req), String(req.body?.name ?? ''));
      console.log('[sync-token] minted user_id=', uid(req), 'name=', JSON.stringify(req.body?.name ?? ''));
      res.status(201).json({ token });
    } catch (e) {
      console.log('[sync-token] mint FAILED user_id=', uid(req), (e as Error).message);
      res.status(409).json({ error: (e as Error).message });
    }
  });

  // Rotate ALL tokens (invalidates old ones; Android must re-enter new).
  app.post('/api/sync-token', (req, res) => {
    if (!requireNonTokenAuth(req, res)) return;
    res.json({ token: syncTokens.regenerateToken(uid(req)) });
  });

  // Revoke ONE token by id (other devices keep working).
  app.delete('/api/sync-tokens/:id', (req, res) => {
    if (!requireNonTokenAuth(req, res)) return;
    const ok = syncTokens.revokeTokenById(uid(req), Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Token not found' });
    res.json({ ok: true });
  });

  // Revoke ALL tokens entirely.
  app.delete('/api/sync-token', (req, res) => {
    if (!requireNonTokenAuth(req, res)) return;
    syncTokens.revokeToken(uid(req));
    res.json({ ok: true });
  });

  // ---- Me / Health ----
  app.get('/api/me', (req, res) => {
    res.json({ user: req.tgUser, count: products.getProductCount(uid(req)) });
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  return app;
}

