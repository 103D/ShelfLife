import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { daysRemaining, isExpired, type Product } from '../domain/product.js';
import * as products from '../data/productRepository.js';
import * as settingsRepo from '../data/settingsRepository.js';
import * as syncTokens from '../data/syncTokenRepository.js';

/** Secondary dialogs (date/status). */
type PendingAction =
  | { action: 'setDate'; productId: number; productName: string }
  | { action: 'statusMenu'; productId: number; productName: string }
  | { action: 'listSearch'; query: string };
const pending = new Map<number, PendingAction>();

/** Card-stack state. */
type CardSession = { ordered: Product[]; index: number; lastMsgId?: number };
const cardSessions = new Map<number, CardSession>();

type ListSort = 'dateAsc' | 'dateDesc' | 'category' | 'name';
type ListSession = { offset: number; sort: ListSort };
const listSessions = new Map<number, ListSession>();

function orderedFor(userId: number): Product[] {
  const s = cardSessions.get(userId);
  if (s) return s.ordered;
  const settings = settingsRepo.getSettings(userId);
  const rep = products.getProductsByPriority(userId, settings.warningDays);
  return [...rep.expired, ...rep.onSale, ...rep.missing, ...rep.other];
}

/** Tinder-style card: title, date, category, status. Takes `userId` so it reuses session state. */
function cardText(userId: number, index: number): string {
  const ordered = orderedFor(userId);
  const total = ordered.length;
  if (index < 0 || index >= total) return '';
  const p = ordered[index];
  const cat = p.category ? `<b>[${p.category}]</b>` : '<i>без категории</i>';
  const days = daysRemaining(p);
  const dayStr = days == null ? '<i>без срока</i>' : `${days} дн.`;
  let status = '✅ свежий';
  if (p.isMissing) status = '⚪ отсутствует';
  else if (p.isMarkedDown) status = '🏷 уценен';
  else if (isExpired(p)) status = '🔴 списание';
  return [
    `📦 <b>Товар №${index + 1} из ${total}</b>`,
    `<b>${p.name}</b> ${cat}`,
    `📅 ${dayStr}`,
    `📂 ${status}`,
  ].join('\n');
}

function cardKeyboard(userId: number, index: number): InlineKeyboard {
  const ordered = orderedFor(userId);
  const total = ordered.length;
  if (index < 0 || index >= total) return new InlineKeyboard();
  return new InlineKeyboard()
    .text('← Уценить', `swipe:left:${index}`)
    .text('→ Отсутствует', `swipe:right:${index}`)
    .row()
    .text('⬅ Предыдущая', `prev:${index}`)
    .text('➡ Следующая', `next:${index}`)
    .row()
    .text('📅 Дата', `date:${index}`)
    .text('⚙ К списку', `list:${index}`);
}

async function sendCard(ctx: any, userId: number, index: number): Promise<void> {
  const ordered = orderedFor(userId);
  if (index < 0 || index >= ordered.length) {
    cardSessions.delete(userId);
    return;
  }
  const session = cardSessions.get(userId)!;
  session.index = index;
  const msg = cardText(userId, index);
  if (!msg) return;
  const markup = cardKeyboard(userId, index);
  const sent = await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: markup });
  session.lastMsgId = sent.message_id;
}

