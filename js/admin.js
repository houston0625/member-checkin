(function () {
  const form = document.getElementById('delete-form');
  const idInput = document.getElementById('member-id');
  const keyInput = document.getElementById('admin-key');
  const button = document.getElementById('submit-btn');
  const result = document.getElementById('result');

  let submitting = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;

    const memberId = normalizeMemberId(idInput.value);
    const adminKey = keyInput.value;
    if (!MEMBER_ID_PATTERN.test(memberId)) {
      showResult('error', '會員代號格式不正確', '會員代號必須是 7 碼數字，開頭的 0 也要輸入');
      idInput.select();
      return;
    }
    if (!adminKey) {
      showResult('error', '請輸入管理密碼');
      keyInput.focus();
      return;
    }
    if (!confirm(`確定要刪除 ${memberId} 的所有報到紀錄嗎？刪除後無法復原。`)) return;

    setSubmitting(true);
    try {
      const data = await Api.deleteMember(memberId, adminKey);
      showResult('success', `已刪除 ${memberId}`,
        `報到紀錄 ${data.deleted.checkin} 筆、重複嘗試 ${data.deleted.duplicate} 筆`);
      idInput.value = '';
      idInput.focus();
    } catch (err) {
      showResult('error', '刪除失敗', err.message);
      if (err.code === 'UNAUTHORIZED') keyInput.select();
    } finally {
      setSubmitting(false);
    }
  });

  function setSubmitting(value) {
    submitting = value;
    button.disabled = value;
    button.textContent = value ? '刪除中…' : '刪除';
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
})();
