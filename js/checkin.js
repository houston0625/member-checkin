(function () {
  const form = document.getElementById('checkin-form');
  const input = document.getElementById('member-id');
  const button = document.getElementById('submit-btn');
  const result = document.getElementById('result');
  const totalEl = document.getElementById('total');
  const hourNewEl = document.getElementById('hour-new');
  const hourLabelEl = document.getElementById('hour-label');
  const dateEl = document.getElementById('today-date');

  let submitting = false;
  // 最後一次套用的伺服器時間；較舊的回應（例如晚回來的統計）不覆蓋較新的數字。
  let lastServerTime = '';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;

    const memberId = input.value.trim();
    if (!memberId) {
      showResult('error', '請輸入會員代號');
      input.focus();
      return;
    }
    if (!MEMBER_ID_PATTERN.test(memberId)) {
      showResult('error', '會員代號格式不正確', '只能包含英文字母、數字、底線或連字號');
      input.select();
      return;
    }

    setSubmitting(true);
    try {
      const data = await Api.checkin(memberId);
      if (data.status === 'success') {
        showResult('success', `${memberId} 報到成功`, `報到時間 ${timeOfIso(data.checkinTime)}`);
      } else {
        showResult('duplicate', `${memberId} 今天已經報到過了`,
          `今天的報到時間是 ${timeOfIso(data.lastCheckinTime)}，不需要再輸入`);
      }
      updateCounts(data.today, data.checkinTime);
      input.value = '';
    } catch (err) {
      showResult('error', '報到失敗', err.message);
    } finally {
      setSubmitting(false);
      input.focus();
    }
  });

  function setSubmitting(value) {
    submitting = value;
    button.disabled = value;
    button.textContent = value ? '送出中…' : '確認';
  }

  function showResult(type, title, detail) {
    result.className = `result ${type}`;
    result.textContent = title;
    if (detail) {
      const small = document.createElement('small');
      small.textContent = detail;
      result.appendChild(small);
    }
    result.hidden = false;
  }

  function updateCounts(today, serverTime) {
    if (serverTime < lastServerTime) return;
    lastServerTime = serverTime;
    dateEl.textContent = today.date;
    totalEl.textContent = today.total.toLocaleString();
    hourNewEl.textContent = today.hourNew.toLocaleString();
    hourLabelEl.textContent = hourRange(today.hour);
  }

  async function refreshCounts() {
    if (document.hidden) return;
    try {
      const stats = await Api.stats();
      const current = stats.hours[stats.hours.length - 1];
      updateCounts({
        date: stats.date,
        total: stats.total,
        hour: current.hour,
        hourNew: current.new
      }, stats.generatedAt);
    } catch (err) {
      // 人數只是輔助資訊，讀取失敗不打擾報到流程，下次再試。
      console.warn('讀取人數失敗：', err.message);
    }
  }

  // 多台報到機同時使用時，定期同步人數。
  refreshCounts();
  setInterval(refreshCounts, STATS_REFRESH_MS);
  document.addEventListener('visibilitychange', refreshCounts);
})();