function showList(ctx: any, userId: number, ordered: Product[], offset: number, sort: ListSort): void {
  const page = 20;
  const pageItems = ordered.slice(offset, offset + page);
  const total = ordered.length;
  const lines = pageItems.map((p, i) => {
    const cat = p.category ? ` [${p.category}]` : '';
    const days = daysRemaining(p);
    const dayStr = days == null ? 'без срока' : `${days} дн.`;
    let status = '✅ свежий';
    if (p.isMissing) status = '⚪ отсутствует';
    else if (p.isMarkedDown) status = '🏷 уценен';
    else if (isExpired(p)) status = '🔴 списание';
    return `${offset + i + 1}. ${status} ${p.name}${cat} — ${dayStr}`;
  });
  const text = [
    '📋 <b>Список ShelfLife</b>',
    `Сортировка: <b>${sort}</b> · показано ${pageItems.length} из ${total}`,
    ...lines,
  ].join('\n');

  const kb = new InlineKeyboard();
  kb.text('🔍 Ввод', `listSearch:${userId}`).row();
  kb.text('📅 Дата (новые)', `listSort:dateAsc`).text('📅 Дата (старые)', `listSort:dateDesc`).row();
  kb.text('🏷 Категория', `listSort:category`).text('📛 Название', `listSort:name`).row();
  if (offset > 0) kb.text('⬅ Начало', `listNav:0:${sort}`).row();
  if (offset + page < total) kb.text('➡ Вперёд', `listNav:${offset + page}:${sort}`).row();
  kb.text('🔙 Назад', `listBack:${userId}`).row();

  ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

function setListSort(ctx: any, userId: number, sort: ListSort): void {
  const session = listSessions.get(userId) || { offset: 0, sort };
  session.sort = sort;
  listSessions.set(userId, session);
  showList(ctx, userId, orderedFor(userId), session.offset, sort);
}

function openListSearch(ctx: any, userId: number): void {
  pending.set(userId, { action: 'listSearch', query: '' });
  ctx.reply('🔍 Введите текст для поиска по названию, категории или штрихкоду (снизу).', { parse_mode: 'HTML' });
}

async function handleListCallback(ctx: any, cb: string, match: RegExpMatchArray | null): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  switch (cb) {
    case 'listSearch':
      openListSearch(ctx, userId);
      return;
    case 'listSort': {
      const s = match?.[1];
      if (s === 'dateAsc' || s === 'dateDesc' || s === 'category' || s === 'name') {
        setListSort(ctx, userId, s as ListSort);
      }
      return;
    }
    case 'listNav': {
      const newOffset = Number(match?.[1]);
      const sort = match?.[2];
      if (sort && listSessions.has(userId)) {
        const session = listSessions.get(userId)!;
        session.offset = newOffset;
        listSessions.set(userId, session);
        showList(ctx, userId, orderedFor(userId), newOffset, session.sort);
      }
      return;
    }
    case 'listBack': {
      listSessions.delete(userId);
      const ordered = orderedFor(userId);
      if (ordered.length) {
        cardSessions.set(userId, { ordered, index: 0, lastMsgId: undefined });
        await sendCard(ctx, userId, 0);
      }
      return;
    }
    default:
      return;
  }
}

