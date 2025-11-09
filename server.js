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
  if (messageId) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', ...options })
      });
      return;
    } catch (err) {
      console.log('Не вдалося відредагувати — надсилаємо нове');
    }
  }
  // Якщо не вдалося відредагувати — надсилаємо нове
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...options })
  });
}

async function getPricesForProduct(product) {
  const rest = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Rest!A:B'
  });
  const rows = rest.data.values || [];
  return [...new Set(rows.filter(r => r[0] === product).map(r => r[1]))].sort((a,b) => a-b);
}

// === Webhook ===
app.get('/', (req, res) => res.send('Webhook ready.'));


const MAIN_MENU = {
  reply_markup: {
    keyboard: [['Продажа', 'Приход'], ['Списание', 'Переоценка'], ['Возврат']],
    resize_keyboard: true
  }
};


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
    const text = message.text;
    const messageId = message.message_id;

    console.log(`Користувач ${chatId} надіслав: "${text}"`);

    const user = await getUser(chatId);
    if (!user || user[3] !== 'Active') {
      await sendMessage(chatId, 'Доступ запрещён.');
      return res.send('OK');
    }

    const userStep = user[4] || '';
    const tempData = user[5] ? JSON.parse(user[5]) : {};

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
        console.log('Крок 1: показуємо товари');
        const goods = await getColumn('Goods', 'A');
        const pageGoods = goods.slice(0, 10);
        const keyboard = pageGoods.map(g => [{ text: g, callback_data: `sale_product_${g}` }]);

        await editOrSend(chatId, messageId, '**Продажа.** Выберите товар:', {
          reply_markup: { inline_keyboard: keyboard }
        });
        await updateUserStep(chatId, 'sale_step_1');
      }
      // ... інші кроки ...
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
