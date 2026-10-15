/**
 * member-checkin 後端 API（綁定在 member-checkin 試算表上的 Apps Script）
 *
 * POST  { "action": "checkin", "memberId": "A0012" }   會員登記
 * GET   ?action=stats[&date=yyyy-MM-dd]                當日（或指定日期）統計
 *
 * 前端 fetch POST 時請用 Content-Type: text/plain，body 放 JSON 字串，避免 CORS preflight。
 */

const TZ = 'Asia/Taipei';
const SHEET_CHECKIN = '登入紀錄';
const SHEET_DUPLICATE = '重複嘗試';

// 會員代號允許的格式：英數字、底線、連字號，1 到 50 字。
// 不允許 = + @ 等開頭字元，避免寫入試算表時被當成公式。
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

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
    throw new ApiError_('UNKNOWN_ACTION', '不支援的動作：' + action);
  });
}

// ---------------------------------------------------------------------------
// 登記
// ---------------------------------------------------------------------------

function checkin_(rawMemberId) {
  const memberId = String(rawMemberId == null ? '' : rawMemberId).trim();
  if (!MEMBER_ID_PATTERN.test(memberId)) {
    throw new ApiError_('INVALID_MEMBER_ID', '會員代號格式不正確');
  }

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

    // 同一個日曆日（台北時間）只能成功登記一次。
    // 往回掃到日期早於今天就停止，掃到的就是今天全部紀錄，順便拿來算人數。
    const todayRows = collectRows_(checkinSheet, today, today);
    const existing = findEarliest_(todayRows, memberId);

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
  let returning = null;
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

    const prevIds = {};
    prevRows.forEach(function (r) { prevIds[r.id] = true; });
    returning = countDistinct_(dayRows.filter(function (r) { return prevIds[r.id]; }));
  }

  const duplicateAttempts = collectRows_(getSheet_(ss, SHEET_DUPLICATE), date, date).length;

  return {
    date: date,
    isToday: isToday,
    generatedAt: formatIso_(now),
    total: dayRows.length,
    hours: buildHours_(dayRows, lastHour),
    previousDay: previousDay,
    returning: returning,
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

function findEarliest_(rows, memberId) {
  let found = null;
  rows.forEach(function (r) {
    if (r.id === memberId && (!found || r.time < found.time)) found = r;
  });
  return found;
}

function countDistinct_(rows) {
  const seen = {};
  rows.forEach(function (r) { seen[r.id] = true; });
  return Object.keys(seen).length;
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

  console.log('設定完成：時區 ' + ss.getSpreadsheetTimeZone());
}
