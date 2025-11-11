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


// === GET SETTING ===

async function getSetting(key) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Settings!A:C'
  });
  const rows = res.data.values || [];
  const row = rows.find(r => r[0] === key);
  return row ? row[1] : null;
}


// === GET PRICES FOR PRODUCT ===

async function getPricesForProduct(product) {
  const sheetName = await getSetting('REST_SHEET_NAME') || 'Rest';
  const rest = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:B`
  });
  const rows = rest.data.values || [];
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


// === ADD TO REST ===

async function addToRest(product, qty, note) {
  try {
    const sheetName = await getSetting('REST_SHEET_NAME') || 'Rest';
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:H`,  // Add row with date, type, comment
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[new Date().toLocaleDateString('uk-UA'), 'Продажа', product, qty, note, '', '', '']]
      }
    });
    console.log('Записано в лист Rest');
  } catch (err) {
    console.error('Ошибка на листе Rest:', err);
  }
}


// === ADD TO LOG ===

async function addToLog(date, type, product, qty, price, total, newprice = '') {
  try {
    const sheetName = await getSetting('LOG_SHEET_NAME') || 'Log';
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:G`,  // A:Дата, B:Тип, C:Товар, D:Кол-во, E:Цена, F:Сумма, G: Новая цена
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
  const sheetName = await getSetting('USERS_SHEET_NAME') || 'Users';
  try {
    const users = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:H`
    });
    const rows = users.data.values || [];
    const userRow = rows.find(r => r[0] == chatId);
    if (!userRow) return null;

    const user = [...userRow];

    user[4] = (() => {
      try {
        return user[4] ? JSON.parse(user[4]) : '';
      } catch (e) {
        console.warn(`[getUser] Invalid step for ${chatId}:`, user[4]);
        return user[4] || '';
      }
    })();

    user[5] = (() => {
      try {
        return user[5] ? JSON.parse(user[5]) : {};
      } catch (e) {
        console.warn(`[getUser] Invalid tempData for ${chatId}:`, user[5]);
        return {};
      }
    })();

    return user;
  } catch (error) {
    console.error(`[getUser] Fatal error for ${chatId}:`, error);
    return null;
  }
}


// === UPDATE MAIN MENU ===

async function getMainMenuKeyboard(chatId) {
  const today = formatDate(new Date());
  const user = await getUser(chatId);
  const isToday = !user?.customSaleDate || user.customSaleDate === today;
  const dateText = isToday ? `🗓️${today}` : `🔙${user.customSaleDate}`;

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
  const step = user[4];  // может быть объектом
  return step?.customSaleDate || formatDate(new Date());
}


// === GET COLUMN ===

