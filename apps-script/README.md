# Apps Script 部署步驟

API 規格請見上層資料夾的 `需求規格.md` 第 4.1 節。

## 1. 貼上程式碼

1. 開啟 `member-checkin` 試算表 → **擴充功能 → Apps Script**。
2. 把 `Code.gs` 的內容貼到編輯器的 `程式碼.gs`（覆蓋原本內容）。
3. **專案設定（齒輪）** → 勾選「在編輯器中顯示 appsscript.json 資訊清單檔案」，再把 `appsscript.json` 的內容貼進去。

## 2. 執行初始設定

1. 在編輯器上方的函式選單選 `setup` → **執行**。
2. 第一次執行會要求授權，用你自己的帳號同意即可（權限只涵蓋這份試算表）。
3. 執行紀錄出現「設定完成：時區 Asia/Taipei」就完成了。它會：
   - 把試算表時區設為台北
   - 把兩張工作表的 A 欄設為純文字，時間欄設為日期時間格式
   - 檢查標題列是否正確，不正確時會顯示錯誤

## 3. 設定管理密碼（刪除功能用）

1. **專案設定（齒輪）→ 指令碼屬性 → 新增指令碼屬性**。
2. 屬性：`ADMIN_KEY`，值：自訂一組夠長的密碼（建議 16 字以上）。
3. 管理頁 `admin.html` 刪除會員時要輸入這組密碼。沒有設定時，刪除功能會回傳錯誤。

每次刪除都會記到「刪除紀錄」工作表（第一次刪除或執行 `setup` 時自動建立）。

## 4. 部署成網頁應用程式

1. **部署 → 新增部署作業** → 類型選「網頁應用程式」。
2. 執行身分：**我**；誰可以存取：**所有人**。
3. 部署後複製 `/exec` 結尾的網址，前端會用到。

之後修改程式時，請用 **部署 → 管理部署作業 → 編輯 → 版本選「新版本」**，網址才不會改變。

## 5. 快速測試

在瀏覽器開啟（把網址換成你的 `/exec` 網址）：

```
https://script.google.com/macros/s/XXXX/exec?action=stats
```

應該看到 `{"ok":true,"date":"...","total":0,...}`。

測試登記可以在瀏覽器的開發者工具 Console 執行：

```js
fetch('https://script.google.com/macros/s/XXXX/exec', {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({ action: 'checkin', memberId: '0000001' })
}).then(r => r.json()).then(console.log);
```

測試完可以在 `admin.html` 刪掉 `0000001` 的紀錄。
