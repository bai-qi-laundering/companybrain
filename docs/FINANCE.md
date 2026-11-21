# 財務收件匣與月損益表

只讀取、歸檔「收到」的文件，不會開立發票。所有 `/api/finance/*` 都需要登入（管理員 session + CSRF）。

## 流程
1. 前端「財務」→ 拖檔或選檔（照片、PDF、xlsx/xls、CSV，每個 20MB 內）。每個檔案一個請求，依序處理。
2. 先存進 NAS `百麒/財務收件匣/待確認/<YYYY-MM>/`，以 SHA-256 去重（同一個檔案不會再辨識、也不會再花錢）。
3. Gemini（`GEMINI_MODEL`，預設 gemini-3.1-flash-lite）辨識：文件類型、對方、統編、發票號碼、日期、入帳月份、未稅／稅額／含稅、損益科目、把握度、疑點。試算表先用 `finance-excel/sheet_text.py` 轉文字（只取每張表前 150 列）。
4. 規則檢查（`reviewFields`）：名錄比對、統編判斷進／銷項、發票號碼格式、未稅+稅額=總額、重複發票號碼、同一家同月發票與對帳單可能重複計算、學過的「廠商→科目」。
5. 把握度 ≥ `FINANCE_AUTO_CONFIDENCE`（預設 0.85）且沒有任何疑點 → 自動歸檔；否則進「待確認」，上傳完自動跳出確認視窗。
6. 歸檔位置：`廠商|客戶/<編號_名稱>/<發票收據|對帳單貨款|報價單|合約|其他文件>/<年>/<日期_類型_發票號_金額>.<ext>`；沒有對象就放 `財務收件匣/<YYYY-MM>/<類型>/`。
7. 計入損益的文件與手動項目寫入 `fin_entries`，損益表依 NAS 原本「月份_自動損益表.xlsx」的科目與順序產生，可下載 CSV。

## 收入：只看已寄出的對帳單（不重複計算）
- 收入（對帳單）＝ hotellinen_service Firestore `statement_cases` 中，每家客戶當月（依 `endDate` 月份）**最新一個已寄出版本**的 `afterRebate + tax`（含稅；未稅基準用 `afterRebate`）。規則與系統後台「應收帳款」一致：客戶鍵含「+」的合併單略過（良西+良一 除外）。
- 只讀取（runQuery），不寄送、不改對帳單、不開發票。
- 銷項發票只歸檔、不計入；手動項目只剩「其他收入」（對帳單以外，例如廢品出售），畫面上有提醒避免重複。
- 權限：沿用 `GOOGLE_SA_JSON_B64` 服務帳戶（companybrain-sheet@hotel-inventory-3a1ad），需在 Google Cloud 專案 hotel-inventory-3a1ad 給它 **Cloud Datastore 檢視者（roles/datastore.viewer）**。不用新金鑰或新環境變數。
- 讀取量：一個月份查詢 ≈ 當月對帳單數（約 55–60 次讀取）。結果存 `fin_revenue_months` 快取；每天自動更新上月＋本月一次（約 120 次／天，約 3,600 次／月，遠低於每天 5 萬次免費額度）；其餘月份只在按「更新營收」時讀（全年約 660 次）。
- 對帳單由不同集團公司開立，但損益表收入為合併數。

## 薪資
- 損益表「薪資」＝ `hr_salaries` 當月實發合計（由薪資試算表同步）＋手動調整；被辨識為薪資的文件只歸檔不計入。
- 同步每 10 分鐘讀一次「薪資計算明細」，看到的每個月份／員工都存成快照，已匯的月份不會被覆蓋。
- 限制：試算表每次「算薪水」會整頁覆寫，只保留當次篩選的人；兩次同步之間被覆寫的結果、companybrain 沒有的員工、PR #18 之前的月份都不會有資料。損益表會顯示「已入帳人數／約在職人數」提醒。過去月份可從原本的 Excel 匯入，或請 GAS 另外寫一張歷史表（需另外決定）。

