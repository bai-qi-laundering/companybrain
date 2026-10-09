# LINE 文字秘書設定
先備份既有資料。更新 backend 資料夾與 compose.yaml，保留 settings.env 和資料庫 volume。
在 settings.env 最下方新增：
```dotenv
LINE_CHANNEL_SECRET=Basic settings 裡的 Channel secret
LINE_CHANNEL_ACCESS_TOKEN=Messaging API 裡的長效 Channel access token
LINE_ALLOWED_USER_IDS=Basic settings 裡你的 Your user ID
```
可填多個 user ID，以英文逗號分隔。空白時不接受訊息；只接受允許的人員一對一訊息，不接受群組。
Your user ID 是你登入 LINE Developers 的個人 LINE ID（U 開頭），不是 Channel ID、官方帳號 ID 或顯示名稱。其他使用者的 LINE ID 需要另外取得，不能猜測。
重新執行 companybrain-start，確認 app 容器穩定。
Webhook URL：
```
https://fileserver.tailbb066f.ts.net:10000/api/line/webhook
```
在 Messaging API 的 Webhook settings 按 Edit、貼上、Update、Verify。成功後開啟 Use webhook。若提供 Webhook redelivery 選項可啟用。
若 Verify 因 10000 連接埠無法連線，先提供錯誤訊息，不要覆蓋既有 Tailscale 的 443/8443 設定。
在 LINE Official Account Manager 的回應設定，關閉一般自動回應訊息，避免與秘書回覆混淆。
允許的使用者加入這個獨立官方帳號，傳「說明」測試；再傳：
2026/10/18 到 2026/10/23 去日本金澤出差，搭華航商務艙。
成功會回「已記錄事項」並附網頁連結；到百麒的時間軸查閱。待辦可傳「請提醒我明天確認設備報價」。
第一版支援文字新增紀錄／待辦。照片、語音、歷史問答、主動提醒尚未實作。資料不明時不自動存，請補充後重新傳完整內容，或用網頁填寫。
事件先存 PostgreSQL 佇列，再由背景處理；事件 ID 和紀錄 ID 避免 LINE 重送造成重複。與網頁同時修改會重讀版本重試，保留既有資料和修改歷史。
LINE reply token 有有效期限；若 AI 或排隊太久，可能資料已儲存但 LINE 未回覆，請先看網頁清單，避免手動重傳造成另一筆事件。這版沒有主動 push 備援。
帳號未被允許或來自群組時會忽略，不回傳公司資訊。設定與金鑰不要上傳 GitHub 或傳給他人。
