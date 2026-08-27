const DATA_SHEET = '_APP_DATA';
const SETTINGS_SHEET = 'Настройки';
const SPREADSHEET_ID = '1ytbVpVu69r0eShULxmHea0u_wZm6Jqb42ZZLp6_Ptgs';

function book_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function setup() {
  const properties = PropertiesService.getScriptProperties();
  let token = properties.getProperty('APP_TOKEN');
  if (!token) {
    token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    properties.setProperty('APP_TOKEN', token);
  }
  const settings = book_().getSheetByName(SETTINGS_SHEET) || book_().insertSheet(SETTINGS_SHEET);
  settings.getRange('A6:B6').setValues([['Ключ синхронизации', token]]);
  settings.hideColumns(2);
  dataSheet_();
  return 'Готово';
}

function authorize_(event) {
  const expected = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  const received = event && event.parameter && event.parameter.token;
  if (!expected || received !== expected) throw new Error('Unauthorized');
}

function dataSheet_() {
  const book = book_();
  let sheet = book.getSheetByName(DATA_SHEET);
  if (!sheet) {
    sheet = book.insertSheet(DATA_SHEET);
    sheet.hideSheet();
    sheet.getRange('A1:B1').setValues([['updatedAt', 'payload']]);
  }
  return sheet;
}

