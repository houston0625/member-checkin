// Apps Script 網頁應用程式網址。重新部署成新網址時，只要改這一行。
const API_URL = 'https://script.google.com/macros/s/AKfycbyms3iZC0hGQMBcVI9j_qnWQzBJdnqakSljOM_NoCoVVAQB0crMl7YUBtm6g9TemaHheg/exec';

// 與後端 Code.gs 的 MEMBER_ID_PATTERN 保持一致。
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

// 統計頁自動更新間隔（毫秒）。
const STATS_REFRESH_MS = 60 * 1000;
