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
  sale:     {op:'Продажа',   prompt:'Подтвердите продажу:',    saved:'Продажа сохранена',    cancelled:'Продажа отменена'    },
  income:   {op:'Приход',    prompt:'Подтвердите приход:',     saved:'Приход сохранён',      cancelled:'Приход отменён'      },
  outcome:  {op:'Списание',  prompt:'Подтвердите списание:',   saved:'Списание сохранено',   cancelled:'Списание отменено'   },
  discount: {op:'Переоцен.', prompt:'Подтвердите переоценку:', saved:'Переоценка сохранена', cancelled:'Переоценка отменена' },
  return:   {op:'Возврат',   prompt:'Подтвердите возврат:',    saved:'Возврат сохранён',     cancelled:'Возврат отменён'     },
  report:   {op:'Отчёт'}
};
const REV  = Object.fromEntries(Object.entries(OPS).map(([key, data]) => [data.op, key]));
const WORD = { report: 'Отчёт', shoppy: 'Продавец', noname: 'Друг', date: 'Дата', today: 'Сегодня', back: '◀ Назад', forth: 'Вперед ▶' };
const ICON  = { today: '🗓️', day: '👀', seller: '🤵', new: '🆕', ok: '✅', cancel: '❌', oper1: '🔸', oper2: '🔹', pkg: '📦', sheet: '❇️' };
const months = [ 'янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек' ];

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

// === FORMAT CURRENCY ===

function formatCurrency(num, isSigned = false) {
  if (num === 0) return '<b>0</b> ₴';
  const abs = Math.abs(num);
  const sign = isSigned ? (num > 0 ? '+' : '−') : (num > 0 ? '' : '−');
  let str = abs.toString();
  if (str.length > 4) str = str.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F');
  return `<b>${sign}${str}</b> ₴`;
}


async function getSeller(sheet, date) {
  const schedRows = await getRange(sheet, 'A:B');
  let seller = WORD.shoppy;
  for (const row of schedRows) {
    if (row[0] === date) seller = row[1];
  }
  return seller;
}


// === UPDATE MAIN MENU ===

