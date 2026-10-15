# member-checkin
統計會員編號是否重複報到

## 頁面

| 檔案 | 用途 |
|---|---|
| `index.html` | 報到頁：輸入會員代號登記，顯示今日累積與本小時新增人數 |
| `stats.html` | 統計頁：逐小時新增／累積圖表、與前一天同時段比較、兩天都報到人數、重複輸入次數。可用 `?date=yyyy-MM-dd` 查詢指定日期 |

## 結構

```
index.html        報到頁
stats.html        統計頁
css/style.css     共用樣式（支援深色模式）
js/config.js      API 網址與共用設定
js/api.js         呼叫 Apps Script 的共用函式
js/checkin.js     報到頁邏輯
js/stats.js       統計頁邏輯（圖表使用 Chart.js 4.4.1）
apps-script/      後端程式碼與部署步驟
```

## 設定

Apps Script 重新部署成新網址時，只要修改 `js/config.js` 的 `API_URL`。

## 發佈到 GitHub Pages

1. 把這個資料夾推到 GitHub repo `member-checkin`。
2. repo 的 **Settings → Pages** → Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾選 `/ (root)` → Save。
3. 約一分鐘後，網址為 `https://<帳號>.github.io/member-checkin/`（報到頁），統計頁為 `.../stats.html`。
