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
    const chatId = data.message?.chat.id;

    if (chatId && BOT_TOKEN) {
      const timestamp = new Date().toLocaleString('uk-UA');
      const payload = JSON.stringify(data);

      if (await logToSheet(timestamp, payload, updateId)) {
        const count = await getLogCount();
        const text = `Прийнято. Час: ${timestamp}. Кількість: ${count}.`;

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text })
        });
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot on port ${port}`));
