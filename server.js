// require('dotenv').config({ quiet: true });
const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const REST_GID = process.env.REST_GID;

let auth;
try {
  const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
} catch (err) {
  console.error('Error parsing Google key:', err);
  process.exit(1);
}
const sheets = google.sheets({ version: 'v4', auth });


const OPS = {
  sale:     {op:'Продажа',    prompt:'Подтвердите продажу:',    saved:'Продажа сохранена',    cancelled:'Продажа отменена'    },
  income:   {op:'Приход',     prompt:'Подтвердите приход:',     saved:'Приход сохранён',      cancelled:'Приход отменён'      },
  outcome:  {op:'Списание',   prompt:'Подтвердите списание:',   saved:'Списание сохранено',   cancelled:'Списание отменено'   },
  discount: {op:'Переоценка', prompt:'Подтвердите переоценку:', saved:'Переоценка сохранена', cancelled:'Переоценка отменена' },
  return:   {op:'Возврат',    prompt:'Подтвердите возврат:',    saved:'Возврат сохранён',     cancelled:'Возврат отменён'     },
  report:   {op:'Отчёт'}
};
const REV  = Object.fromEntries(Object.entries(OPS).map(([key, data]) => [data.op, key]));
const WORD = { report: 'Отчёт', shoppy: 'Продавец', date: 'Дата', today: 'Сегодня' };
const ICO  = { today: '🗓️', day: '👀', seller: '🤵', new: '🆕', ok: '✅', cancel: '❌' };

function subMsg(template, data) {
  return template.replace(/\{(\w+)\}/g, (match, key) => data[key] ?? match);
}


// === GET RANGE (A:H) or column (A) from Google table ===

async function getRange(sheet, range) {
  const normalizedRange = range.includes(':') ? `${range}` : `${range}:${range}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheet}!${normalizedRange}`
  });

  const values = res.data.values || [];
  return range.includes(':') ? values : values.flat();
}

// === GET SETTINGS ===

async function getSettings() {
  const defaults = {
    startMsg: 'Добро пожаловать!',
    logSheet: 'Log',
    restSheet: 'Rest',
    goodsSheet: 'Goods',
    usersSheet: 'Users',
    schedSheet: 'Sched'
  };

  try {
    const rows = await getRange('Settings', 'A:B');
    const settings = { ...defaults };  // start with defaults

    // Skip first line (titles)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const key = row[0]?.trim();
      const value = row[1]?.trim();

      if (key && value) settings[key] = value;
    }

    return settings;

  } catch (err) {
    console.error('Error reading Settings sheet:', err.message);
    return { ...defaults };
  }
}


// === FORMAT DATE ===

function formatDate(date) {
  return date.toLocaleDateString('uk-UA');  // 09.11.2025
}


async function getSeller(sheet, date) {
  const schedRows = await getRange(sheet, 'A:B');
  let seller = WORD.shoppy[0];
  for (const row of schedRows) {
    if (row[0] === date) seller = row[1];
  }
  return seller;
}


// === UPDATE MAIN MENU ===

async function getMainMenuKeyboard(saleDate, today, schedSheet) {
  const seller   = await getSeller(schedSheet, saleDate);
  const dateText = (saleDate === today) ? `${ICO.today}${today}` : `${ICO.day}${saleDate}`;
  return {
    reply_markup: {
      keyboard: [[OPS.sale.op,   OPS.income.op, OPS.outcome.op,           OPS.discount.op],
                 [OPS.return.op, WORD.report,  `${ICO.seller} ${seller}`, dateText]],
      resize_keyboard: true
    }
  };
}


// === GENERATE REPORT ===

