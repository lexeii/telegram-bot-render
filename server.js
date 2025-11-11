const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID

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


// === SEND MESSAGE ===

async function sendMessage(chatId, text, options = {}) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...options })
  });
  return res;
}


// === EDIT MESSAGE ===

async function editMessage(chatId, messageId, text, options = {}) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', ...options })
  });
  return res
}


// === ANSWER CALLBACK QUERY ===

async function answerCallbackQuery(callbackQueryId, text = '') {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
  return res
}


// === GET RANGE from Google table ===

async function getRange(sheet, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheet}!${range}`
  });
  return res.data.values || [];
}


// === GET COLUMN ===

async function getColumn(sheet, col) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheet}!${col}:${col}`
  });
  return res.data.values ? res.data.values.flat() : [];
}


// === GET SETTINGS ===

async function getSettings() {
  const defaults = {
    startMsg: 'Добро пожаловать!',
    logSheet: 'Log',
    restSheet: 'Rest',
    goodsSheet: 'Goods',
    usersSheet: 'Users'
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


// === GET PRICES FOR PRODUCT ===

async function getPricesForProduct(product) {
  const rows = await getRange(settings.restSheet, 'A:B');
  return [...new Set(rows.filter(r => r[0] === product).map(r => r[1]))].sort((a, b) => a - b);
}


// === SHOW GOODS PAGE ===

async function showGoodsPage(chatId, messageId, goods, page) {
  const perPage = 10;
  const start = page * perPage;
  const end = Math.min(start + perPage, goods.length);
  const pageGoods = goods.slice(start, end);

  // 2 columns
  const keyboard = [];
  for (let i = 0; i < pageGoods.length; i += 2) {
    const row = [{ text: pageGoods[i], callback_data: `sale_product_${pageGoods[i]}` }];
    if (i + 1 < pageGoods.length) {
      row.push({ text: pageGoods[i + 1], callback_data: `sale_product_${pageGoods[i + 1]}` });
    }
    keyboard.push(row);
  }

  // Pagination
  const nav = [];
  if (page > 0) nav.push({ text: '◀ Назад', callback_data: `sale_page_${page - 1}` });
  if (end < goods.length) nav.push({ text: 'Вперед ▶', callback_data: `sale_page_${page + 1}` });
  if (nav.length) keyboard.push(nav);

  const totalPages = Math.ceil(goods.length / perPage);
  const text = `**Продажа.** Товары ${page + 1}/${totalPages}:`;

  if (messageId) {
    await editMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
  } else {
    const res = await sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    const json = await res.json();
    return json.result.message_id;
  }
}


// === SHOW PRICES PAGE ===

async function showPricesPage(chatId, messageId, product, prices, page = 0) {
  const perPage = 10;
  const start = page * perPage;
  const end = Math.min(start + perPage, prices.length);
  const pagePrices = prices.slice(start, end);

  // 2 columns
  const keyboard = [];
  for (let i = 0; i < pagePrices.length; i += 2) {
    const row = [{ text: `${pagePrices[i]} ₴`, callback_data: `sale_price_${pagePrices[i]}` }];
    if (i + 1 < pagePrices.length) {
      row.push({ text: `${pagePrices[i + 1]} ₴`, callback_data: `sale_price_${pagePrices[i + 1]}` });
    }
    keyboard.push(row);
  }

  // Pagination
  const nav = [];
  if (page > 0) nav.push({ text: '◀ Назад', callback_data: `price_page_${page - 1}` });
  if (end < prices.length) nav.push({ text: 'Вперед ▶', callback_data: `price_page_${page + 1}` });
  if (nav.length) keyboard.push(nav);

  const totalPages = Math.ceil(prices.length / perPage);
  const text = `**Продажа: ${product}.** Цены ${page + 1}/${totalPages}:`;

  await editMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
}


// === ADD TO LOG ===

async function addToLog(date, type, product, qty, price, total, newprice = '') {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${settings.logSheet}!A:G`,  // A:Дата, B:Тип, C:Товар, D:Кол-во, E:Цена, F:Сумма, G: Новая цена
      valueInputOption: 'RAW',
      requestBody: { values: [[date, type, product, qty, price, total, newprice]] }
    });
  } catch (err) {
    console.error('Log error:', err);
  }
}


// === FORMAT DATE ===

function formatDate(date) {
  return date.toLocaleDateString('uk-UA');  // 09.11.2025
}


// === GET USER DATA ===

async function getUser(chatId) {
  try {
    const rows = await getRange(settings.usersSheet, 'A:H');
    const row = rows.find(r => r[0] == chatId);
    if (!row) return null;

    console.log(`[DEBUG getUser] Raw row for ${chatId}:`, JSON.stringify(row));

    return row;
  } catch (err) {
    console.error(`[getUser] Error reading sheet:`, err.message);
    return null;
  }
}


// === UPDATE MAIN MENU ===

async function getMainMenuKeyboard(chatId) {
  const user = await getUser(chatId);
  const customDate = user[6];
  const isToday = !customDate || customDate === today;
  const dateText = isToday ? `🗓️${today}` : `🔙${customDate}`;

  return {
    reply_markup: {
      keyboard: [
        ['🧾Продажа', '📥Приход',  '📤Списание'],
        ['📉Уценка',  '💸Возврат', dateText]
      ],
      resize_keyboard: true
    }
  };
}


// === GET SALE DATE ===

async function getSaleDate(chatId) {
  const user = await getUser(chatId);
  return user[6] || formatDate(new Date()); // FIXME
}


// === Refreshing step & temp_data ===

async function updateUserStep(chatId, step = '', tempData = {}, saleDate = '') {
  const rows = await getRange(settings.usersSheet, 'A:H');
  const rowIndex = rows.findIndex(r => r[0] == chatId);
  if (rowIndex === -1) return false;

  const newRow = [...rows[rowIndex]];

  newRow[4] = step;
  newRow[5] = JSON.stringify(tempData);
  if (saleDate === 'today')
    newRow[6] = '';  // remove date if 'today'
  else if (saleDate)
    newRow[6] = saleDate;  // set new if set, otherwise don't change

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${settings.usersSheet}!A${rowIndex + 1}:H${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [newRow] }
  });
  return true;
}


// === Webhook ===

app.get('/', (req, res) => res.send('Webhook ready.'));


// === APP.POST ===

app.post('/', async (req, res) => {
  try {
    const data = req.body;
    console.log('GOT:', JSON.stringify(data, null, 2)); // DEBUG

    const message = data.message || data.callback_query?.message;
    if (!message) {
      console.log('No message - ignore'); // DEBUG
      return res.send('OK');
    }

    const chatId = message.chat.id;
    const text = message.text || data.callback_query?.data;
    const messageId = message.message_id;

    console.log(`User ${chatId} sent: "${text}"`); // DEBUG

    const user = await getUser(chatId);

    if (!user || user[3] !== 'Active') {
      await sendMessage(chatId, '🚫 Доступ запрещён.');
      return res.send('OK');
    }

    let today = formatDate(new Date()); // fallback
    if (message.date) {
      today = formatDate(new Date(
        new Date(message.date * 1000).toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' })
      ));
    }

    const userStep = user[4] || '';
    const tempData = user[5] ? JSON.parse(user[5]) : {};
    const saleDate = user[6] || today;

    const settings = await getSettings();


    // === PROCESSING CALLBACK_QUERY (FIRST) ===
    if (data.callback_query) {
      const callbackQuery = data.callback_query;
      const callbackQueryId = callbackQuery.id;
      const chatId = callbackQuery.message.chat.id;
      const messageId = callbackQuery.message.message_id;
      const callbackData = callbackQuery.data;


      // Pagination of goods
      if (callbackData.startsWith('sale_page_') && userStep === 'sale_step_1') {
        const page = Number(callbackData.replace('sale_page_', ''));
        const goods = await getColumn(settings.goodsSheet, 'A');
        await showGoodsPage(chatId, tempData.messageId, goods, page);
        await updateUserStep(chatId, 'sale_step_1', { ...tempData, page });
        return res.send('OK');
      }

      // Goods select
      if (callbackData.startsWith('sale_product_') && userStep === 'sale_step_1') {
        const product = callbackData.replace('sale_product_', '');
        const prices = await getPricesForProduct(product);
        await showPricesPage(chatId, messageId, product, prices, 0);
        await updateUserStep(chatId, 'sale_step_2', { product, pricePage: 0 });
        return res.send('OK');
      }

      // Pagination of prices
      if (callbackData.startsWith('price_page_') && userStep === 'sale_step_2') {
        const page = Number(callbackData.replace('price_page_', ''));
        const prices = await getPricesForProduct(tempData.product);
        await showPricesPage(chatId, messageId, tempData.product, prices, page);
        await updateUserStep(chatId, 'sale_step_2', { ...tempData, pricePage: page });
        return res.send('OK');
      }

      // Price select
      if (callbackData.startsWith('sale_price_') && userStep === 'sale_step_2') {
        const price = Number(callbackData.replace('sale_price_', ''));
        await editMessage(chatId, messageId, `**Продажа: ${tempData.product} ${price} ₴.** Количество:`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '1', callback_data: `sale_qty_1` },
                { text: '2', callback_data: `sale_qty_2` }
              ],
              [
                { text: '3', callback_data: `sale_qty_3` },
                { text: 'Другое…', callback_data: 'sale_qty_other' }
              ]
            ]
          }
        });
        await updateUserStep(chatId, 'sale_step_3', { ...tempData, price });
        return res.send('OK');
      }

      // === Step 3: quantity selection → confirmation ===
      if (callbackData.startsWith('sale_qty_') && userStep === 'sale_step_3') {
        let qty;
        if (callbackData === 'sale_qty_other') {
          await editMessage(chatId, messageId, `**Продажа: ${tempData.product} ${tempData.price} ₴.**\n\nВведите количество:`, {
            reply_markup: { inline_keyboard: [[{ text: 'Отмена', callback_data: 'sale_cancel' }]] }
          });
          await updateUserStep(chatId, 'sale_step_qty_input', { ...tempData });
          return res.send('OK');
        } else {
          qty = Number(callbackData.replace('sale_qty_', ''));
        }

        const total = tempData.price * qty;

        await updateUserStep(chatId, 'sale_step_confirm', { ...tempData, qty, total });

        await editMessage(chatId, messageId, `
**Подтвердите продажу**

*${tempData.product}* по *${tempData.price} ₴*  
*${qty} шт.*  

Всё верно?
      `.trim(), {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Да',     callback_data: 'sale_confirm' },
                { text: '❌ Отмена', callback_data: 'sale_cancel' }
              ]
            ]
          }
        });

        return res.send('OK');
      }


      // === Final confirmation ===
      if (callbackData === 'sale_confirm' && userStep === 'sale_step_confirm') {
        const total = tempData.price * tempData.qty;
        const saleDate = await getSaleDate(chatId);  // ← Get date

        await addToLog(
          saleDate,
          'Продажа',
          tempData.product,
          tempData.qty,
          tempData.price,
          total
        );

        await answerCallbackQuery(callbackQueryId, '✅ Продажа записана!');

        const keyboard = await getMainMenuKeyboard(chatId); // Refresh date button
        console.log('[DEBUG] messageId', messageId);
        await editMessage(chatId, messageId, `
**Продажа записана!**

*${tempData.product}*  
Цена: *${tempData.price} ₴*  
Количество: *${tempData.qty} шт.*  
Сумма: *${total} ₴*  
Дата: *${saleDate}*
      `.trim(), keyboard);

        await updateUserStep(chatId);
        return res.send('OK');
      }


      if (callbackData === 'sale_cancel') {
        await editMessage(chatId, messageId, 'Продажа отменена.', {
          reply_markup: { inline_keyboard: [] }
        });
        await updateUserStep(chatId);
        return res.send('OK');
      }


      // === Select any date (including today) ===
      if (callbackData?.startsWith('set_date_')) {
        const selectedDate = callbackData.replace('set_date_', '');

        let text;
        if (selectedDate === 'other') {
          await editMessage(chatId, messageId, 'Введите дату: ДД.ММ.ГГГГ', {
            reply_markup: { inline_keyboard: [[{ text: 'Отмена', callback_data: 'sale_cancel' }]] }
          });
          await updateUserStep(chatId, 'awaiting_custom_date');
          return res.send('OK');
        } else if (selectedDate === today) {
          await updateUserStep(chatId, '', {}, 'today');
          text = `Дата: *сегодня*`;
        } else {
          await updateUserStep(chatId, '', {}, selectedDate);
          text = `Дата: *${selectedDate}*`;
        }

        const keyboard = await getMainMenuKeyboard(chatId);
        await editMessage(chatId, messageId, text, keyboard);

        return res.send('OK');
      }


    }


    // === THEN text (Продажа, /start etc.) ===

    // === /start ===

    if (text === '/start') {
      const user = await getUser(chatId);
      if (!user) {
        await sendMessage(chatId, 'Ошибка: пользователь не найден.');
        return res.send('OK');
      }

      const step = user[4];
      const tempData = user[5];

      await updateUserStep(chatId);
      const keyboard = await getMainMenuKeyboard(chatId);
      await sendMessage(chatId, settings.startMsg, keyboard);
      return res.send('OK');
    }


    // === Продажа ===

    if (text === '🧾Продажа' || userStep.startsWith('sale_')) {
      console.log(`ENTERING ${text}`); // DEBUG
      if (!userStep) {
        const goods = await getColumn(settings.goodsSheet, 'A');

        const messageId = await showGoodsPage(chatId, null, goods, 0);        // get ID
        await updateUserStep(chatId, 'sale_step_1', { page: 0, messageId });  // save it once
      }
    }

    // === Натиснута кнопка дати (з 🗓️ або 🔙) ===
    if (text.includes('🗓️') || text.includes('🔙')) {
      // 09.11.2025 → 2025-11-09 = valid date string
      const todayDate = new Date(today.split('.').reverse().join('-'));

      const yesterdayDate = new Date(todayDate);
      yesterdayDate.setDate(todayDate.getDate() - 1);
      const yesterday = formatDate(yesterdayDate);

      const dayBeforeDate = new Date(todayDate);
      dayBeforeDate.setDate(todayDate.getDate() - 2);
      const dayBefore = formatDate(dayBeforeDate);

      await sendMessage(chatId, 'Выберите дату операции:', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: dayBefore, callback_data: `set_date_${dayBefore}` },
              { text: yesterday, callback_data: `set_date_${yesterday}` }
            ],
            [
              { text: 'Сегодня', callback_data: 'set_date_today' },
              { text: 'Другая…', callback_data: 'set_date_other' }
            ]
          ]
        }
      });
      return res.send('OK');
    }


    if (userStep === 'awaiting_custom_date' && message?.text) {
      const input = message.text.trim();
      const regex = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
      if (!regex.test(input)) {
        await sendMessage(chatId, 'Неверный формат. ДД.ММ.ГГГГ');
        return res.send('OK');
      }

      const [, d, m, y] = input.match(regex);
      const date = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
      if (isNaN(date.getTime()) || date.getDate() != d || date.getMonth() + 1 != m || date.getFullYear() != y) {
        await sendMessage(chatId, 'Неверная дата. Попробуйте еще:');
        return res.send('OK');
      }

      const formatted = date.toLocaleDateString('uk-UA');  // 09.11.2025
      await updateUserStep(chatId, '', {}, formatted);
      const keyboard = await getMainMenuKeyboard(chatId);
      await sendMessage(chatId, `Дата: *${formatted}*`, keyboard);

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