async function getMainMenuKeyboard(saleDate, today, schedSheet) {
  const seller   = await getSeller(schedSheet, saleDate);
  const icon = (saleDate === today) ? ICON.today : ICON.day;
  const [dayS, monthS, yearS] = saleDate.split('.').map(Number);
  const [dayT, monthT, yearT] =    today.split('.').map(Number);
  const shortMonthS = months[monthS - 1];
  const shortYearS  = yearS.toString().slice(-2);
  if (yearS === yearT)
    dateText = `${icon} ${dayS} ${shortMonthS}`;
  else
    dateText = `${icon} ${dayS} ${shortMonthS} ${shortYearS}`;

  return {
    reply_markup: {
      keyboard: [[OPS.sale.op,   OPS.income.op, OPS.outcome.op,           OPS.discount.op],
                 [OPS.return.op, WORD.report,  `${ICON.seller} ${seller}`, dateText]],
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

    if (!type) console.error(`Undefined type on ${opDate}`);

    if (opDate < targetDate) { // prev date
      if (type === 'discount') {
        prevOps.discount += qty * (newPrice - price);
      } else {
        prevOps[type] += amount;
      }

    } else if (opDate === targetDate) { // report's date
      if (type !== 'discount') {
        if (!dayOps[type][article])
          dayOps[type][article] = { name: product, price, qty: 0 };
        dayOps[type][article].qty += qty;
      } else { // discount
        const delta = qty * (newPrice - price);
        const sign = delta >= 0 ? '+' : '';
        const line = `${product} ${qty}×${price}→${newPrice} (${sign}${delta})`;
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

  const grandTotal = dayTotals.income - dayTotals.outcome + dayTotals.discount - dayTotals.sale + dayTotals.return;
  const endOfDayBalance = startOfDayBalance + grandTotal;

  const lines = [];
  let totalsDisplayed = 0;
  lines.push(`<b>ОТЧЁТ за ${targetDateStr}</b>`);
  lines.push('');

  const order = ['sale', 'return', 'income', 'outcome', 'discount'];

  for (const type of order) {
    const items = dayOps[type];
    let total = dayTotals[type] ?? 0;

    if ((type === 'discount' && total === 0) || (type !== 'discount' && Object.keys(items).length === 0)) {
      continue;
    }

    lines.push(`<b>${OPS[type].op}:</b>`);

    if (type === 'discount') {
      for (const arr of Object.values(items)) {
        if (Array.isArray(arr)) {
          for (const line of arr) {
            lines.push(`${ICON.oper2}${line}`);
          }
        }
      }
    } else {
      for (const item of Object.values(items)) {
        lines.push(`${ICON.oper1}${item.name} ${item.qty}×${item.price}`);
      }
    }

    if (['sale', 'outcome'].includes(type)) total = -total;
    lines.push(`Итого: ${formatCurrency(total, true)}`);
    lines.push('');
    totalsDisplayed += 1;
  }

  if (totalsDisplayed > 1) {
    lines.push(`Итого за день: ${formatCurrency(grandTotal, true)}`);
    lines.push('');
  }
  lines.push('<b>Остаток товаров:</b>');
  lines.push(`${ICON.pkg} начало дня: ${formatCurrency(startOfDayBalance)}`);
  lines.push(`${ICON.pkg} &#8239;конец&#8239; дня: ${formatCurrency(endOfDayBalance)}`);
  lines.push('');
  lines.push(`${ICON.sheet} <a href="https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/view?gid=${REST_GID}">Остатки</a>`);

  return lines.join('\n');
}


function parseFlexibleDate(str, today) {
  const parts = str.split('.');
  let day   = parseInt(parts[0], 10);
  let month = parseInt(parts[1], 10);
  let year  = parseInt(parts[2], 10);

  if (isNaN(day) || day < 1 || day > 31) return { valid: false };

  switch (parts.length) {
    case 1:  // only day: "5", "05", "12"
      month = today.getMonth() + 1;
      year  = today.getFullYear();
      break;
    case 2:  // day & month: "15.3", "9.11", "05.01"
      if (isNaN(month) || month < 1 || month > 12) return { valid: false };
      year = today.getFullYear();
      break;
    case 3:  // full date: "22.11.25" or "22.11.2025"
      if (isNaN(month) || month < 1 || month > 12) return { valid: false };

      switch (parts[2].length) {
        case 2:
          year = 2000 + year;  // 25 → 2025
          break;
        case 4:
          if (year < 2000 || year > 2100) return { valid: false }; // protection from 0000 or 9999
          break;
        default:
          return { valid: false };
      }
      break;
    default:
      return { valid: false };
  }

  // create the date and validate it (for example, 31.04 → Invalid Date)
  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime()) || date.getDate() !== day || date.getMonth() !== month - 1 || date.getFullYear() !== year) return { valid: false };

  const formatted = `${day.toString().padStart(2, '0')}.${month.toString().padStart(2, '0')}.${year}`;
  const save = date === today ? 'today' : formatted;

  return {
    valid: true,
    date,
    formatted,  // "22.11.2025"
    save
  };
}


// === Get latest dates for each op type ===

async function getLastDates(settings) {
  const OPS_TYPES = [ OPS.sale.op, OPS.income.op, OPS.outcome.op, OPS.discount.op, OPS.return.op ];
  const rows = await getRange(settings.logSheet, 'A:B');
  const maxDates = {};

  for (const row of rows) {
    const opDateStr = row[0]?.trim();  // column A: date "dd.mm.yyyy"
    const type = row[1]?.trim();       // column B: type

    if (!opDateStr || !type || !OPS_TYPES.includes(type)) continue;

    // Parse date into Date (ignore apostrophe, if any)
    const [day, month, year] = opDateStr.replace("'", '').split('.');
    const opDate = new Date(year, month - 1, day);  // valid Date

    if (isNaN(opDate)) continue;  // invalid date: skip

    if (!maxDates[type] || opDate > maxDates[type]) {
      maxDates[type] = opDate;
    }
  }

  // Format back into "dd.mm.yyyy"
  const result = {};
  OPS_TYPES.forEach(type => {
    if (maxDates[type]) {
      const d = maxDates[type];
      result[type] = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()}`;
    } else {
      result[type] = 'нет данных';
    }
  });

  return result;
}


// === Calculate salary ===

async function calculateSalary(settings, monthStr, isForecast = false) {  // monthStr is "12.2025" or "01.2026"...
  const [month, year] = monthStr.split('.').map(Number);  // month 1-12, year
  const targetMonth = month - 1;  // JS: 0 = January

  const rows = await getRange(settings.schedSheet, 'A:C');

  const sellers = {};
  let totalSalesActual = 0;
  let daysPassed = 0;
  let totalDaysInMonth = 0;

  const now = new Date();
  const isCurrentMonth = (now.getMonth() === targetMonth && now.getFullYear() === year);

  totalDaysInMonth = new Date(year, targetMonth + 1, 0).getDate();

  for (const row of rows) {
    const dateStr = row[0]?.trim();
    if (!dateStr) continue;

    const [d, m, y] = dateStr.split('.').map(Number);
    const rowDate = new Date(y, m - 1, d);

    if (rowDate.getMonth() !== targetMonth || rowDate.getFullYear() !== year) continue;

    const seller      = row[1]?.trim();
    const daySalesStr = row[2]?.trim();  // column C — daily sales amount
    const daySales    = parseInt(daySalesStr?.replace(/\s/g, '') || '0', 10) || 0;

    if (!sellers[seller]) sellers[seller] = { sales: 0, days: 0 };
    sellers[seller].sales += daySales;
    sellers[seller].days  += 1;

    // For actual sales only (past days)
    if (!isForecast || rowDate <= now) {
      totalSalesActual += daySales;
      if (rowDate <= now) daysPassed++;
    }
  }

  // Forecast, if it is the current month
  let totalSalesForecast = totalSalesActual;
  let projectedText = '';

  if (isCurrentMonth && isForecast) {
    const daysLeft = totalDaysInMonth - daysPassed;
    if (daysPassed > 0 && daysLeft > 0) {
      const avgPerDay = totalSalesActual / daysPassed;
      const projected = Math.round(avgPerDay * daysLeft);
      totalSalesForecast += projected;
      projectedText = `За ${daysPassed} дн. продано на ${totalSalesActual.toLocaleString('uk-UA')} ₴\nОжидаем за оставшиеся ${daysLeft} дн. ещё ~${projected.toLocaleString('uk-UA')} ₴\nПрогноз суммы продаж: ${totalSalesForecast.toLocaleString('uk-UA')} ₴`;
    }
  }

  const finalSales = isForecast && isCurrentMonth ? totalSalesForecast : totalSalesActual;

  // Salary calculation
  const base           = parseInt(settings.salBase);
  const percentRate    = parseFloat(settings.salPct.replace(',', '.'));
  const bonusPer100k   = parseInt(settings.salBonusPct);
  const bonusThreshold = parseInt(settings.salBonusTr);
  const percentRateTxt = percentRate * 100;

  const percentPart = Math.round(finalSales * percentRate);
  const bonus = Math.floor(finalSales / bonusThreshold) * bonusPer100k;
  const totalSalaryOne = base + percentPart + bonus;

  // Everyone's contribution
  const contributions = [];
  let totalSellerSales = 0;
  for (const [name, data] of Object.entries(sellers)) {
    totalSellerSales += data.sales;
  }

  for (const [name, data] of Object.entries(sellers)) {
    const sales = data.sales;
    const percent = totalSellerSales > 0 ? Math.round((sales / totalSellerSales) * 100) : 0;
    contributions.push(`${ICON.seller}${name}: ${sales.toLocaleString('uk-UA')} ₴ (${percent}%)`);
  }

  // Forming the text
  const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const monthName = monthNames[targetMonth];
  const yearStr = year;

  const header = isForecast && isCurrentMonth 
    ? `<b>🔮 Прогноз зарплаты за ${monthName} ${yearStr}</b>`
    : `<b>💰 Зарплата за ${monthName} ${yearStr}</b>`;

  const lines = [header, ''];

  if (projectedText) lines.push(projectedText, '');

  lines.push('<b>Вклад продавцов:</b>');
  lines.push(...contributions);
  lines.push(`✴️Итого: ${totalSalesActual.toLocaleString('uk-UA')} ₴`);
  lines.push('');

  lines.push(`<b>Составляющие з/п:</b>`);
  lines.push(`${ICON.oper1}База: ${base.toLocaleString('uk-UA')} ₴`);
  lines.push(`${ICON.oper1}Процент (${percentRateTxt}%): ${percentPart.toLocaleString('uk-UA')} ₴`);
  lines.push(`${ICON.oper1}Премия: ${bonus.toLocaleString('uk-UA')} ₴`);
  lines.push(`${ICON.oper2}<b>Итого: ${totalSalaryOne.toLocaleString('uk-UA')} ₴</b>`);

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
          callback_data: emoji1 === ICON.new ? `${label}_new` : `${label}_${name1}` };
        const row = [item1];

        if (i + 1 < pageList.length) {
          const [name2, emoji2] = pageList[i + 1];
          row.push({ text: `${emoji2 ?? ''} ${name2}`,
            callback_data: emoji2 === ICON.new ? `${label}_new` : `${label}_${name2}` });
        }

        if (i + 2 < pageList.length) {
          const [name3, emoji3] = pageList[i + 2];
          row.push({ text: `${emoji3 ?? ''} ${name3}`,
            callback_data: emoji3 === ICON.new ? `${label}_new` : `${label}_${name3}` });
        }

        keyboard.push(row);
      }

      // Navigation
      const nav = [];
      if (page > 0) nav.push({ text: WORD.back, callback_data: `page_${page - 1}` });
      if (end < list.length) nav.push({ text: WORD.forth, callback_data: `page_${page + 1}` });
      if (nav.length) keyboard.push(nav);

      return { reply_markup: { inline_keyboard: keyboard } };
    },


    // === SHOW GOODS PAGE ===

    async showGoodsPage(goods, page, opLabel, operation) {
      const perPage = 15;
      if (operation === 'income') goods.push(['Новый товар…', ICON.new]);
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
      if (operation === 'income') prices.push(['Новая цена…', ICON.new]);
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

    async selectQty(editOrSend, operation, opLabel, opData, price) {
      const msg = `<b>${opLabel}: ${opData.product} по ${price} ₴.</b> Количество:`;
      const kbd = { reply_markup: { inline_keyboard: [[{text: '1', callback_data: 'qty_1'}, {text: '2', callback_data: 'qty_2'}, {text: '3', callback_data: 'qty_3'}], [{text: 'Другое…', callback_data: 'other'}]]}};
      messageId = await this[editOrSend](msg, kbd);
      await this.updateUserStep({ step: `${operation}_qty`, opts: {...opData, price, messageId} });
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

    const userName = body.message?.from?.first_name || WORD.noname;
    const chatId = message.chat.id;
    const text = body.message?.text.trim();
    let messageId = message.message_id;

    const settings = await getSettings();

    let ctx = {settings, chatId, messageId};
    let bot = createBotHandlers(ctx);

    const userData = await bot.getUser();
    if (!userData || userData[3] !== 'Active') {
      await bot.sendMessage(subMsg(settings.denyMsg, { name: userName}));
      return res.send('OK');
    }

    let todayDate = new Date(); // fallback
    if (message.date) todayDate = new Date(message.date * 1000);
    const today = formatDate(todayDate);

    const userStep = userData[4] || '';
    const opData   = userData[5] ? JSON.parse(userData[5]) : {};
    const saleDate = userData[6] || today;

    messageId = opData.messageId ?? '';
    ctx.messageId = messageId;
    bot = createBotHandlers(ctx);

    const [operation, stage, substage] = userStep.split('_');
    opLabel = OPS[operation]?.op || operation;
    console.log(`[DEBUG] table operation=${operation}|stage=${stage}|substage=${substage}; opLabel=${opLabel}`)

    const btnYes       = {text: `${ICON.ok} Да`,         callback_data: 'confirm'};
    const btnCancel    = {text: `${ICON.cancel} Отмена`, callback_data: 'cancel'};
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
          await bot.updateUserStep({ step: `${operation}_prices`, opts: { ...opData, product, page: 0 }});
        } else {
          await bot.editMessage(`<b>${opLabel}:</b>\n\nВведите название товара:`, kbdCancel);
          await bot.updateUserStep({ step: `${operation}_productnew`, opts: {...opData}});
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
          const prices = await bot.getPricesForProduct(opData.product);
          await bot.showPricesPage(opData.product, prices, page, opLabel, operation);
        }
        await bot.updateUserStep({ step: `${operation}_${stage}`, opts: { ...opData, page } });
        return res.send('OK');
      }

      // Price selected → select quantity || Price input
      if (stage === 'prices' && cbKey === 'price') {
        const price = Number(cbValue);
        if (price !== 'new') {
          await bot.selectQty('editMessage', operation, opLabel, opData, price);
        } else {
          await bot.editMessage(`<b>${opLabel}: ${opData.product}</b>\n\nВведите цену:`, kbdCancel);
          await bot.updateUserStep({ step: `${operation}_price_input`, opts: { ...opData } });
        }
        return res.send('OK');
      }

      // Quantity selection → confirmation
      if (stage === 'qty' && substage !== 'input') {
        let qty;
        if (cbKey === 'other') {
          const messageId = await bot.editMessage(`<b>${opLabel}: ${opData.product}</b> по <b>${opData.price}</b> ₴.\n\nВведите количество:`, kbdCancel);
          await bot.updateUserStep({ step: `${operation}_qty_input`, opts: { ...opData, messageId } });
          return res.send('OK');
        } else {
          qty = Number(cbValue);
        }

        const total = opData.price * qty;
        const messageId = await bot.editMessage(`${OPS[operation].prompt}\n<b>${opData.product} ${qty}</b> × <b>${opData.price}</b>\n\nВсё верно?`, kbdYesCancel);
        await bot.updateUserStep({ step: `${operation}_confirm`, opts: { ...opData, messageId, qty, total } });
        return res.send('OK');
      }

      // Final confirmation
      if (stage === 'confirm' && cbKey === 'confirm') {
        await bot.addToLog(saleDate, opLabel, opData.product, opData.qty, opData.price, opData.newprice);
        await bot.updateUserStep();  // reset
        await bot.editMessage(`${OPS[operation].saved}\n\n<b>${opData.product} ${opData.qty} × ${opData.newprice ? `<i>${opData.price}</i> → ${opData.newprice}` : `${opData.price}`}</b> = ${opData.price * opData.qty}\nДата: <b>${saleDate}</b>`);
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
      await bot.sendMessage(subMsg(settings.startMsg, { name: userName }), keyboard);
      return res.send('OK');

    } else if (opKey && ['sale', 'income', 'outcome', 'discount', 'return'].includes(opKey)) {
      console.log(`[DEBUG] Entering ${opKey}`);
      const goods = await getRange(settings.goodsSheet, 'A:B');
      const opLabel = OPS[opKey].op || opKey;
      const messageId = await bot.showGoodsPage(goods, 0, opLabel, opKey);  // get ID
      await bot.updateUserStep({ step: `${opKey}_goods`, opts: { page: 0, messageId } });  // save ID once

    } else if (text?.includes(ICON.seller)) {
      // part 1
      const lastDates = await getLastDates(settings);
      const text = `😘 Молодец

<b>Последние введённые операции:</b>
${ICON.oper1}${OPS.sale.op}......${lastDates[OPS.sale.op]}
${ICON.oper1}${OPS.income.op}.........${lastDates[OPS.income.op]}
${ICON.oper1}${OPS.outcome.op}.....${lastDates[OPS.outcome.op]}
${ICON.oper1}${OPS.discount.op}....${lastDates[OPS.discount.op]}
${ICON.oper1}${OPS.return.op}........${lastDates[OPS.return.op]}
`;
      await bot.sendMessage(text);

      // part 2
      const zp1 = await calculateSalary(settings, '12.2025');
      await bot.sendMessage(zp1);

      // part 3
      const now = new Date();
      const monthStr = `${(now.getMonth() + 1).toString().padStart(2, '0')}.${now.getFullYear()}`;
      const zp2 = await calculateSalary(settings, monthStr, true);
      await bot.sendMessage(zp2);

      return res.send('OK');

    } else if (opKey && opKey === 'report') {
      report = await generateReport(settings.openingBalance, saleDate, settings.logSheet);
      await bot.sendMessage(report);
      return res.send('OK');

    } else if (text?.includes(ICON.today) || text?.includes(ICON.day)) {
      const todayDate = new Date(today.split('.').reverse().join('-'));  // 09.11.2025 → 2025-11-09 = valid date string

      const yesterdayDate = new Date(todayDate);
      yesterdayDate.setDate(todayDate.getDate() - 1);
      const yesterday = formatDate(yesterdayDate);

      const dayBeforeDate = new Date(todayDate);
      dayBeforeDate.setDate(todayDate.getDate() - 2);
      const dayBefore = formatDate(dayBeforeDate);

      await bot.sendMessage('Выберите или введите дату:', {
        reply_markup: {
          keyboard: [[ { text: dayBefore }, { text: yesterday }, { text: WORD.today } ]],
          resize_keyboard: true
        }
      });
      await bot.updateUserStep({ step: 'date_enter' });
      return res.send('OK');

    } else if (stage === 'qty' && substage === 'input') {
      qty = Number(text);
      await bot.editMessageRmButtons();
      const total = opData.price * qty;
      messageId = await bot.sendMessage(`${OPS[operation].prompt}\n\n<b>${opData.product} ${qty}</b> × <b>${opData.price}</b>\n\nВсё верно?`, kbdYesCancel);
      await bot.updateUserStep({ step: `${operation}_confirm`, opts: { ...opData, messageId, qty, total } });
      return res.send('OK');

    } else if (stage === 'productnew') {
      product = text;
      await bot.editMessageRmButtons();
      messageId = await bot.sendMessage(`<b>${opLabel}: ${product}</b>\n\nВведите цену нового товара:`);
      await bot.updateUserStep({ step: `${operation}_price_input`, opts: { ...opData, product, messageId }});
      return res.send('OK');

    } else if (stage === 'price' && substage === 'input') {
      // Price entered → select quantity
      price = Number(text);
      await bot.editMessageRmButtons();
      await this.selectQty('sendMessage', operation, opLabel, opData, price);
    }

    if (operation === 'date' && stage === 'enter' && text) {
      const input = text === WORD.today ? today : text;
      const result = parseFlexibleDate(input, todayDate);

      if (result.valid) {
        await bot.updateUserStep({ saleDate: result.save });
        const keyboard = await getMainMenuKeyboard(result.formatted, today, settings.schedSheet);
        await bot.sendMessage(`Дата: <b>${result.formatted}</b>`, keyboard);
      } else {
        await bot.sendMessage(
          'Не понял дату. Введите:\n' +
          '• число этого месяца (например, <b>15</b>)\n' +
          '• день и месяц (<b>9.11</b>)\n' +
          '• полную дату (<b>22.11.25</b> или <b>22.11.2025</b>)\n' +
          'или нажмите кнопку с датой'
        );
      }
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
