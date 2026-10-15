// 呼叫 Apps Script API。失敗時一律丟出 ApiError，前端只要處理一種錯誤。

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const Api = {
  TIMEOUT_MS: 20000,

  async request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw new ApiError('TIMEOUT', '連線逾時，請再試一次');
      throw new ApiError('NETWORK', '無法連線，請檢查網路後再試一次');
    } finally {
      clearTimeout(timer);
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new ApiError('BAD_RESPONSE', '伺服器回應異常，請稍後再試');
    }
    if (!data.ok) throw new ApiError(data.error || 'UNKNOWN', data.message || '發生未知錯誤');
    return data;
  },

  /** 登記會員代號。用 text/plain 送出 JSON，避免 CORS preflight。 */
  checkin(memberId) {
    return this.request(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'checkin', memberId })
    });
  },

  /** 刪除指定會員的報到與重複嘗試紀錄，需要管理密碼。 */
  deleteMember(memberId, adminKey) {
    return this.request(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'delete', memberId, adminKey })
    });
  },

  /** 取得統計；date 省略時為今天，格式 yyyy-MM-dd。 */
  stats(date) {
    const params = new URLSearchParams({ action: 'stats' });
    if (date) params.set('date', date);
    return this.request(`${API_URL}?${params}`, { method: 'GET' });
  }
};

/** "2026-10-16T08:15:00+08:00" → "08:15:00"，直接取字串，不受瀏覽器時區影響。 */
function timeOfIso(iso) {
  return iso ? iso.slice(11, 19) : '';
}

/** "2026-10-16T08:15:00+08:00" → "2026-10-16 08:15:00" */
function dateTimeOfIso(iso) {
  return iso ? `${iso.slice(0, 10)} ${timeOfIso(iso)}` : '';
}

/** 去掉空白並把全形數字轉成半形，避免輸入法造成格式錯誤。 */
function normalizeMemberId(value) {
  return String(value)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '');
}

function hourRange(hour) {
  const h = String(hour).padStart(2, '0');
  return `${h}:00–${h}:59`;
}
