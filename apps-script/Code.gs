/**
 * member-checkin 後端 API（綁定在 member-checkin 試算表上的 Apps Script）
 *
 * POST  { "action": "checkin", "memberId": "0012345" }                     會員登記
 * POST  { "action": "delete", "memberId": "0012345", "adminKey": "..." }   刪除指定會員的紀錄
 * GET   ?action=stats[&date=yyyy-MM-dd]                                    當日（或指定日期）統計
 *
 * 前端 fetch POST 時請用 Content-Type: text/plain，body 放 JSON 字串，避免 CORS preflight。
 */

const TZ = 'Asia/Taipei';
const SHEET_CHECKIN = '登入紀錄';
const SHEET_DUPLICATE = '重複嘗試';
const SHEET_DELETED = '刪除紀錄';

// 會員代號固定 7 碼數字，開頭可以是 0（例如 0012345）。
// 一律當成字串處理，寫入試算表時 A 欄設成純文字，開頭的 0 才不會消失。
const MEMBER_ID_PATTERN = /^\d{7}$/;

// 管理密碼存在「專案設定 → 指令碼屬性」，名稱為 ADMIN_KEY，不寫在程式碼裡。
const ADMIN_KEY_PROPERTY = 'ADMIN_KEY';

const LOCK_TIMEOUT_MS = 10000;
const SCAN_CHUNK_ROWS = 500;

// ---------------------------------------------------------------------------
// 網頁應用程式入口
// ---------------------------------------------------------------------------

function doGet(e) {
  return handle_(function () {
    const params = (e && e.parameter) || {};
    const action = params.action || 'stats';
    if (action === 'stats') return stats_(params.date);
    throw new ApiError_('UNKNOWN_ACTION', '不支援的動作：' + action);
  });
}

function doPost(e) {
  return handle_(function () {
    const body = parseBody_(e);
    const action = body.action || 'checkin';
    if (action === 'checkin') return checkin_(body.memberId);
    if (action === 'delete') return deleteMember_(body.memberId, body.adminKey);
    throw new ApiError_('UNKNOWN_ACTION', '不支援的動作：' + action);
  });
}

// ---------------------------------------------------------------------------
// 登記
// ---------------------------------------------------------------------------

function checkin_(rawMemberId) {
  const memberId = parseMemberId_(rawMemberId);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw new ApiError_('BUSY', '系統忙碌中，請稍後再試');
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const checkinSheet = getSheet_(ss, SHEET_CHECKIN);

    const now = new Date();
    const today = formatDate_(now);
    const hour = Number(Utilities.formatDate(now, TZ, 'H'));

    // 每個會員代號只能成功登記一次，不分日期。
    // 用 TextFinder 搜尋整個 A 欄，由上往下找到的第一筆就是最早的登記。
    const existing = findFirstCheckin_(checkinSheet, memberId);

    // 今天的紀錄只用來算人數。
    const todayRows = collectRows_(checkinSheet, today, today);

    let status;
    let lastCheckinTime = null;
    let total = todayRows.length;
    let hourNew = todayRows.filter(function (r) { return r.hour === hour; }).length;

    if (existing) {
      status = 'duplicate';
      lastCheckinTime = formatIso_(existing.time);
      appendRow_(getSheet_(ss, SHEET_DUPLICATE), [memberId, now, existing.time]);
    } else {
      status = 'success';
      appendRow_(checkinSheet, [memberId, now, today, hour]);
      total += 1;
      hourNew += 1;
    }

    // 釋放鎖之前先把寫入送出，下一個請求才讀得到這筆資料。
    SpreadsheetApp.flush();

    return {
      status: status,
      checkinTime: formatIso_(now),
      lastCheckinTime: lastCheckinTime,
      today: { date: today, hour: hour, hourNew: hourNew, total: total }
    };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 刪除指定會員
// ---------------------------------------------------------------------------

/**
 * 刪除該會員代號在「登入紀錄」與「重複嘗試」的所有資料，刪除後可以重新報到。
 * 每次刪除都會記到「刪除紀錄」工作表，方便事後查核。
 */
function deleteMember_(rawMemberId, adminKey) {
  checkAdminKey_(adminKey);
  const memberId = parseMemberId_(rawMemberId);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw new ApiError_('BUSY', '系統忙碌中，請稍後再試');
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const checkinSheet = getSheet_(ss, SHEET_CHECKIN);
    const duplicateSheet = getSheet_(ss, SHEET_DUPLICATE);

    const checkinRows = findMemberRows_(checkinSheet, memberId);
    const duplicateRows = findMemberRows_(duplicateSheet, memberId);
    if (checkinRows.length === 0 && duplicateRows.length === 0) {
      throw new ApiError_('NOT_FOUND', '找不到會員代號 ' + memberId + ' 的紀錄');
    }

    deleteRows_(checkinSheet, checkinRows);
    deleteRows_(duplicateSheet, duplicateRows);
    appendRow_(getOrCreateDeletedSheet_(ss), [memberId, new Date(), checkinRows.length, duplicateRows.length]);

    SpreadsheetApp.flush();

    return {
      memberId: memberId,
      deleted: { checkin: checkinRows.length, duplicate: duplicateRows.length }
    };
  } finally {
    lock.releaseLock();
  }
}

