# 百麒公司秘書：LINE＋Gemini，先不接 NAS

使用獨立的秘書 LINE 官方帳號。這個版本接收私人文字訊息、Gemini 產生草稿、使用者確認後存到 Cloudflare D1。NAS 版程式保留，但兩邊尚未自動同步。原本 chatgpt.site 網頁也不會直接看到 D1 資料。

這份程式可直接貼入 Cloudflare 後台，不用安裝 Node.js、不用購買網域。Cloudflare 的免費方案有使用量限制，Gemini 用量依你自己的專案額度。不要把金鑰貼到聊天室或 GitHub。

## 1. 建立 D1 資料庫

登入 https://dash.cloudflare.com/ ，選擇自己的帳戶。

左側 Storage & databases／儲存與資料庫 → D1 SQL Database → Create database，名稱填 `companybrain-line`。

開啟這個資料庫 → Console／主控台，把 GitHub 的 `cloudflare/schema.sql` 完整內容貼上執行。它建立資料表並加入百麒，沒有示範飯店或假資料。重複執行不会清空舊資料。

## 2. 建立 Worker、貼上程式

Workers & Pages → Create application／Create Worker → Hello World，名稱填 `companybrain-line`，先部署。

開啟 Worker → Edit code，刪除預設程式，貼上 GitHub 的 `cloudflare/worker-paste.js` **全部內容**，再部署。

`worker-paste.js` 是已合併的單一檔案，專門給後台貼上；不要貼模組原始檔 `worker.mjs`。

## 3. 綁定資料庫

Worker → Bindings／繫結 → Add binding → D1 database。

- Variable name：`DB`（大寫）
- Database：選 `companybrain-line`

儲存；若畫面要求部署新版本，完成部署。

## 4. 設定金鑰與第一次綁定碼

Worker → Settings → Variables and Secrets → Add，以下都選 **Secret**：

| 名稱 | 值 |
| --- | --- |
| LINE_CHANNEL_SECRET | 新秘書帳號的 Channel secret |
| LINE_CHANNEL_ACCESS_TOKEN | 新秘書帳號的 Channel access token |
| GEMINI_API_KEY | 你的 Gemini API Key |
| BIND_CODE | 自行設定至少16字的隨機英數碼，首次授權你的 LINE 用 |
| EXPORT_KEY | 自行設定至少32字的隨機英數碼，用於下載暫存資料 |

Channel secret 在 LINE Developers 的 Basic settings；Channel access token 在 Messaging API 頁面。

另外新增一個普通文字變數：

`GEMINI_MODEL=gemini-3.1-flash-lite`

儲存並部署。若金鑰無此模型權限，可改為該專案可用且支援結構化輸出的模型。

不要把上述實際值寫进程式碼。BIND_CODE 與 EXPORT_KEY 建議使用密碼管理器生成並保存。第一次成功綁定後，其他人即使傳綁定碼，也不能取代已綁定的你。群組訊息不處理。

## 5. 填入 LINE Webhook

在 Worker 的 Domains & Routes 找到正式 `https://...workers.dev` 網址，不要使用臨時 preview 網址。

在 LINE Developers 選擇秘書帳號 → Messaging API → Webhook settings，填：

```text
https://你剛建立的Worker網址/webhook
```

注意只在原本 Worker 網址後面加一次 `/webhook`。

按 Verify／驗證，應成功。接著開啟 Use webhook。可開啟 Webhook redelivery；程式依事件 ID 避免重複處理。

到秘書帳號的 LINE Official Account Manager → 回應設定，關閉會干擾機器人的自動回應訊息；歡迎訊息可依你需要保留。打卡帳號的設定不用改。

如果 Verify 失敗：

- 401：Channel secret 不符，確認用的是秘書帳號。
- 503：檢查 D1 的 DB 繫結、schema.sql 是否執行、LINE 金鑰是否已部署。
- 404：網址是否漏掉 /webhook，或貼成 preview 網址。

## 6. 用自己的 LINE 綁定

加秘書帳號為好友，在一對一聊天室傳：

```text
綁定 你設定的BIND_CODE
```

例如你自己實際設定的碼，不能直接輸入「你設定的BIND_CODE」。看到「綁定完成」後，即可使用。綁定資訊存 D1，更新程式不會解除。

若綁錯人，先停用 LINE Use webhook，再由管理員在 D1 主控台確認目前 user_id；確認要解除後執行 `DELETE FROM line_owner WHERE id=1;`，換新的 BIND_CODE，部署後重新啟用並綁定。這項解除只影響授權，不會刪除公司紀錄。

## 7. 測試草稿與確認

傳：

```text
2026/09/20 到 2026/09/23 上海出差，參加洗滌展，搭華航商務艙。
```

機器人應回覆草稿。檢查後按下方「確認儲存」，才會存為正式紀錄。重複按確認不会新增第二筆。

也可傳：

```text
請提醒我明天確認設備報價明細。
```

此版能記成待辦，**還不會在指定時間推播通知**。

草稿日期不完整時，可傳：

```text
日期 2026-09-20
```

修改最近一筆未確認草稿。修改整段內容或結束日期時，重新傳完整敘述產生新草稿，並取消不用的舊草稿。

若對象未建檔：

```text
新增對象 飯店 日航飯店
對象 日航飯店
```

第一行建立對象，第二行把最近草稿歸到這個對象。類別可用飯店、設備商、工程/建築、內部。

其他指令：`說明`、`最近草稿`、`我的ID`。草稿確認有效期24小時。若回覆遺失，傳「最近草稿」；只有按確認並收到儲存結果後才算完成。API 錯誤時不要假定已存入。

## 8. 匯出，之後搬到 NAS

瀏覽器開啟：

```text
https://你的Worker網址/export
```

輸入 EXPORT_KEY，下載 `companybrain-line.json`。

匯出包含所有已确认紀錄／待辦與對象，不包含未確認草稿。格式與 NAS 網頁的「匯入資料」相容；NAS 安裝完成後可以直接匯入。這一步是搬移，並非即時同步。

正式 NAS 接上後還要修改 LINE 儲存路徑與驗證 NAS 連線；現在的 Worker 並未宣稱已連上 NAS。搬移成功前保留 D1 資料與 JSON 備份。

## 目前範圍

- 只接受已授權者的私人文字訊息；首版預設一位使用者。
- 沒有照片、語音、LINE歷史搜尋、定時推播、員工個別權限。
- AI 草稿需手動確認，不會直接改合約／價格主檔。
- 公司文字及確認紀錄先存 Cloudflare；送去 AI 整理的文字及對象名稱由 Gemini 處理。
- 每人 AI 上限每分鐘5次、每日100次，依 UTC 日期計算；這是程式限制，不代表 Gemini 免費額度。
- 已測試簽章驗證、首次綁定、未授權阻擋、重複事件、日期補填、重複確認與 NAS 匯入格式。尚未部署到你的 Cloudflare 帳戶，也未用真實 LINE/Gemini 金鑰做端到端驗證。

官方參考：

- https://developers.cloudflare.com/d1/get-started/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
- https://developers.line.biz/en/docs/messaging-api/receiving-messages/