function parseDateInput(text: string): { ms: number | null; hasDate: boolean } | null {
  const t = text.trim();
  const mRel = t.match(/^\+(\d+)\s*д(ней|ни|ень)?$/i);
  if (mRel) return { ms: Date.now() + Number(mRel[1]) * 24 * 60 * 60 * 1000, hasDate: true };
  const mAbs = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (mAbs) {
    const d = Number(mAbs[1]);
    const mo = Number(mAbs[2]);
    const y = Number(mAbs[3]);
    const ms = Date.UTC(y, mo - 1, d, 23, 59, 59);
    if (isNaN(ms) || d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    return { ms, hasDate: true };
  }
  if (t === '-' || t === 'нет' || t === 'clear') return { ms: null, hasDate: false };
  return null;
}

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  bot.command('start', async (ctx) => {
    const kb = new InlineKeyboard().webApp('📦 Открыть ShelfLife', config.webappUrl);
    await ctx.reply(
      '👋 <b>ShelfLife</b> — учёт сроков годности.\n\n' +
        'Откройте приложение, чтобы сканировать/добавлять товары и следить за сроками.',
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });

  bot.command('sync', async (ctx) => {
    const kb = new InlineKeyboard().webApp('📦 Открыть ShelfLife', config.webappUrl);
    await ctx.reply(
      '🔗 <b>Синхронизация с Android</b>\n\n' +
        'Текущий URL сервера:\n<code>' + config.webappUrl + '</code>\n\n' +
        'Откройте приложение по кнопке ниже, затем «Синхронизация» → «Создать ключ».\n' +
        'Если кнопка меню внизу ведёт на другой адрес — обновите Menu Button в @BotFather.',
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });


  bot.command('link', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const text = ctx.message?.text ?? '';
    const m = text.match(/^\/link(?:@\w+)?\s+(\S+)\s*$/i);
    const token = m ? m[1] : '';
    if (!token) {
      await ctx.reply(
        'ℹ️ <b>Привязка токена для синхронизации с Android</b>\n\n' +
          'В приложении ShelfLife нажмите «Синхронизация» → «Создать токен», скопируйте токен и пришлите его сюда командой:\n' +
          '<code>/link ваш_токен</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }
    const res = syncTokens.linkToken(userId, token, ctx.from?.first_name ?? '');
    if (!res.ok) {
      await ctx.reply('⚠️ <b>' + res.error + '</b>', { parse_mode: 'HTML' });
      return;
    }
    await ctx.reply(
      (res.alreadyLinked
        ? '✅ Токен уже был привязан к вашему аккаунту.'
        : '✅ Токен привязан к вашему Telegram-аккаунту!') +
        '\n\nТеперь в приложении можно синхронизировать товары.',
    );
  });

  bot.command('unlink', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const text = ctx.message?.text ?? '';
    const m = text.match(/^\/unlink(?:@\w+)?\s+(\S+)\s*$/i);
    const token = m ? m[1] : '';
    if (!token) {
      await ctx.reply('Использование: /unlink <токен>');
      return;
    }
    const res = syncTokens.unlinkToken(userId, token);
    if (!res.ok) {
      await ctx.reply('⚠️ ' + (res.error ?? 'Не удалось отвязать токен.'));
      return;
    }
    await ctx.reply('🗑️ Токен отвязан и больше не действует.');
  });

  bot.command('mytokens', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const rows = syncTokens.listFullTokens(userId);
    if (rows.length === 0) {
      await ctx.reply('У вас нет привязанных токенов. Создайте токен в приложении и пришлите через /link.');
      return;
    }
    const lines = rows.map((t, i) => `${i + 1}. <code>${t.token}</code>${t.name ? ' — ' + t.name : ''}`).join('\n');
    await ctx.reply('🔑 <b>Ваши токены (' + rows.length + ' из ' + syncTokens.MAX_TOKENS_PER_USER + '):</b>\n' + lines, { parse_mode: 'HTML' });
  });
  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Команды:\n' +
        '/start — открыть приложение\n' +
        '/report — карточки-стек по срокам (свайп влево/вправо)\n' +
        '/list — список со сортировкой и поиском\n' +
        '/link — привязать токен из приложения\n' +
        '/mytokens — показать мои токены\n' +
        '/unlink — отвязать токен\n' +
        '/help — эта справка',
    );
  });

  bot.command('report', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ordered = orderedFor(userId);
    const rep = products.getProductsByPriority(userId, settingsRepo.getSettings(userId).warningDays);
    const summary = [
      '📊 <b>Приоритет ShelfLife</b> — свайп: ← уценен, → отсутствует',
      `🔴 Просрочено: <b>${rep.expired.length}</b>`,
      `🟠 Уценка/скоро истекает: <b>${rep.onSale.length}</b>`,
      `⚪ Отсутствуют: <b>${rep.missing.length}</b>`,
    ].join('\n');
    const kb = new InlineKeyboard().webApp('🔥 Открыть карточки', config.webappUrl + '/report.html');
    await ctx.reply(summary, { parse_mode: 'HTML', reply_markup: kb });

    if (ordered.length === 0) {
      // Первые 3 приоритетные группы закончились: переходим в режим списка.
      listSessions.set(userId, { offset: 0, sort: 'dateDesc' });
      await showList(ctx, userId, orderedFor(userId), 0, 'dateDesc');
      return;
    }

    cardSessions.set(userId, { ordered, index: 0, lastMsgId: undefined });
    await sendCard(ctx, userId, 0);
  });
  bot.command('list', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const ordered = orderedFor(userId);
    if (ordered.length === 0) {
      await ctx.reply('Список товаров пуст.');
      return;
    }
    listSessions.set(userId, { offset: 0, sort: 'dateDesc' });
    showList(ctx, userId, ordered, 0, 'dateDesc');
  });

  bot.callbackQuery(/^swipe:left(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const index = Number(ctx.match[1]);
    const ordered = orderedFor(userId);
    if (index < 0 || index >= ordered.length) return;
    const p = ordered[index];
    products.toggleProductMarkedDown(userId, p.id);
    await ctx.answerCallbackQuery({ text: 'Уценён' });
    await sendCard(ctx, userId, index + 1);
  });

  bot.callbackQuery(/^swipe:right(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const index = Number(ctx.match[1]);
    const ordered = orderedFor(userId);
    if (index < 0 || index >= ordered.length) return;
    const p = ordered[index];
    products.toggleProductMissing(userId, p.id);
    await ctx.answerCallbackQuery({ text: 'Отсутствует' });
    await sendCard(ctx, userId, index + 1);
  });

  bot.callbackQuery(/^prev(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const index = Number(ctx.match[1]);
    const session = cardSessions.get(userId);
    if (!session) return;
    const next = index - 1;
    if (next < 0) return;
    session.index = next;
    const msg = cardText(userId, next);
    if (!msg) return;
    const markup = cardKeyboard(userId, next);
    const sent = await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: markup });
    session.lastMsgId = sent.message_id;
  });

  bot.callbackQuery(/^next(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const index = Number(ctx.match[1]);
    const session = cardSessions.get(userId);
    if (!session) return;
    const next = index + 1;
    if (next >= session.ordered.length) return;
    session.index = next;
    const msg = cardText(userId, next);
    if (!msg) return;
    const markup = cardKeyboard(userId, next);
    const sent = await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: markup });
    session.lastMsgId = sent.message_id;
  });

  bot.callbackQuery(/^date(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const index = Number(ctx.match[1]);
    const ordered = orderedFor(userId);
    if (index < 0 || index >= ordered.length) return;
    const p = ordered[index];
    pending.set(userId, { action: 'setDate', productId: p.id, productName: p.name });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Введите новую дату для <b>${p.name}</b>:\n` +
        '• ДД.ММ.ГГГГ (например 31.12.2026)\n' +
        '• +N дней (например +30)\n' +
        '• —  (убрать дату)',
      { parse_mode: 'HTML' },
    );
  });

  bot.callbackQuery(/^list(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const index = Number(ctx.match[1]);
    const ordered = orderedFor(userId);
    if (index < 0 || index >= ordered.length) return;
    listSessions.set(userId, { offset: index, sort: 'dateDesc' });
    showList(ctx, userId, ordered, index, 'dateDesc');
  });

  bot.callbackQuery(/^listSort:(dateAsc|dateDesc|category|name)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const sort = ctx.match[1] as ListSort;
    setListSort(ctx, userId, sort);
  });

  bot.callbackQuery(/^listSearch:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    openListSearch(ctx, userId);
  });

  bot.callbackQuery(/^listNav:(\d+):(.+)$/, async (ctx) => {
    await handleListCallback(ctx, 'listNav', ctx.match as RegExpMatchArray | null);
  });

  bot.callbackQuery(/^listBack:(\d+)$/, async (ctx) => {
    await handleListCallback(ctx, 'listBack', ctx.match as RegExpMatchArray | null);
  });

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const action = pending.get(userId);
    if (!action) return;
    const text = ctx.message.text.trim();

    if (action.action === 'setDate') {
      const parsed = parseDateInput(text);
      if (!parsed) {
        await ctx.reply('Не понял дату. Пришлите ДД.ММ.ГГГГ, +N дней или "—" чтобы убрать дату.');
        return;
      }
      products.updateProductExpirationDate(userId, action.productId, parsed.ms, parsed.hasDate);
      pending.delete(userId);
      await ctx.reply(`Дата для <b>${action.productName}</b> обновлена.`, { parse_mode: 'HTML' });
      return;
    }

    if (action.action === 'statusMenu') {
      const t = text.toLowerCase().trim();
      if (t === 'уценен') {
        const now = products.toggleProductMarkedDown(userId, action.productId);
        pending.delete(userId);
        await ctx.reply(`Отметка «уценен» для <b>${action.productName}</b>: ${now ? 'включена' : 'снята'}.`, { parse_mode: 'HTML' });
        return;
      }
      if (t === 'отсутствует') {
        const now = products.toggleProductMissing(userId, action.productId);
        pending.delete(userId);
        await ctx.reply(`Отметка «отсутствует» для <b>${action.productName}</b>: ${now ? 'включена' : 'снята'}.`, { parse_mode: 'HTML' });
        return;
      }
      await ctx.reply('Напишите "уценен" или "отсутствует".');
      return;
    }

    if (action.action === 'listSearch') {
      const q = action.query === '' ? text.toLowerCase() : action.query + ' ' + text.toLowerCase();
      const ordered = orderedFor(userId);
      const filtered = ordered.filter(p =>
        (p.name ?? '').toLowerCase().includes(q) ||
        (p.category ?? '').toLowerCase().includes(q) ||
        (p.barcode ?? '').includes(q)
      );
      pending.delete(userId);
      if (filtered.length === 0) {
        await ctx.reply('Ничего не найдено.');
        return;
      }
      listSessions.set(userId, { offset: 0, sort: 'dateDesc' });
      showList(ctx, userId, filtered, 0, 'dateDesc');
    }
  });

  bot.catch((err) => {
    console.error('Bot error:', err.error);
  });

  return bot;
}
