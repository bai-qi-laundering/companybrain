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

## 資料表
`fin_documents`（文件與辨識結果）、`fin_entries`（損益項目；文件產生或手動）、`fin_rules`（確認後學到的對象／統編／科目）。

## 部署注意
- NAS 自動部署器只複製 `FILES` 清單內的檔案，且不會更新自己。這個 PR 已把 finance 檔案加入清單，但 NAS 上那份 `scripts/nas-auto-deploy.py` 要手動更新一次；否則合併後自動部署會因 Dockerfile 找不到 finance 檔案而建置失敗並回滾（舊版照常運作）。
- 新環境變數（選填）：`FINANCE_COMPANY_TAX_IDS`（逗號分隔，預設 96842769）、`FINANCE_AUTO_CONFIDENCE`。compose.yaml 已加，NAS 的 compose.yaml 需手動同步。
- 需要 `NAS_DIRECTORY_ROOT` 已掛載（compose.directory-docs.yaml）。
