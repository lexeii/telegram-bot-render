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

async function logToSheet(timestamp, payload, updateId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Log!C:C'
    });
    const existingIds = res.data.values ? res.data.values.flat().map(String) : [];
    if (existingIds.includes(String(updateId))) return false;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Log!A:C',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[timestamp, payload, updateId]] }
    });
    return true;
  } catch (err) {
    console.error('Sheets error:', err);
    return false;
  }
}

async function getLogCount() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Log!A:A'
    });
    return res.data.values ? res.data.values.length : 0;
  } catch (err) {
    return 0;
  }
}

async function sendMessage(chatId, text, options = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...options })
  });
}

async function editMessage(chatId, messageId, text, options = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', ...options })
  });
}


async function editOrSend(chatId, messageId, text, options = {}) {
  // Якщо є messageId — спробуємо відредагувати
  if (messageId) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: 'Markdown',
          ...options
        })
      });
      console.log('Повідомлення відредаговано');
      return;
    } catch (err) {
      console.log('Не вдалося відредагувати — надсилаємо нове');
      // Ігноруємо помилку — надсилаємо нове
    }
  }

  // Якщо не вдалося відредагувати — надсилаємо нове
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...options
    })
  });
  const json = await res.json();
  console.log('Надіслано нове повідомлення:', json);
}


async function getPricesForProduct(product) {
  const rest = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Rest!A:B'
  });
  const rows = rest.data.values || [];
  return [...new Set(rows.filter(r => r[0] === product).map(r => r[1]))].sort((a,b) => a-b);
}


async function showGoodsPage(chatId, goods, page) {
  const perPage = 10;
  const start = page * perPage;
  const end = start + perPage;
  const pageGoods = goods.slice(start, end);

  const keyboard = pageGoods.map(g => [{ text: g, callback_data: `sale_product_${g}` }]);

  // Кнопки пагинації
  const nav = [];
  if (page > 0) nav.push({ text: '◀ Назад', callback_data: `sale_page_${page - 1}` });
  if (end < goods.length) nav.push({ text: 'Далі ▶', callback_data: `sale_page_${page + 1}` });
  if (nav.length) keyboard.push(nav);

  await sendMessage(chatId, `**Продажа.** Товары (${start + 1}-${Math.min(end, goods.length)} из ${goods.length}):`, {
    reply_markup: { inline_keyboard: keyboard }
  });
}


async function showPricesPage(chatId, messageId, product, prices, page = 0) {
  const perPage = 10;
  const start = page * perPage;
  const end = start + perPage;
  const pagePrices = prices.slice(start, end);

  // 2 колонки
  const keyboard = [];
  for (let i = 0; i < pagePrices.length; i += 2) {
    const row = [{ text: `${pagePrices[i]} грн`, callback_data: `sale_price_${pagePrices[i]}` }];
    if (i + 1 < pagePrices.length) {
      row.push({ text: `${pagePrices[i + 1]} грн`, callback_data: `sale_price_${pagePrices[i + 1]}` });
    }
    keyboard.push(row);
  }

  const nav = [];
  if (page > 0) nav.push({ text: '◀ Назад', callback_data: `price_page_${page - 1}` });
  if (end < prices.length) nav.push({ text: 'Далі ▶', callback_data: `price_page_${page + 1}` });
  if (nav.length) keyboard.push(nav);

  await editMessage(chatId, messageId, `**Продажа: ${product}.** Ціни (${start + 1}-${Math.min(end, prices.length)} из ${prices.length}):`, {
    reply_markup: { inline_keyboard: keyboard }
  });
}


// === Webhook ===
app.get('/', (req, res) => res.send('Webhook ready.'));


const MAIN_MENU = {
  reply_markup: {
    keyboard: [['Продажа', 'Приход', 'Списание'], ['Переоценка', 'Возврат']],
    resize_keyboard: true
  }
};


  ////////////////
 /// APP.POST ///