function readPayload_() {
  const raw = dataSheet_().getRange('B2').getValue();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function time_(value) {
  const result = Date.parse(value || 0);
  return Number.isFinite(result) ? result : 0;
}

function mergePayload_(cloud, incoming) {
  const deleted = new Map();
  [...(cloud.deletedItems || []), ...(incoming.deletedItems || [])].forEach(entry => {
    const old = deleted.get(String(entry.id));
    if (!old || time_(entry.updatedAt) > time_(old.updatedAt)) deleted.set(String(entry.id), entry);
  });
  const items = new Map();
  [...(cloud.items || []), ...(incoming.items || [])].forEach(item => {
    const id = String(item.id);
    const old = items.get(id);
    if (!old || time_(item.updatedAt) >= time_(old.updatedAt)) items.set(id, item);
  });
  deleted.forEach((entry, id) => {
    const item = items.get(id);
    if (!item || time_(entry.updatedAt) >= time_(item.updatedAt)) items.delete(id);
  });
  const financeIsNewer = time_(incoming.financeUpdatedAt) >= time_(cloud.financeUpdatedAt);
  const categoriesAreNewer = time_(incoming.categoriesUpdatedAt) >= time_(cloud.categoriesUpdatedAt);
  return {
    version: 5,
    revision: Number(cloud.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
    items: [...items.values()],
    deletedItems: [...deleted.values()],
    finance: financeIsNewer ? (incoming.finance || cloud.finance || {}) : (cloud.finance || incoming.finance || {}),
    financeUpdatedAt: financeIsNewer ? incoming.financeUpdatedAt : cloud.financeUpdatedAt,
    categories: categoriesAreNewer ? (incoming.categories || cloud.categories || []) : (cloud.categories || incoming.categories || []),
    categoriesUpdatedAt: categoriesAreNewer ? incoming.categoriesUpdatedAt : cloud.categoriesUpdatedAt,
    activity: [...(cloud.activity || []), ...(incoming.activity || [])].slice(-250)
  };
}

function syncVisibleSheets_(payload) {
  const book = book_();
  const incomes = book.getSheetByName('Доходы') || book.insertSheet('Доходы');
  const headers = ['ID', 'Месяц учёта', 'Наименование', 'Категория', 'Сумма', 'Статус', 'Дата получения', 'Владелец', 'Обновлено'];
  const rows = (payload.items || []).slice().sort((a, b) =>
    String(a.month).localeCompare(String(b.month)) || Number(a.order || 0) - Number(b.order || 0)
  ).map(item => [
    String(item.id), item.month || '', item.name || '', item.category || '', Number(item.amount || 0),
    item.status === 'received' ? 'Получен' : 'Ожидается', item.date || '', item.owner || 'Антон', item.updatedAt || ''
  ]);
  incomes.getRange(1, 1, 1, headers.length).setValues([headers]);
  const oldRows = Math.max(incomes.getLastRow() - 1, 0);
  if (oldRows) incomes.getRange(2, 1, oldRows, headers.length).clearContent();
  if (rows.length) incomes.getRange(2, 1, rows.length, headers.length).setValues(rows);
  incomes.setFrozenRows(1);
  incomes.hideGridlines();
  incomes.getRange('E:E').setNumberFormat('#,##0 [$₽-ru-RU]');
  incomes.getRange('A1:I1').setBackground('#173a29').setFontColor('#ffffff').setFontWeight('bold');

  const categories = book.getSheetByName('Категории') || book.insertSheet('Категории');
  const categoryRows = (payload.categories || []).map(value => [value]);
  categories.getRange('A1').setValue('Категория').setBackground('#173a29').setFontColor('#ffffff').setFontWeight('bold');
  const oldCategories = Math.max(categories.getLastRow() - 1, 0);
  if (oldCategories) categories.getRange(2, 1, oldCategories, 1).clearContent();
  if (categoryRows.length) categories.getRange(2, 1, categoryRows.length, 1).setValues(categoryRows);

  const finances = book.getSheetByName('Финансы') || book.insertSheet('Финансы');
  const finance = payload.finance || {};
  const loanRows = Array.isArray(finance.loans) && finance.loans.length
    ? finance.loans.map(loan => [
        loan.status === 'archived' ? 'Архив' : 'Кредит',
        loan.name || 'Кредит',
        Number(loan.currentBalance || 0),
        Number(loan.annualRate || 0),
        Number(loan.monthlyPayment || 0),
        loan.nextPaymentDate || '',
        (loan.transactions || []).filter(tx => tx.type === 'prepayment').reduce((sum, tx) => sum + Number(tx.amount || 0), 0),
        loan.updatedAt || payload.financeUpdatedAt || ''
      ])
    : [
        ['Кредит', 'Ипотека', Number(finance.mortgageDebt || 0), '', '', '', (finance.mortgageEarlyPayments || []).reduce((sum, item) => sum + Number(item.amount || 0), 0), payload.financeUpdatedAt || ''],
        ...(finance.credits || []).map(credit => ['Кредит', credit.name || 'Кредит', Number(credit.debt || 0), '', '', '', (credit.earlyPayments || []).reduce((sum, item) => sum + Number(item.amount || 0), 0), payload.financeUpdatedAt || ''])
      ].filter(row => row[2] || row[6]);
  const financeRows = [
    ['Раздел', 'Название', 'Сумма', 'Ставка', 'Платёж', 'Дата платежа', 'Досрочно', 'Обновлено'],
    ['Сейф', 'Сейф', Number(finance.safe || 0), '', '', '', '', payload.financeUpdatedAt || ''],
    ...loanRows
  ];
  finances.clearContents();
  finances.getRange(1, 1, financeRows.length, 8).setValues(financeRows);
  finances.getRange('C:C').setNumberFormat('#,##0 [$₽-ru-RU]');
  finances.getRange('E:E').setNumberFormat('#,##0 [$₽-ru-RU]');
  finances.getRange('G:G').setNumberFormat('#,##0 [$₽-ru-RU]');
  finances.getRange('A1:H1').setBackground('#173a29').setFontColor('#ffffff').setFontWeight('bold');
  finances.setFrozenRows(1);
  finances.hideGridlines();
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(event) {
  try {
    authorize_(event);
    return json_(readPayload_());
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  }
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  try {
    authorize_(event);
    lock.waitLock(15000);
    const incoming = JSON.parse(event.postData.contents || '{}');
    const merged = mergePayload_(readPayload_(), incoming);
    dataSheet_().getRange('A2:B2').setValues([[new Date(), JSON.stringify(merged)]]);
    syncVisibleSheets_(merged);
    return json_({ ok: true, revision: merged.revision, payload: merged });
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}
