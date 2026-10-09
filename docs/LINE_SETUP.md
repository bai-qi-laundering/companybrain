# LINE 公司秘書：多人、附件、歷史查詢與提醒

本指南適用 NAS 正式版本。管理層加入官方 LINE 後，每個人都可記錄、建立待辦及查詢同一份公司資料，不必登入 LINE Developers，也不必逐一填個人 ID。所有成員享有相同查詢權限，未按秘書、老闆、人事或經理分隔資料。只處理與官方帳號的一對一訊息，不處理群組。

## 更新目前的 NAS

1. 先執行現有的 `companybrain-backup` 任務。
2. 從 GitHub 下載新版 ZIP，覆蓋 NAS 的 `backend` 資料夾、`index.html`、`compose.yaml` 和說明文件。保留 `settings.env`、`.env`、`backups` 及資料庫 volume。
3. 沿用原本的 Channel Secret、Channel Access Token、Gemini Key、HTTPS 網址；不必改既有 webhook 或 Tailscale。
4. 執行現有的 `companybrain-start` 任務，等待 app、db 都持續運行。網頁按 Ctrl＋F5。
5. 每位管理層加入好友後傳一次「說明」。已經加入的人也傳一次，系統才能登記他的通知收件人 ID。

新版預設 `LINE_ACCESS_MODE=friends`。現有 `LINE_ALLOWED_USER_IDS` 即使只有一個人也不再限制其他朋友。第一次設定 LINE 時，在 `settings.env` 填：

```dotenv
LINE_CHANNEL_SECRET=你現有的ChannelSecret
LINE_CHANNEL_ACCESS_TOKEN=你現有的長效Token
```

以下可選設定未填就使用預設值，不需要為這次更新另外貼上：

```dotenv
LINE_ACCESS_MODE=friends
LINE_REMINDERS_ENABLED=true
LINE_REMINDER_HOUR=8
LINE_PUSH_FALLBACK=true
```

如需日後改回指定使用者，設 `LINE_ACCESS_MODE=allowlist`，並在 `LINE_ALLOWED_USER_IDS` 用逗號分隔 U 開頭 ID。設定變更後重新執行啟動任務。金鑰與 Token 只保存在 NAS。

Webhook 沿用：

```text
https://fileserver.tailbb066f.ts.net:10000/api/line/webhook
```

在 LINE Developers 的 Messaging API 啟用 Use webhook；可啟用 Webhook redelivery。官方帳號後台關閉一般自動回覆，以免與秘書混淆。

## 記錄與詢問

| 傳送內容 | 行為 |
| --- | --- |
| `2026/10/9 紀錄百麒人事：王小姐到職，職務為秘書。` | 新增公司紀錄，保留提交人 |
| `請提醒我明天確認設備報價` | 新增待辦 |
| `日航今年有沒有客訴？` | 搜尋既有歷史，再由 AI 回答並附來源 |
| `查詢百麒人事資料` | 查詢共用資料；不另存一筆紀錄 |
| `查看到期` | 立即查看今日到期、逾期待辦及30天內到期合約 |
| `關閉提醒` / `開啟提醒` | 只變更自己的每日通知 |

網頁上方也有「AI 詢問」。來源連結開啟 NAS 網頁；附件與完整資料需使用原有網頁帳號登入。查詢會依對象、日期及關鍵字搜尋；一次最多提供40筆相關紀錄摘要給 AI，大量或精確盤點可在網頁查原始資料。查不到會說明未命中，不以常識補出公司事實。

日期、對象不明的文字紀錄會要求補充，沒有直接儲存。新增歷史紀錄不會改掉對象的現行價格、合約或人事主檔。

## 照片

直接傳照片，系統保存原檔、可辨識文字與可見內容，先歸在百麒照片收件紀錄。收件日只代表上傳日，不代表事情發生日。

15分鐘內可再傳：

```text
這張照片是2026/10/9日航枕套髒污的客訴。
```

系統將你的最新一張照片補充歸檔，保留附件與原提交人，不再新增第二筆。飯店必須先在名錄建檔；不明資料仍需確認。也可直接到網頁編輯紀錄。支援 JPEG、PNG、WebP，單張最多8MB。

## 語音

LINE 語音會先保存原檔並產生逐字稿，再依內容新增紀錄、待辦或回答查詢。記錄時請說出完整年份、公司名稱及事件。支援常見 M4A、MP3、AAC、WAV、OGG、FLAC、WebM，單則最多5分鐘、10MB。

聽不清、缺日期、對象不明或辨識暫時失敗，會保存成待補充的語音收件紀錄，讓你在網頁播放與編輯。語音詢問只查資料，不自動新增歷史紀錄。照片與語音存進 NAS PostgreSQL，現有 SQL 備份也會包含原檔；JSON 匯出只有附件資訊，不含原檔，完整備份請用備份任務。

## 到期提醒

預設每天台灣時間08:00，向已互動且開啟通知的成員發送一份清單：未完成的今日到期／逾期待辦，以及30天內到期的合約。沒有到期項目就不發訊息。已完成待辦不再提醒；每人每天最多一份，重啟後也不重複。

對象的「合約到期日（提醒用）」是主要依據；若未填，只在合約期間中恰有兩個完整日期時採用最後日期，不猜「兩年約」等文字。合約已過期不在30天內清單中，需在網頁管理續約或建立追蹤待辦。

新加入的人收到歡迎說明；既有好友需先傳一次訊息才會登記。封鎖官方帳號後停止通知。NAS及外網須保持運行；如果當天08:00後才啟動會補送當日清單，不追補前幾天的通知。

主動提醒與回覆逾時的 push 備援會使用 LINE 官方帳號的每月訊息額度，額度用完時可能無法送達。查看官方帳號用量；`LINE_PUSH_FALLBACK=false` 可關閉逾時備援，`LINE_REMINDERS_ENABLED=false` 可全體停發每日提醒。一般回覆優先使用 reply API。

## 驗證與故障排除

更新後用兩個管理層帳號分別傳「說明」與一筆測試紀錄，再由另一個人查詢。測試照片、補充描述和語音；網頁可查看原圖及播放音訊。建立一筆今天到期的待辦，傳「查看到期」驗證清單。

資料事件先持久保存到佇列，使用事件 ID 避免 webhook 重送造成重複存檔；多人同時寫入會重讀版本重試，稽核歷史保留修改前後資料。LINE 回覆 token 逾時可能改用 push；網路結果不明時請先查看網頁紀錄再手動重傳。

本版經過模擬 LINE/Gemini 傳輸與 PostgreSQL 相容資料庫測試；真實 NAS、各成員手機及 API 額度需在更新後驗證。

官方文件：
- https://developers.line.biz/en/docs/messaging-api/receiving-messages/
- https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
- https://developers.line.biz/en/docs/messaging-api/pricing/
- https://ai.google.dev/gemini-api/docs/audio
