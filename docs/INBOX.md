# 收件匣（分揀員）

左側選單新增「收件匣」：什麼檔案都可以丟進來（可一次多個），系統判斷是什麼、該去哪裡。
「財務」選單保留「已歸檔」「損益表」「設定（含匯入原本的損益表 Excel）」，只把原本的「上傳／待確認」移到收件匣，並在財務上方留一行「上傳文件請到 收件匣（N 份待確認）」。

## 各種文件去哪裡

| 種類 | 自動或先問 | 確認後去哪 |
|---|---|---|
| 進項／銷項發票、收據、對帳單、報價單、合約、其他 | 跟原本財務收件匣一樣：有把握（≥ 0.85、對象完全相符、沒有疑問）才自動 | 對象資料夾（客人／廠商）或 財務收件匣/<月份>，計入損益表規則不變 |
| 名片 | 名錄裡**完全相符**（統編、學過的名稱或名稱／別名完全一樣）且把握度夠才自動；新公司一律先問 | 圖片放 `<對象資料夾>/名片/`，聯絡人加到名錄「聯絡人」（同電話／Email 不重複加；原本是「尚未提供」「—」就直接取代）。確認時可選「新增對象」 |
| 身分證、居留證 | **一律先問** | 原本的 `NAS_IDENTITY_PATH`（檔名規則不變），之後沿用「員工」頁的證件辨識確認 |
| 駕照 | **一律先問** | 原本的 `NAS_LICENSE_PATH`，可填到期日 |
| 存摺 | **一律先問** | 原本的 `NAS_BANK_PATH`，之後沿用原本流程：AI 讀帳號 → 在「員工」頁確認 → 加密保存、匯款類型 現金→匯款 |
| 履歷 | **一律先問** | 原本的 `NAS_RESUME_PATH` |
| 離職單 | **一律先問** | `員工/<編號_姓名>/離職單/`；離職日寫進 companybrain 與「打卡算薪水」試算表「員工資料」的「實際最後在職日」 |
| 薪資檔 | **一律先問**（本機判斷，不送 AI） | 實領薪資寫進人資（已匯款且金額不同的不覆蓋）；原檔放 `薪資表/<公司>/`，公司可選，預設「百麒」 |

## 個資保護

- 個人文件（身分證、居留證、駕照、存摺、履歷、離職單、薪資檔）以及**辨識失敗、不知道是什麼**的檔案，上傳後用 `HR_PII_KEY`（AES-256-GCM）加密存在資料庫 `inbox_pii_blobs`，**確認前不會寫到 NAS**。
- 確認歸檔或按「不處理」後，加密暫存立即刪除。**30 天**沒確認自動刪除（每天檢查一次，`INBOX_PII_PURGE_DAYS` 可改）。
- 待確認清單的個資縮圖預設模糊，點一下才顯示；原檔回應 `Cache-Control: no-store`。
- 稽核紀錄 `inbox_audit`（上傳、自動歸檔、確認、不處理、開啟原檔、刪除），只記種類與員工編號，不記姓名、證號、帳號。
- 身分證、存摺照片會送 Gemini 辨識（老闆已同意）；不會把員工名單送給 AI，員工比對只在本機用員工編號或唯一同名。Excel／CSV 薪資檔在本機判斷，不送 AI。
- 沒設定 `HR_PII_KEY` 時，個人文件會被拒收（不落地），財務文件照常。

## 離職單寫試算表

1. 確認畫面會讀出試算表「員工資料」該員工那一列的「實際最後在職日」（依表頭找欄位，通常是 G 欄）。
2. 試算表已有**不同的**日期 → 必須勾「確定要覆蓋」，否則擋下（409）。空白或相同就直接寫。
3. `HR_SHEET_WRITE=off`、沒設服務帳戶、讀不到或寫不進去 → 文件照樣歸檔、companybrain 照樣寫離職日，但標示「離職日未寫入試算表：原因」，請手動補。
4. 只改這一格，不動其他欄位或 Apps Script。試算表 → companybrain 的同步本來就以試算表的離職日為準，寫入後兩邊一致。

## 餐廳 = 客人

- 名錄種類「飯店」「餐廳」都算客人（`CLIENT_KINDS`），其他種類是廠商。前端客人／廠商頁、資料夾歸類、AI 自動連結描述都一致。
- 啟動時自動把「連結資料夾」的種類對齊對象種類（例如餐廳原本 9 筆連結從廠商改成客人）。**只改資料庫連結，不搬檔案**；上傳用主資料夾（`廠商/<編號_名稱>`）不動。可重複執行。

## API（需登入）

- `POST /api/inbox/upload`（multipart，可多檔；舊網址 `POST /api/finance/inbox` 同一個處理）
- `GET /api/inbox`（待確認）、`GET /api/inbox?status=recent`、`GET /api/inbox/meta`、`GET /api/inbox/audit`
- `GET /api/inbox/:id`、`GET /api/inbox/:id/file`
- `GET /api/inbox/:id/resignation-preview?employeeId=`、`GET /api/inbox/:id/salary-preview?month=`
- `POST /api/inbox/:id/confirm`（body 依種類：財務欄位／`orgId` 或 `newOrg` + `contact`／`employeeId` + `expiresOn`／`employeeId` + `departureDate` + `overwriteSheet`／`month` + `company` + `importRows`）
- `POST /api/inbox/:id/ignore`、`POST /api/inbox/:id/retry`

## 環境變數

| 變數 | 說明 |
|---|---|
| `HR_PII_KEY` | **必填**才能收個人文件（沿用人資既有金鑰，不要更換，否則暫存檔無法解密） |
| `HR_SHEET_WRITE` | `off` 時離職日不寫試算表（只寫 companybrain） |
| `GOOGLE_SA_JSON` / `GOOGLE_SA_JSON_B64` | 讀寫試算表用的服務帳戶（沿用） |
| `INBOX_PII_PURGE_DAYS` | 未確認個資暫存保留天數，預設 30 |
| `INBOX_MAX_FILES` | 一次上傳最多幾個檔案，預設 20 |
| `NAS_DIRECTORY_ROOT`、`NAS_IDENTITY_PATH`、`NAS_BANK_PATH`、`NAS_LICENSE_PATH`、`NAS_RESUME_PATH` | 沿用，位置不變 |

不開立發票、不寄對帳單、不傳 LINE；沒有新增 Firestore 讀取。