function checkAdminKey_(adminKey) {
  const expected = PropertiesService.getScriptProperties().getProperty(ADMIN_KEY_PROPERTY);
  if (!expected) {
    throw new ApiError_('ADMIN_NOT_CONFIGURED', '尚未設定管理密碼，請在指令碼屬性新增 ' + ADMIN_KEY_PROPERTY);
  }
  if (String(adminKey == null ? '' : adminKey) !== expected) {
    // 稍微延遲，降低被暴力猜密碼的速度。
    Utilities.sleep(1000);
    throw new ApiError_('UNAUTHORIZED', '管理密碼不正確');
  }
}

/** 回傳 A 欄完全等於 memberId 的列號（由小到大）。 */
function findMemberRows_(sheet, memberId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(memberId)
    .matchCase(true)
    .matchEntireCell(true)
    .findAll()
    .map(function (range) { return range.getRow(); });
}

/** 從最下面一列開始刪，前面的列號才不會跑掉。 */
function deleteRows_(sheet, rows) {
  rows.slice().sort(function (a, b) { return b - a; }).forEach(function (row) {
    sheet.deleteRow(row);
  });
}

// ---------------------------------------------------------------------------
// 統計
// ---------------------------------------------------------------------------

function stats_(rawDate) {
  const now = new Date();
  const today = formatDate_(now);
  const date = rawDate ? String(rawDate) : today;

  if (!isValidDateString_(date)) {
    throw new ApiError_('INVALID_DATE', '日期格式應為 yyyy-MM-dd');
  }
  if (date > today) {
    throw new ApiError_('INVALID_DATE', '不能查詢未來的日期');
  }

  const isToday = date === today;
  const prevDate = shiftDate_(date, -1);
  // 今天只統計到目前這個小時；過去的日期統計整天。
  const lastHour = isToday ? Number(Utilities.formatDate(now, TZ, 'H')) : 23;
  const nowTimeOfDay = Utilities.formatDate(now, TZ, 'HH:mm:ss');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = collectRows_(getSheet_(ss, SHEET_CHECKIN), prevDate, date);
  const dayRows = rows.filter(function (r) { return r.date === date; });
  const prevRows = rows.filter(function (r) { return r.date === prevDate; });

  let previousDay = null;
  if (prevRows.length > 0) {
    const sameTimeCumulative = isToday
      ? prevRows.filter(function (r) { return r.timeOfDay <= nowTimeOfDay; }).length
      : prevRows.length;
    previousDay = {
      date: prevDate,
      total: prevRows.length,
      sameTimeCumulative: sameTimeCumulative,
      hours: buildHours_(prevRows, 23)
    };
  }

  const duplicateAttempts = collectRows_(getSheet_(ss, SHEET_DUPLICATE), date, date).length;

  return {
    date: date,
    isToday: isToday,
    generatedAt: formatIso_(now),
    total: dayRows.length,
    hours: buildHours_(dayRows, lastHour),
    previousDay: previousDay,
    duplicateAttempts: duplicateAttempts
  };
}

/** 產生 0 點到 lastHour 每小時的新增與累積人數。 */
function buildHours_(rows, lastHour) {
  const counts = [];
  for (let h = 0; h <= lastHour; h++) counts.push(0);
  rows.forEach(function (r) {
    if (r.hour <= lastHour) counts[r.hour] += 1;
  });

  let cumulative = 0;
  return counts.map(function (n, h) {
    cumulative += n;
    return { hour: h, new: n, cumulative: cumulative };
  });
}

// ---------------------------------------------------------------------------
// 試算表讀寫
// ---------------------------------------------------------------------------

/**
 * 從最後一列往回讀 A、B 欄，收集日期落在 fromDate 到 toDate（含）之間的紀錄。
 * 讀到日期早於 fromDate 就停止，不掃描整張表。
 * 日期與小時一律由 B 欄時間戳記換算成台北時間，不依賴 C、D 欄。
 */
function collectRows_(sheet, fromDate, toDate) {
  const result = [];
  let end = sheet.getLastRow();

  while (end >= 2) {
    const start = Math.max(2, end - SCAN_CHUNK_ROWS + 1);
    const values = sheet.getRange(start, 1, end - start + 1, 2).getValues();

    for (let i = values.length - 1; i >= 0; i--) {
      const time = values[i][1];
      if (!(time instanceof Date) || isNaN(time.getTime())) continue;

      const date = formatDate_(time);
      if (date < fromDate) return result;
      if (date > toDate) continue;

      result.push({
        id: String(values[i][0]).trim(),
        time: time,
        date: date,
        hour: Number(Utilities.formatDate(time, TZ, 'H')),
        timeOfDay: Utilities.formatDate(time, TZ, 'HH:mm:ss')
      });
    }
    end = start - 1;
  }
  return result;
}

