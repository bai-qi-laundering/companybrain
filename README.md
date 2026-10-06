# companybrain｜百麒公司往來管理

管理總覽以待辦與月曆為主，對象名錄管理公司、飯店、設備商及建築合作夥伴。

已包含可在 Synology NAS 安裝的第一版後端：PostgreSQL、單一管理帳號登入、跨裝置同步、Gemini 文字整理草稿、對象與價格編輯、資料匯入／匯出及備份脚本。

**完整操作步驟：[NAS_SETUP.md](docs/NAS_SETUP.md)**

`index.html` 單獨放在 GitHub Pages 或預覽網址時，是本機儲存體驗版。NAS 模式由後端一起提供同一頁面與 API，登入後使用 NAS 資料；正式使用請開 NAS 網址。

Gemini API Key、密碼只保存在 NAS 的 `settings.env`，勿提交 GitHub。第一次啟動只有百麒檔案，不會灌入示範客戶或金額。AI 草稿經人工確認才儲存，不會直接改合約或價格主檔。

目前未包含 LINE、照片／PDF 上傳、自動通知、多員工帳號或獨立稽核歷史查閱介面。

## 程式檢查

```sh
cd backend
npm ci
npm test
```

Docker 建置只安裝正式環境所需的 pg 套件；測試用 PGlite 不會打包進正式映像。