async function generateReport(openingBalance, targetDateStr, logSheet) {
  const targetDate = targetDateStr.split('.').reverse().join('-');  // '17.11.2025' → '2025-11-17'

  const rawRows = await getRange(logSheet, 'A:F');
  const rows = rawRows.slice(1);  // skip header row

  const prevOps = { sale: 0, return: 0, income: 0, outcome: 0, discount: 0 };
  const dayOps  = { sale: {}, return: {}, income: {}, outcome: {}, discount: {} };

  for (const row of rows) {
    const opDate   = row[0]?.trim().split('.').reverse().join('-');
    const type     = REV[row[1]?.trim()];
    const product  = row[2]?.trim();
    const qty      = parseInt(row[3]?.trim(), 10);
    const price    = parseInt(row[4]?.trim(), 10);
    const newPrice = parseInt(row[5]?.trim(), 10); // may be empty

    const article = `${product}_${price}`; // for internal grouping
    const amount = qty * price;

    if (opDate < targetDate) { // prev date
      if (type === 'discount') {
        prevOps.discount += qty * (newPrice - price);
      } else {
        prevOps[type] += amount;
      }

    } else if (opDate === targetDate) { // report date
      if (type !== 'discount') {
        if (!dayOps[type][article]) dayOps[type][article] = { name: product, price, qty: 0 };
        dayOps[type][article].qty += qty;
      } else { // discount
        const delta = qty * (newPrice - price);
        const sign = delta >= 0 ? '+' : '';
        const line = `${product} ${qty}×${price} → ${qty}×${newPrice} (${sign}${delta})`;
        if (!dayOps.discount[article]) dayOps.discount[article] = [];
        dayOps.discount[article].push(line);
        dayOps[type].totalDelta = (dayOps[type].totalDelta || 0) + delta;
      }
    }
  }

  const startOfDayBalance = openingBalance - prevOps.sale + prevOps.return + prevOps.income - prevOps.outcome + prevOps.discount;
  const dayTotals = { sale: 0, return: 0, income: 0, outcome: 0, discount: 0 };

  for (const [type, items] of Object.entries(dayOps)) {
    if (type === 'discount') {
      dayTotals.discount = items.totalDelta ?? 0;
    } else {
      for (const item of Object.values(items)) {
        dayTotals[type] += item.qty * item.price;
      }
    }
  }

  const endOfDayBalance = startOfDayBalance - dayTotals.sale + dayTotals.return + dayTotals.income - dayTotals.outcome + dayTotals.discount;

  const lines = [];
  lines.push(`<b>ОТЧЁТ за ${targetDateStr}</b>`);
  lines.push('');

  const order = ['sale', 'return', 'income', 'outcome', 'discount'];

  for (const type of order) {
    const items = dayOps[type];
    const total = dayTotals[type] ?? 0;

    if ((type === 'discount' && total === 0) || (type !== 'discount' && Object.keys(items).length === 0)) {
      continue;
    }

    lines.push(`<b>${OPS[type].op}:</b>`);

    if (type === 'discount') {
      for (const arr of Object.values(items)) {
        if (Array.isArray(arr)) {
          for (const line of arr) {
            lines.push(`🔹${line}`);
          }
        }
      }
    } else {
      for (const item of Object.values(items)) {
        lines.push(`🔸${item.name} ${item.qty}×${item.price}`);
      }
    }

    if (type === 'discount') {
      const sign = total >= 0 ? '+' : '';
      lines.push(`Итого: <b>${sign}${total.toLocaleString('uk-UA')}</b> ₴`);
    } else {
      lines.push(`Итого: <b>${total.toLocaleString('uk-UA')}</b> ₴`);
    }
    lines.push('');
  }

  lines.push('<b>Остаток товаров:</b>');
  lines.push(`💵 начало дня: <b>${startOfDayBalance.toLocaleString('uk-UA')}</b> ₴`);
  lines.push(`💵 конец дня: &#8239;&#8239;<b>${endOfDayBalance.toLocaleString('uk-UA')}</b> ₴`); // &#8239;&#8239;
  lines.push('');
  lines.push(`🟢 <a href="https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/view?gid=${REST_GID}">Остатки</a>`);

  return lines.join('\n');
}


// === BOT FACTORY ===