async function getColumn(sheet, col) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheet}!${col}:${col}`
  });
  return res.data.values ? res.data.values.flat() : [];
}


// === Refreshing step & temp_data ===

async function updateUserStep(chatId, step, tempData = {}) {
  const sheetName = await getSetting('USERS_SHEET_NAME') || 'Users';

  const users = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:H`
  });
  const rows = users.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] == chatId);
  if (rowIndex === -1) return false;

  const newRow = [...rows[rowIndex]];
  newRow[4] = typeof step === 'object' ? JSON.stringify(step) : step;
  newRow[5] = JSON.stringify(tempData);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex + 1}:H${rowIndex + 1}`,
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
    console.log('GOT:', JSON.stringify(data, null, 2)); // ← DEBUG

    const message = data.message || data.callback_query?.message;
    if (!message) {
      console.log('No message - ignore');
      return res.send('OK');
    }

    const chatId = message.chat.id;
    const text = message.text || data.callback_query?.data;
    const messageId = message.message_id;

    console.log(`Користувач ${chatId} надіслав: "${text}"`);

    const user = await getUser(chatId);
    if (!user || user[3] !== 'Active') {
      await sendMessage(chatId, '🚫 Доступ запрещён.');
      return res.send('OK');
    }

    const userStep = user[4] || '';
    const tempData = user[5] ? JSON.parse(user[5]) : {};

    // === PROCESSING CALLBACK_QUERY (FIRST) ===
    if (data.callback_query) {
      const callbackData = data.callback_query.data;
      const messageId = data.callback_query.message.message_id;

      // Pagination of goods
      if (callbackData.startsWith('sale_page_') && userStep === 'sale_step_1') {
        const page = Number(callbackData.replace('sale_page_', ''));
        const sheetName = await getSetting('ART_SHEET_NAME') || 'Goods';
        const goods = await getColumn(sheetName, 'A');
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

      Товар: *${tempData.product}*  
      Цена: *${tempData.price} ₴*  
      Количество: *${qty} шт.*  

      Всё верно?
      `.trim(), {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✔️ Да',       callback_data: 'sale_confirm' },
                { text: '❌ Изменить', callback_data: 'sale_cancel' }
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

        // Write to Rest sheet
        await addToRest(
          tempData.product,
          -tempData.qty,
          `Продажа: ${tempData.qty} × ${tempData.price} ₴ = ${total} ₴`
        );

        await addToLog(
          saleDate,
          'Продажа',
          tempData.product,
          tempData.qty,
          tempData.price,
          total
        );

        const keyboard = await getMainMenuKeyboard(chatId); // Refresh date button
        await editMessage(chatId, messageId, `
      **Продажа введена!**

      *${tempData.product}*  
      Количество: *${tempData.qty} шт.*  
      Сумма: *${total} ₴*  
      Дата: *${saleDate}*

      ❤️Спасибо!
      `.trim(), keyboard);

        await updateUserStep(chatId, '');
        return res.send('OK');
      }


      if (callbackData === 'sale_cancel') {
        await editMessage(chatId, messageId, 'Продажа отменена.', {
          reply_markup: { inline_keyboard: [] }
        });
        await updateUserStep(chatId, '');
        return res.send('OK');
      }


      // === Select any date (including today) ===
      if (callbackData?.startsWith('set_date_')) {
        const selectedDate = callbackData.replace('set_date_', '');
        const today = formatDate(new Date());

        let text;
        if (selectedDate === today) {
          await updateUserStep(chatId, { customSaleDate: null });
          text = `Дата продажи: *сегодня*`;
        } else {
          await updateUserStep(chatId, { customSaleDate: selectedDate });
          text = `Дата продажи: *${selectedDate}*`;
        }

        const keyboard = await getMainMenuKeyboard(chatId);
        await sendMessage(chatId, text, keyboard);

        return res.send('OK');
      }


      if (callbackData === 'set_date_other') {
        await sendMessage(chatId, 'Введите дату: ДД.ММ.ГГГГ', {
          reply_markup: { inline_keyboard: [[{ text: 'Отмена', callback_data: 'sale_cancel' }]] }
        });
        await updateUserStep(chatId, 'awaiting_custom_date', {});
        return res.send('OK');
      }

    }


    // === THEN text (Продажа, /start etc.) ===

    // === /start ===

    if (text === '/start') {
      const startMsg = await getSetting('START_MSG') || 'Добро пожаловать!';
      await updateUserStep(chatId, '');

      const user = await getUser(chatId);
      if (!user) {
        await sendMessage(chatId, 'Ошибка: не удалось загрузить данные пользователя.');
        return res.send('OK');
      }

      const keyboard = await getMainMenuKeyboard(chatId);
      await sendMessage(chatId, startMsg, keyboard);
      return res.send('OK');
    }


    // === Продажа ===

    if (text === '🧾Продажа' || userStep.startsWith('sale_')) {
      console.log('УВІЙШЛИ В ПРОДАЖУ'); // ← ПЕРЕВІРКА
      if (!userStep) {
        const sheetName = await getSetting('ART_SHEET_NAME') || 'Goods';
        const goods = await getColumn(sheetName, 'A');
        const messageId = await showGoodsPage(chatId, null, goods, 0);  // Отримуємо ID
        await updateUserStep(chatId, 'sale_step_1', { page: 0, messageId });  // Зберігаємо ID
      }
    }

    // === Натиснута кнопка дати (з 🗓️ або 🔙) ===
    if (text.includes('🗓️') || text.includes('🔙')) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dayBefore = new Date();
      dayBefore.setDate(dayBefore.getDate() - 2);
      const today = formatDate(new Date());

      await sendMessage(chatId, 'Выберите дату:', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: formatDate(dayBefore), callback_data: `set_date_${formatDate(dayBefore)}` },
              { text: formatDate(yesterday), callback_data: `set_date_${formatDate(yesterday)}` }
            ],
            [
              { text: 'Сегодня', callback_data: `set_date_${today}` },
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

      const formatted = `${d.padStart(2, '0')}.${m.padStart(2, '0')}.${y}`;
      await updateUserStep(chatId, { customSaleDate: formatted });
      const keyboard = await getMainMenuKeyboard(chatId);
      await sendMessage(chatId, `Дата: *${formatted}*`, keyboard);

      await updateUserStep(chatId, '');
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