## 集團公司
- 百麒國際、百富、日聖、百銘、百麒洗衣，在「財務 → 設定」維護統編與別名（存在 `fin_settings`，不用改 env）。每份文件會標示屬於哪家公司（進項看買方、銷項看賣方）；進項買方統編不是任何一家時會詢問。

## 匯入原本的損益表 Excel（歷史月份）
- 來源：NAS 上的 `百麒/115年支出明細/月份_自動損益表.xlsx`（路徑可改；只能是 NAS 根目錄內的 .xlsx）。**只讀**：openpyxl read_only＋只讀快取值，不寫入、不改原檔。
- 讀「年度損益表」工作表每月每科目的數字（含稅，就是老闆在 Excel 看到的數字），寫成 `fin_entries`（`source='excel-import'`，一個月一個科目一筆，另加一筆「收入」）。各月工作表的明細只用來交叉檢查，有差異時以彙總為準並列在預覽裡。
- 薪資：Excel 只有每月總額（沒有每人明細），所以匯入成「薪資」科目總額。每人明細仍以人資 `hr_salaries` 為準（只有系統上線後的月份）。
- 只匯入「已結帳」的過去月份：Excel 該月收入 > 0、早於本月，並可指定「最後月份」（until）。還在記帳中（收入 0）或本月／未來月份會略過。
- **優先順序（避免重複）**：有匯入的月份整個月以 Excel 為準，系統的對帳單營收、人資薪資、上傳文件、手動項目都不計入（損益表滑鼠移到收入的 * 會看到未採用的金額）。之後的月份才用系統資料。如果 Excel 的 11 月記完了也想用 Excel，重新匯入並把最後月份設成 2026-11。
- 可重複執行：重新匯入時，同一個交易裡先刪掉那些月份舊的 `excel-import` 再寫入，不會重複；每次匯入的檔案 SHA-256、月份、合計記在 `fin_settings` 的 `excelImport:<年>`。
- 未稅基準：Excel 只有含稅數字，匯入的月份在未稅模式下仍顯示含稅。
- 預覽（dry-run）：「財務 → 設定 → 匯入原本的損益表 Excel → 預覽」，或在有檔案副本的電腦上執行 `node scripts/finance-excel-preview.mjs <檔案.xlsx> [--until 2026-10]`（只讀檔案，不連資料庫）。API：`POST /api/finance/import-excel {path, until, dryRun}`，dryRun 預設為 true。

## 資料表
`fin_documents`（文件與辨識結果）、`fin_entries`（損益項目；文件產生或手動）、`fin_rules`（確認後學到的對象／統編／科目）、`fin_settings`（集團公司）、`fin_revenue_months`（對帳單營收快取）。

## 部署注意
- NAS 自動部署器只複製 `FILES` 清單內的檔案，且不會更新自己。這個 PR 已把 finance 檔案加入清單，但 NAS 上那份 `scripts/nas-auto-deploy.py` 要手動更新一次；否則合併後自動部署會因 Dockerfile 找不到 finance 檔案而建置失敗並回滾（舊版照常運作）。
- 新檔案 `finance-revenue.mjs`、`finance-import.mjs`、`finance-excel/pnl_import.py`、修改的 `google-sa.mjs`、`hr-sheet-sync.mjs` 要手動複製一次（`hr-*` 不在自動部署清單）。
- `HR_SHEET_SYNC_MINUTES` 預設改為 10，NAS compose.yaml 需同步。
- 新環境變數（選填）：`FINANCE_FIRESTORE_PROJECT`（預設 hotel-inventory-3a1ad）、`FINANCE_COMPANY_TAX_IDS`（逗號分隔，預設 96842769）、`FINANCE_AUTO_CONFIDENCE`。compose.yaml 已加，NAS 的 compose.yaml 需手動同步。
- 需要 `NAS_DIRECTORY_ROOT` 已掛載（compose.directory-docs.yaml）。

## 收件匣

上傳與待確認已移到左側「收件匣」（見 [INBOX.md](INBOX.md)）；舊的 `POST /api/finance/inbox` 仍可用。財務頁保留已歸檔、損益表、設定（含 Excel 匯入）。