////////////////
app.post('/', async (req, res) => {
  try {
    const data = req.body;
    console.log('ОТРИМАНО:', JSON.stringify(data, null, 2)); // ← ДІАГНОСТИКА

    const message = data.message || data.callback_query?.message;
    if (!message) {
      console.log('Немає message — ігноруємо');
      return res.send('OK');
    }

    const chatId = message.chat.id;
    const text = message.text || data.callback_query?.data;
    const messageId = message.message_id;

    console.log(`Користувач ${chatId} надіслав: "${text}"`);

    const user = await getUser(chatId);
    if (!user || user[3] !== 'Active') {
      await sendMessage(chatId, 'Доступ запрещён.');
      return res.send('OK');
    }

    const userStep = user[4] || '';
    const tempData = user[5] ? JSON.parse(user[5]) : {};

    // === ОБРОБКА CALLBACK_QUERY (ПЕРШИЙ) ===
    if (data.callback_query) {
      const callbackData = data.callback_query.data;
      const messageId = data.callback_query.message.message_id;

      // Пагинація товарів
      if (callbackData.startsWith('sale_page_') && userStep === 'sale_step_1') {
        const page = Number(callbackData.replace('sale_page_', ''));
        const goods = await getColumn('Goods', 'A');
        await showGoodsPage(chatId, goods, page);
        await updateUserStep(chatId, 'sale_step_1', { ...tempData, page });
        return res.send('OK');
      }

      // Вибір товару
      if (callbackData.startsWith('sale_product_') && userStep === 'sale_step_1') {
        const product = callbackData.replace('sale_product_', '');
        const prices = await getPricesForProduct(product);
        await showPricesPage(chatId, messageId, product, prices, 0);
        await updateUserStep(chatId, 'sale_step_2', { product, pricePage: 0 });
        return res.send('OK');
      }

      // Пагинація цін
      if (callbackData.startsWith('price_page_') && userStep === 'sale_step_2') {
        const page = Number(callbackData.replace('price_page_', ''));
        const prices = await getPricesForProduct(tempData.product);
        await showPricesPage(chatId, messageId, tempData.product, prices, page);
        await updateUserStep(chatId, 'sale_step_2', { ...tempData, pricePage: page });
        return res.send('OK');
      }

      // Вибір ціни
      if (callbackData.startsWith('sale_price_') && userStep === 'sale_step_2') {
        const price = Number(callbackData.replace('sale_price_', ''));
        await editMessage(chatId, messageId, `**Продажа: ${tempData.product} ${price} грн.** Кількість:`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '1', callback_data: `sale_qty_1` }],
              [{ text: '2', callback_data: `sale_qty_2` }],
              [{ text: '3', callback_data: `sale_qty_3` }],
              [{ text: 'Інше...', callback_data: 'sale_qty_other' }]
            ]
          }
        });
        await updateUserStep(chatId, 'sale_step_3', { ...tempData, price });
        return res.send('OK');
      }
    }

    
    // === ТЕПЕР текст (Продажа, /start тощо) ===
    
    // === /start ===
    if (text === '/start') {
      const startMsg = await getSetting('START_MSG') || 'Добро пожаловать!';
      await sendMessage(chatId, startMsg, MAIN_MENU);
      await updateUserStep(chatId, '');
      return res.send('OK');
    }

    // === Продажа ===
    if (text === 'Продажа' || userStep.startsWith('sale_')) {
      console.log('УВІЙШЛИ В ПРОДАЖУ'); // ← ПЕРЕВІРКА
      if (!userStep) {
        const goods = await getColumn('Goods', 'A');
        await showGoodsPage(chatId, goods, 0);
        await updateUserStep(chatId, 'sale_step_1', { page: 0 });
      }
    }

    res.send('OK');
  } catch (err) {
    console.error('ПОМИЛКА:', err);
    res.send('OK');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot on port ${port}`));

// === Business logic ===

// Read settings
async function getSetting(key) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Settings!A:C'
  });
  const rows = res.data.values || [];
  const row = rows.find(r => r[0] === key);
  return row ? row[1] : null;
}

// Read column
async function getColumn(sheet, col) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheet}!${col}:${col}`
  });
  return res.data.values ? res.data.values.flat() : [];
}

// Refreshing step & temp_data
async function updateUserStep(chatId, step, tempData = {}) {
  const users = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A:F'
  });
  const rows = users.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] == chatId);
  if (rowIndex === -1) return false;

  const newRow = [...rows[rowIndex]];
  newRow[4] = step;
  newRow[5] = JSON.stringify(tempData);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Users!A${rowIndex + 1}:F${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [newRow] }
  });
  return true;
}

// Get user data
async function getUser(chatId) {
  const users = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A:F'
  });
  const rows = users.data.values || [];
  return rows.find(r => r[0] == chatId);
}

// Action log
async function logAction(user, action, details) {
  const logSheet = await getSetting('LOG_SHEET_NAME') || 'Log';
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${logSheet}!A:G`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        new Date().toLocaleString('uk-UA'),
        user[1] || user[0],
        action,
        details.product || '',
        details.price || '',
        details.quantity || '',
        details.comment || ''
      ]]
    }
  });
}
