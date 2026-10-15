# member-checkin
統計會員編號是否重複報到

## 頁面

| 檔案 | 用途 |
|---|---|
| `index.html` | 報到頁：輸入會員代號登記，顯示今日累積與本小時新增人數 |
| `stats.html` | 統計頁：逐小時新增／累積圖表、與前一天同時段比較、重複輸入次數。可用 `?date=yyyy-MM-dd` 查詢指定日期 |
| `admin.html` | 管理頁：輸入會員代號與管理密碼，刪除該會員的所有紀錄（頁面上沒有連結，請直接輸入網址） |

會員代號固定為 7 碼數字，開頭可以是 0（例如 `0012345`）；每個代號只能報到一次，不分日期。

## 結構

```
index.html        報到頁
stats.html        統計頁
css/style.css     共用樣式（支援深色模式）
js/config.js      API 網址與共用設定
js/api.js         呼叫 Apps Script 的共用函式
js/checkin.js     報到頁邏輯
js/stats.js       統計頁邏輯（圖表使用 Chart.js 4.4.1）
js/admin.js       管理頁邏輯（刪除會員）
img/logo.jpg      全盈+PAY Logo
apps-script/      後端程式碼與部署步驟
```

## 設定

Apps Script 重新部署成新網址時，只要修改 `js/config.js` 的 `API_URL`。

## 發佈到 GitHub Pages

1. 把這個資料夾推到 GitHub repo `member-checkin`。
2. repo 的 **Settings → Pages** → Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾選 `/ (root)` → Save。
3. 約一分鐘後，網址為 `https://<帳號>.github.io/member-checkin/`（報到頁），統計頁為 `.../stats.html`。
