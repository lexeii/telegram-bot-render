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

// === Webhook ===
app.get('/', (req, res) => res.send('Webhook ready.'));

app.post('/', async (req, res) => {
  try {
    const data = req.body;
    const updateId = data.update_id;
    const message = data.message || data.callback_query?.message;
    const chatId = message?.chat.id;
    const text = message?.text || data.callback_query?.data;
    const messageId = message?.message_id;

    if (!chatId) return res.send('OK');

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
      await sendMessage(chatId, startMsg, {
        reply_markup: {
          keyboard: [['Продажа', 'Приход'], ['Списание', 'Переоценка'], ['Возврат']],
          resize_keyboard: true
        }
      });
      await updateUserStep(chatId, '');
      return res.send('OK');
    }

    // === Продажа ===
    if (text === 'Продажа' || userStep.startsWith('sale_')) {
      if (!userStep) {
        const goods = await getColumn('Goods', 'A');
        await editOrSend(chatId, messageId, '**Продажа.** Выберите товар:', {
          reply_markup: { inline_keyboard: goods.slice(0, 10).map(g => [{text: g, callback_data: `sale_product_${g}`}]) }
        });
        await updateUserStep(chatId, 'sale_step_1');
      } else if (userStep === 'sale_step_1' && text.startsWith('sale_product_')) {
        const product = text.replace('sale_product_', '');
        const prices = await getPricesForProduct(product);
        await editMessage(chatId, messageId, `**Продажа: ${product}.** Выберите цену:`, {
          reply_markup: { inline_keyboard: prices.map(p => [{text: `${p} грн`, callback_data: `sale_price_${p}`}] ) }
        });
        await updateUserStep(chatId, 'sale_step_2', { product });
      } else if (userStep === 'sale_step_2' && text.startsWith('sale_price_')) {
        const price = text.replace('sale_price_', '');
        await editMessage(chatId, messageId, `**Продажа: ${tempData.product} ${price} грн.** Количество:`, {
          reply_markup: { inline_keyboard: [[{text: '1', callback_data: 'sale_qty_1'}]] }
        });
        await updateUserStep(chatId, 'sale_step_3', { ...tempData, price: Number(price) });
      }
      // ... інші кроки ...
    }

    res.send('OK');
  } catch (err) {
    console.error(err);
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