function createBotHandlers(ctx) { // settings, chatId, messageId
  return {
    ctx,

    async tg(method, body) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        return await res.json();
      } catch (err) {
        console.error(`${method}() error:`, err.message);
        return null;
      }
    },

    async sendMessage(text, options = {}) {
      const res = await this.tg('sendMessage', { chat_id: this.ctx.chatId, text, parse_mode: 'HTML', ...options });
      if (res.ok === false) console.log('[DEBUG] sendMessage res=', JSON.stringify(res));
      return res.result.message_id;

    },

    async editMessage(text, options = {}) {
      const res = await this.tg('editMessageText', { chat_id: this.ctx.chatId, message_id: this.ctx.messageId, text, parse_mode: 'HTML', ...options });
      if (res.ok === false) console.log('[DEBUG] editMessage res=', JSON.stringify(res));
      return res.result.message_id;
    },

    async editMessageRmButtons() {
      const res = await this.tg('editMessageReplyMarkup', { chat_id: this.ctx.chatId, message_id: this.ctx.messageId, reply_markup: {} });
      if (res.ok === false) console.log('[DEBUG] editMessageRmButtons res=', JSON.stringify(res));
    },

    async answerCallbackQuery(id, text = '') {
      return await this.tg('answerCallbackQuery', { callback_query_id: id, text });
    },


    // === GET PRICES FOR PRODUCT ===

    async getPricesForProduct(product) {
      const rows = await getRange(this.ctx.settings.restSheet, 'A:B');
      const prices = [...new Set(
        rows
          .filter(r => r[0] === product)
          .map(r => r[1])
      )].sort((a, b) => a - b);
      return prices.map(price => [price, '']);
    },


    // === list pagination ===

    paginate(list, perPage, page, label, operation) {
      const start = page * perPage;
      const end = Math.min(start + perPage, list.length);
      const pageList = list.slice(start, end);

      const columns = 3;
      const keyboard = [];
      for (let i = 0; i < pageList.length; i += columns) {
        const [name1, emoji1] = pageList[i];
        const item1 = { text: `${emoji1 ?? ''} ${name1}`,
          callback_data: emoji1 === ICO.new ? `${label}_new` : `${label}_${name1}` };
        const row = [item1];

        if (i + 1 < pageList.length) {
          const [name2, emoji2] = pageList[i + 1];
          row.push({ text: `${emoji2 ?? ''} ${name2}`,
            callback_data: emoji2 === ICO.new ? `${label}_new` : `${label}_${name2}` });
        }

        if (i + 2 < pageList.length) {
          const [name3, emoji3] = pageList[i + 2];
          row.push({ text: `${emoji3 ?? ''} ${name3}`,
            callback_data: emoji3 === ICO.new ? `${label}_new` : `${label}_${name3}` });
        }

        keyboard.push(row);
      }

      // Navigation
      const nav = [];
      if (page > 0) nav.push({ text: '◀ Назад', callback_data: `page_${page - 1}` });
      if (end < list.length) nav.push({ text: 'Вперед ▶', callback_data: `page_${page + 1}` });
      if (nav.length) keyboard.push(nav);

      return { reply_markup: { inline_keyboard: keyboard } };
    },


    // === SHOW GOODS PAGE ===

    async showGoodsPage(goods, page, opLabel, operation) {
      const perPage = 15;
      if (operation === 'income') goods.push(['Новый товар…', ICO.new]);
      const keyboard = this.paginate(goods, perPage, page, 'product', operation);
      const totalPages = Math.ceil(goods.length / perPage);
      const text = `<b>${opLabel}.</b> Товары ${page + 1}/${totalPages}:`;

      if (this.ctx.messageId) {
        await this.editMessage(text, keyboard);
      } else {
        return await this.sendMessage(text, keyboard); // → messageId
      }
    },


    // === SHOW PRICES PAGE ===

    async showPricesPage(product, prices, page, opLabel, operation) {
      const perPage = 15;
      if (operation === 'income') prices.push(['Новая цена…', ICO.new]);
      const keyboard = this.paginate(prices, perPage, page, 'price', operation);
      const totalPages = Math.ceil(prices.length / perPage);
      const text = `<b>${opLabel}: ${product}.</b> Цены${ totalPages > 1 ? ` ${page + 1}/${totalPages}` : ''}:`;
      await this.editMessage(text, keyboard);
    },


    // === ADD TO LOG ===

    async addToLog(date, type, product, qty, price, priceNew = '') {
      try {
        article = `${product}_${price}`;
        articleNew = priceNew ? `${product}_${priceNew}` : '';
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${this.ctx.settings.logSheet}!A:F`,  // A:Дата, B:Тип, C:Товар, D:Цена, E:Кол-во, F:Новая цена, G: Артикул, H: Новый артикул
          valueInputOption: 'RAW',
          requestBody: { values: [[date, type, product, qty, price, priceNew, article, articleNew]] }
        });
      } catch (err) {
        console.error('Add to log error:', err);
      }
    },


    // === GET USER DATA ===

    async getUser() {
      try {
        const rows = await getRange(this.ctx.settings.usersSheet, 'A:H');
        const row = rows.find(r => r[0] == this.ctx.chatId);
        return row ?? null;
      } catch (err) {
        console.error(`[getUser] Error reading sheet:`, err.message);
        return null;
      }
    },


    // === Refreshing step & temp_data ===

    async updateUserStep({ step = '', opts = {}, saleDate = '' } = {}) {
      const rows = await getRange(this.ctx.settings.usersSheet, 'A:H');
      const rowIndex = rows.findIndex(r => r[0] == this.ctx.chatId);
      if (rowIndex === -1) return false;

      const newRow = [...rows[rowIndex]];

      newRow[4] = step;
      newRow[5] = JSON.stringify(opts);
      if (saleDate === 'today')
        newRow[6] = '';  // remove date if 'today'
      else if (saleDate)
        newRow[6] = saleDate;  // don't change if unset

      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${this.ctx.settings.usersSheet}!A${rowIndex + 1}:H${rowIndex + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [newRow] }
      });
      return true;
    },

    async selectQty(editOrSend, operation, opLabel, tempData, price) {
      const msg = `<b>${opLabel}: ${tempData.product} по ${price} ₴.</b> Количество:`;
      const kbd = { reply_markup: { inline_keyboard: [[{text: '1', callback_data: 'qty_1'}, {text: '2', callback_data: 'qty_2'}, {text: '3', callback_data: 'qty_3'}], [{text: 'Другое…', callback_data: 'other'}]]}};
      messageId = await this[editOrSend](msg, kbd);
      await this.updateUserStep({ step: `${operation}_qty`, opts: {...tempData, price, messageId} });
    }

  };
}


// === Webhook ===

app.get('/', (req, res) => res.send('Webhook ready.'));


// === APP.POST ===

app.post('/', async (req, res) => {
  try {
    const body = req.body;
    // console.log('[DEBUG] body=', JSON.stringify(body, null, 2));

    const message = body.message || body.callback_query?.message;
    if (!message) return res.send('OK'); // No message - ignore

    const firstName = body.message?.from?.first_name || 'Друг';
    const chatId = message.chat.id;
    const text = body.message?.text.trim();
    let messageId = message.message_id;

    const settings = await getSettings();

    let ctx = {settings, chatId, messageId};
    let bot = createBotHandlers(ctx);

    const user = await bot.getUser();
    if (!user || user[3] !== 'Active') {
      await bot.sendMessage(subMsg(settings.denyMsg, { name: firstName}));
      return res.send('OK');
    }

    let today = formatDate(new Date()); // fallback
    if (message.date) today = formatDate(new Date(message.date * 1000));

    const userStep = user[4] || '';
    const tempData = user[5] ? JSON.parse(user[5]) : {};
    const saleDate = user[6] || today;

    messageId = tempData.messageId ?? '';
    ctx.messageId = messageId;
    bot = createBotHandlers(ctx);

    const [operation, stage, substage] = userStep.split('_');
    opLabel = OPS[operation]?.op || operation;
    console.log(`[DEBUG] table operation=${operation}|stage=${stage}|substage=${substage}; opLabel=${opLabel}`)

    const btnYes       = {text: `${ICO.ok} Да`,         callback_data: 'confirm'};
    const btnCancel    = {text: `${ICO.cancel} Отмена`, callback_data: 'cancel'};
    const kbdCancel    = { reply_markup: { inline_keyboard: [[ btnCancel ]] } };
    const kbdYesCancel = { reply_markup: { inline_keyboard: [[ btnYes, btnCancel ]] } };

    // === PROCESSING CALLBACK_QUERY ===
    if (body.callback_query) {
      const cbQueryId = body.callback_query.id;
      const chatId    = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;

      const [cbKey, cbValue] = body.callback_query.data.split('_');
      console.log(`[DEBUG] cbKey=${cbKey}|cbValue=${cbValue}`)

      // Product selected ? price selection || Enter new product
      if (stage === 'goods' && cbKey === 'product') {
        const product = cbValue;
        if (product !== 'new') {
          const prices = await bot.getPricesForProduct(product);
          await bot.showPricesPage(product, prices, 0, opLabel, operation);
          await bot.updateUserStep({ step: `${operation}_prices`, opts: { ...tempData, product, page: 0 }});
        } else {
          await bot.editMessage(`<b>${opLabel}:</b>\n\nВведите название товара:`, kbdCancel);
          await bot.updateUserStep({ step: `${operation}_productnew`, opts: {...tempData}});
        }
        return res.send('OK');
      }

      // Pagination of goods and prices
      if (['goods', 'prices'].includes(stage) && cbKey === 'page') {
        const page = Number(cbValue);
        if (stage === 'goods') {
          const goods = await getRange(settings.goodsSheet, 'A:B');
          await bot.showGoodsPage(goods, page, opLabel, operation);
        } else {
          const prices = await bot.getPricesForProduct(tempData.product);
          await bot.showPricesPage(tempData.product, prices, page, opLabel, operation);
        }
        await bot.updateUserStep({ step: `${operation}_${stage}`, opts: { ...tempData, page } });
        return res.send('OK');
      }

      // Price selected → select quantity || Price input
      if (stage === 'prices' && cbKey === 'price') {
        const price = Number(cbValue);
        if (price !== 'new') {
          await bot.selectQty('editMessage', operation, opLabel, tempData, price);
        } else {
          await bot.editMessage(`<b>${opLabel}: ${tempData.product}</b>\n\nВведите цену:`, kbdCancel);
          await bot.updateUserStep({ step: `${operation}_price_input`, opts: { ...tempData } });
        }
        return res.send('OK');
      }

      // Quantity selection → confirmation
      if (stage === 'qty' && substage !== 'input') {
        let qty;
        if (cbKey === 'other') {
          const messageId = await bot.editMessage(`<b>${opLabel}: ${tempData.product}</b> по <b>${tempData.price}</b> ₴.\n\nВведите количество:`, kbdCancel);
          await bot.updateUserStep({ step: `${operation}_qty_input`, opts: { ...tempData, messageId } });
          return res.send('OK');
        } else {
          qty = Number(cbValue);
        }

        const total = tempData.price * qty;
        const messageId = await bot.editMessage(`${OPS[operation].prompt}\n<b>${tempData.product} ${qty}</b> × <b>${tempData.price}</b>\n\nВсё верно?`, kbdYesCancel);
        await bot.updateUserStep({ step: `${operation}_confirm`, opts: { ...tempData, messageId, qty, total } });
        return res.send('OK');
      }

      // Final confirmation
      if (stage === 'confirm' && cbKey === 'confirm') {
        await bot.addToLog(saleDate, opLabel, tempData.product, tempData.qty, tempData.price, tempData.newprice);
        await bot.updateUserStep();  // reset
        await bot.editMessage(`${OPS[operation].saved}\n\n<b>${tempData.product} ${tempData.qty} × ${tempData.newprice ? `<i>${tempData.price}</i> → ${tempData.newprice}` : `${tempData.price}`}</b> = ${tempData.price * tempData.qty}\nДата: <b>${saleDate}</b>`);
        return res.send('OK');
      }

      // Cancels any cancellable step
      if (cbKey === 'cancel') {
        await bot.editMessage(OPS[operation].cancelled);
        await bot.updateUserStep();  // reset
        return res.send('OK');
      }

    }


    // === THEN text (Продажа, /start etc.) ===

    const opKey = REV[text];
    console.log(`[DEBUG] opKey=${opKey}`);

    if (text === '/start') {
      await bot.updateUserStep();  // reset
      const keyboard = await getMainMenuKeyboard(saleDate, today, settings.schedSheet);
      await bot.sendMessage(subMsg(settings.startMsg, { name: firstName }), keyboard);
      return res.send('OK');

    } else if (opKey && ['sale', 'income', 'outcome', 'discount', 'return'].includes(opKey)) {
      console.log(`[DEBUG] Entering ${opKey}`);
      const goods = await getRange(settings.goodsSheet, 'A:B');
      const opLabel = OPS[opKey].op || opKey;
      const messageId = await bot.showGoodsPage(goods, 0, opLabel, opKey);  // get ID
      await bot.updateUserStep({ step: `${opKey}_goods`, opts: { page: 0, messageId } });  // save ID once

    } else if (text?.includes(ICO.seller)) {
      await bot.sendMessage('😘 Молодец');
      return res.send('OK');

    } else if (opKey && opKey === 'report') {
      report = await generateReport(settings.openingBalance, saleDate, settings.logSheet);
      await bot.sendMessage(report);
      return res.send('OK');

    } else if (text?.includes(ICO.today) || text?.includes(ICO.day)) {
      const todayDate = new Date(today.split('.').reverse().join('-'));  // 09.11.2025 → 2025-11-09 = valid date string

      const yesterdayDate = new Date(todayDate);
      yesterdayDate.setDate(todayDate.getDate() - 1);
      const yesterday = formatDate(yesterdayDate);

      const dayBeforeDate = new Date(todayDate);
      dayBeforeDate.setDate(todayDate.getDate() - 2);
      const dayBefore = formatDate(dayBeforeDate);

      await bot.sendMessage('Выберите или введите дату в формате ДД.ММ.ГГГГ:', {
        reply_markup: {
          keyboard: [[ { text: dayBefore }, { text: yesterday }, { text: 'Сегодня' } ]],
          resize_keyboard: true
        }
      });
      await bot.updateUserStep({ step: 'date_enter' });
      return res.send('OK');

    } else if (stage === 'qty' && substage === 'input') {
      qty = Number(text);
      await bot.editMessageRmButtons();
      const total = tempData.price * qty;
      messageId = await bot.sendMessage(`${OPS[operation].prompt}\n\n<b>${tempData.product} ${qty}</b> × <b>${tempData.price}</b>\n\nВсё верно?`, kbdYesCancel);
      await bot.updateUserStep({ step: `${operation}_confirm`, opts: { ...tempData, messageId, qty, total } });
      return res.send('OK');

    } else if (stage === 'productnew') {
      product = text;
      await bot.editMessageRmButtons();
      messageId = await bot.sendMessage(`<b>${opLabel}: ${product}</b>\n\nВведите цену нового товара:`);
      await bot.updateUserStep({ step: `${operation}_price_input`, opts: { ...tempData, product, messageId }});
      return res.send('OK');

    } else if (stage === 'price' && substage === 'input') {
      // Price entered → select quantity
      price = Number(text);
      await bot.editMessageRmButtons();
      await this.selectQty('sendMessage', operation, opLabel, tempData, price);
    }

    if (operation === 'date' && stage === 'enter' && text) {
      const input = text  === 'Сегодня' ? today : text;
      const regex = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
      if (!regex.test(input)) {
        await bot.sendMessage('Неверный формат даты.\nВведите дату в формате ДД.ММ.ГГГГ');
        return res.send('OK');
      }

      const [, d, m, y] = input.match(regex);
      const date = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
      if (isNaN(date.getTime()) || date.getDate() != d || date.getMonth() + 1 != m || date.getFullYear() != y) {
        await bot.sendMessage('Неверная дата. Попробуйте еще.');
        return res.send('OK');
      }

      const formatted = date.toLocaleDateString('uk-UA');  // 09.11.2025
      await bot.updateUserStep({ saleDate: text === 'Сегодня' ? 'today' : formatted });
      const keyboard = await getMainMenuKeyboard(formatted, today, settings.schedSheet);
      await bot.sendMessage(`Дата: <b>${formatted}</b>`, keyboard);
      return res.send('OK');
    }


    res.send('OK');
  } catch (err) {
    console.error('WEBHOOK CRASH:', err);
    res.status(200).send('OK');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot on port ${port}`));