/** 找出該會員最早一筆成功登記；沒有登記過時回傳 null。 */
function findFirstCheckin_(sheet, memberId) {
  const rows = findMemberRows_(sheet, memberId);
  for (let i = 0; i < rows.length; i++) {
    const time = sheet.getRange(rows[i], 2).getValue();
    if (time instanceof Date && !isNaN(time.getTime())) return { row: rows[i], time: time };
  }
  return null;
}

/** 在最後一列之後寫入一列；A 欄先設成純文字，保留開頭的 0。 */
function appendRow_(sheet, rowValues) {
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1).setNumberFormat('@');
  sheet.getRange(row, 1, 1, rowValues.length).setValues([rowValues]);
}

function getSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('找不到工作表：' + name);
  return sheet;
}

/** 「刪除紀錄」工作表不存在時自動建立。 */
function getOrCreateDeletedSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_DELETED);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_DELETED);
    sheet.getRange(1, 1, 1, 4).setValues([['會員代號', '刪除時間', '刪除登入紀錄筆數', '刪除重複嘗試筆數']]);
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.getRange('B:B').setNumberFormat('yyyy-MM-dd HH:mm:ss');
  }
  return sheet;
}

// ---------------------------------------------------------------------------
// 共用工具
// ---------------------------------------------------------------------------

function ApiError_(code, message) {
  this.code = code;
  this.message = message;
}

function handle_(fn) {
  let payload;
  try {
    payload = Object.assign({ ok: true }, fn());
  } catch (err) {
    if (err instanceof ApiError_) {
      payload = { ok: false, error: err.code, message: err.message };
    } else {
      console.error(err && err.stack ? err.stack : err);
      payload = { ok: false, error: 'SERVER_ERROR', message: '伺服器發生錯誤，請稍後再試' };
    }
  }
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseBody_(e) {
  const contents = e && e.postData && e.postData.contents;
  if (contents) {
    try {
      return JSON.parse(contents);
    } catch (err) {
      // 不是 JSON 時改用表單參數
    }
  }
  return (e && e.parameter) || {};
}

/** 去掉空白並驗證格式。不轉成數字，保留開頭的 0。 */
function parseMemberId_(raw) {
  const memberId = String(raw == null ? '' : raw).replace(/\s+/g, '');
  if (!MEMBER_ID_PATTERN.test(memberId)) {
    throw new ApiError_('INVALID_MEMBER_ID', '會員代號必須是 7 碼數字');
  }
  return memberId;
}

function formatDate_(date) {
  return Utilities.formatDate(date, TZ, 'yyyy-MM-dd');
}

function formatIso_(date) {
  return Utilities.formatDate(date, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function isValidDateString_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00+08:00');
  return !isNaN(d.getTime()) && formatDate_(d) === s;
}

/** 台北沒有日光節約時間，直接加減 24 小時即可。 */
function shiftDate_(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00+08:00');
  return formatDate_(new Date(d.getTime() + days * 86400000));
}

// ---------------------------------------------------------------------------
// 初始設定：在 Apps Script 編輯器手動執行一次
// ---------------------------------------------------------------------------

/**
 * 設定試算表時區、兩張工作表的 A 欄純文字格式，並檢查標題列。
 * 也會建立「刪除紀錄」工作表，並提醒是否已設定管理密碼。
 * 只會在編輯器手動執行，網頁應用程式無法呼叫。
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);

  const specs = [
    { name: SHEET_CHECKIN, headers: ['會員代號', '登入時間', '日期', '小時'],
      formats: ['@', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd', '0'] },
    { name: SHEET_DUPLICATE, headers: ['會員代號', '嘗試時間', '上次成功登記時間'],
      formats: ['@', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm:ss'] }
  ];

  specs.forEach(function (spec) {
    const sheet = getSheet_(ss, spec.name);
    const actual = sheet.getRange(1, 1, 1, spec.headers.length).getValues()[0];
    if (actual.join('|') !== spec.headers.join('|')) {
      throw new Error(spec.name + ' 標題列應為：' + spec.headers.join('、') +
        '，目前是：' + actual.join('、'));
    }
    if (sheet.getMaxRows() < 2) sheet.insertRowsAfter(1, 1);
    spec.formats.forEach(function (format, i) {
      sheet.getRange(2, i + 1, sheet.getMaxRows() - 1, 1).setNumberFormat(format);
    });
  });

  getOrCreateDeletedSheet_(ss);

  if (!PropertiesService.getScriptProperties().getProperty(ADMIN_KEY_PROPERTY)) {
    console.warn('尚未設定管理密碼：請到「專案設定 → 指令碼屬性」新增 ' + ADMIN_KEY_PROPERTY +
      '，否則無法使用刪除功能。');
  }

  console.log('設定完成：時區 ' + ss.getSpreadsheetTimeZone());
}
