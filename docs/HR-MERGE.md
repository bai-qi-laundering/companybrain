# 人事系統併入 companybrain — 明日 NAS 操作步驟

本文件只給明天在公司 NAS 上執行。今晚在開發機準備的程式**沒有**推上 GitHub，也**沒有**動到 NAS。請先備份，再套用 patch、重建容器、預演遷移，確認無誤後才做正式遷移。舊人資系統確認可用後再停止。

時區：Asia/Taipei。

## 0. 今晚已完成、明天會用到的檔案

| 路徑 | 用途 |
| --- | --- |
| `/workspace/hr-merge/companybrain-hr-merge.patch` | 對 companybrain `main` 的 `git format-patch`（含 `feat/hr-merge` 全部變更） |
| `/workspace/hr-merge/companybrain/` | 本機 `feat/hr-merge` 分支（參考用，勿直接當 NAS 目錄覆寫） |
| `/workspace/hr-merge/HumanResourceManagement/` | 舊人資系統原始碼參考 |
| `/workspace/hr-merge/fixtures/hr-sample.sqlite3` | 示意用遷移樣本（不是公司真實資料） |
| `/workspace/hr-merge/screenshots/` | 本機煙霧測試截圖 |

把 `companybrain-hr-merge.patch` 帶到 NAS（隨身碟或內網複製即可）。若明天已把 `feat/hr-merge` 推上 GitHub，可改用 `git pull`，不必再套 patch。

## 1. 備份（必做，先做）

假設 companybrain 專案在 NAS 上的目錄為 `COMPANYBRAIN_ROOT`（常見為 `/volume1/docker/companybrain` 或你們實際放置 git 專案的路徑）。舊人資資料夾預設為 `/volume1/docker/baiqi-hr/data`（見舊系統 `.env` 的 `HR_DATA_PATH`）。

在 NAS 以 DSM 或 SSH 執行：

```sh
# --- companybrain PostgreSQL ---
cd "$COMPANYBRAIN_ROOT"
sh scripts/backup.sh
# 會產生 backups/companybrain-YYYYMMDD-HHMMSS.sql.gz
# 再額外複製一份到不怕被覆寫的位置，例如：
cp -a backups "/volume1/docker/backups/companybrain-$(date +%Y%m%d-%H%M)"

# --- 舊人資 SQLite（先停容器，避免只拷到一半的 WAL）---
cd /volume1/docker/baiqi-hr   # 若專案不在此，改成實際 compose 目錄
sudo docker stop baiqi-hr
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "/volume1/docker/backups/baiqi-hr-$STAMP"
# 整份資料目錄（含 hr.sqlite3、hr.sqlite3-wal、hr.sqlite3-shm）
cp -a /volume1/docker/baiqi-hr/data "/volume1/docker/backups/baiqi-hr-$STAMP/data"
ls -lh "/volume1/docker/backups/baiqi-hr-$STAMP/data"
```

證件資料夾（`/volume1/人事資料/身分證`、`存摺`、`駕照`）此次只會掛進 companybrain 繼續寫入新檔，**不必搬移、不要刪**。若要多一份保險，可再 `cp -a /volume1/人事資料 "/volume1/docker/backups/hr-docs-$STAMP"`。

備份完成後，先**不要**立刻再啟動 `baiqi-hr`（遷移讀取備份複本即可；必要時可再啟動舊系統對照）。

## 2. 套用程式（patch 或 git pull）

### 方式 A：尚未推上 GitHub（今晚的情況）

```sh
cd "$COMPANYBRAIN_ROOT"
git status
git checkout main
git checkout -b feat/hr-merge
git am --3way /path/to/companybrain-hr-merge.patch
# 成功後應可看到 backend/hr-store.mjs、public/hr-app.js、scripts/migrate-hr.mjs 等檔
```

若 `git am` 失敗，先 `git am --abort`，不要強制繼續。把衝突與 `git status` 留下來處理，不要直接重建容器。

### 方式 B：已把 `feat/hr-merge` 推上 GitHub

```sh
cd "$COMPANYBRAIN_ROOT"
git fetch origin
git checkout feat/hr-merge
git pull --ff-only origin feat/hr-merge
```

## 3. 設定 compose 與環境變數

在 `settings.env`（不要改 Git 裡的範例當正式密碼）**新增或確認**以下變數，路徑必須與舊人資系統相同：

```dotenv
NAS_IDENTITY_PATH=/volume1/人事資料/身分證
NAS_BANK_PATH=/volume1/人事資料/存摺
NAS_LICENSE_PATH=/volume1/人事資料/駕照

# 銀行帳號靜態加密金鑰（32 位元組十六進位）。只做一次，寫進 settings.env 並另外備份。
# 遺失這把鑰匙就無法解密已存帳號。產生方式：
#   openssl rand -hex 32
HR_PII_KEY=

# 可選：唯讀匯入打卡算薪水試算表。填服務帳戶 JSON 檔路徑，或直接貼 JSON。
# 試算表需分享給該服務帳戶（檢視者）。不做不會影響其他功能。
GOOGLE_SA_JSON=
```

這三個資料夾必須已存在。`compose.yaml` 會把它們以**相同路徑**掛進 companybrain 容器，上傳檔名規則不變。

`HR_PII_KEY` 用來把員工銀行帳號（以及確認後的身分證字號）加密存進資料庫；畫面上帳號只顯示後四碼。沒填的話，上傳與掃描仍可做，但無法保存完整帳號，存摺自動辨識的「確認」會提示先填金鑰。存摺／身分證辨識沿用既有的 `GEMINI_API_KEY`；若未設定 Gemini，上傳仍會存到同一資料夾、同一檔名規則，只是不會出現辨識確認卡，可稍後再補金鑰並用「批次辨識既有存摺」。

不要把 `ADMIN_PASSWORD`、資料庫密碼、LINE／Gemini 金鑰、`HR_PII_KEY`、`GOOGLE_SA_JSON` 寫進 Git。匯入本月薪資是可選的（設定 `GOOGLE_SA_JSON` 並把試算表分享給服務帳戶檢視者即可）；舊的 `HR_GAS_URL`／`HR_GAS_SECRET` 不必新填。

確認三個證件資料夾存在後重建：

```sh
cd "$COMPANYBRAIN_ROOT"
# 先核對 settings.env 有上述三個路徑，再：
sh scripts/apply.sh
# 即：把 settings.env 複製為 .env，並
# docker compose --project-name companybrain --env-file settings.env up -d --build
```

確認 `app`、`db` 健康，且原本的公司往來登入仍可用。

## 4. 遷移：先預演，再正式寫入

遷移腳本**只讀**舊 SQLite，對 Postgres 採「已存在的列不覆蓋」（`INSERT ... DO NOTHING` / skip）。請對**備份複本**跑，不要直接對正在寫入的檔。

舊庫典型路徑：`/volume1/docker/baiqi-hr/data/hr.sqlite3`。請改用備份：

```sh
BACKUP_DB=/volume1/docker/backups/baiqi-hr-XXXX/data/hr.sqlite3   # 換成實際備份路徑
cd "$COMPANYBRAIN_ROOT"

# 預演：只印筆數，不寫 Postgres
sudo docker compose --project-name companybrain --env-file settings.env run --rm \
  -e HR_MIGRATE_FROM_APP=1 \
  -v "$BACKUP_DB:/old-hr.sqlite3:ro" \
  app node migrate-hr.mjs --sqlite /old-hr.sqlite3 --dry-run
```

核對印出的 `employees`、`candidates`、`leaveRecords`、`leaveLedgers`、`documents`、`salaries` 等筆數，是否與舊系統大致相符。打卡會標成「略過（不遷移）」。另外會列出 `arrivalFilled`（空到職日由最早勞保／健保「加保」日帶入，來源標記為「加保日」，之後可在員工檔直接改）與 `arrivalStillMissing`（仍無到職日也無加保日）。不會覆蓋已經有到職日的員工。

確認無誤後，正式遷移（同一份唯讀備份）：

```sh
sudo docker compose --project-name companybrain --env-file settings.env run --rm \
  -e HR_MIGRATE_FROM_APP=1 \
  -v "$BACKUP_DB:/old-hr.sqlite3:ro" \
  app node migrate-hr.mjs --sqlite /old-hr.sqlite3
```

會印出 `inserted / already existed / skipped`。可再跑一次同一指令，確認第二次幾乎都是 `exists`（冪等）。

員工編號會**原樣**寫入（含打卡表的 `D001`、`F113` 等，以及舊系統若已是 `EMP-001` 也會保留、不改號）。之後「報到並轉為員工」的新編號依部門字首＋流水號：物流 D、摺疊 F、撐開 H、洗滓 W 或 E、辦公室／行政 O。員工檔可存 LINE ID、計薪型態（正職／兼職）、匯款類型（匯款／現金），本次不串打卡算薪水。

## 5. 驗證

用公司既有的 companybrain 帳號（`ADMIN_USER` / `ADMIN_PASSWORD`）登入，一個入口即可：

1. 側欄出現「員工、廠商、客人、徵人」。
2. 員工名錄人數、姓名、編號與舊系統一致。
3. 點開一位員工：特休台帳顯示「應有／已用／剩餘／結算狀態」；特休年度為**到職日週年**。未休完結算預設「未休完已折現」（只記狀態、日期、經手人，不記金額）。
4. 在員工檔案上傳一張測試證件，畫面顯示「已存到 `/volume1/人事資料/…/原規則檔名`」，檔案確實出現在該資料夾；舊檔仍在。身分證／存摺／駕照會顯示縮圖（PDF 顯示圖示），點縮圖可在頁面內放大預覽，並保留「查看」。若已設定 Gemini，存摺／身分證上傳後會出現「請核對後確認」卡，按確認才會寫入；銀行帳號確認後只顯示後四碼。員工名錄的「批次辨識既有存摺」可掃描 NAS 存摺資料夾、產生待確認項目。舊員工若原先沒有到職日，檔案上會帶「由最早勞健保加保日帶入，可直接修改」的小註記。
5. 徵人看板、今日待聯絡／已過期未跟、電話／面試紀錄、「報到並轉為員工」會自動給下一個編號並出現報到清單。不能只把進度改成「已報到」。
6. 廠商、客人仍是原來的往來對象（飯店＝客人；設備商／工程／其他＝廠商）。既有往來紀錄、待辦、LINE、AI 功能仍可用。
7. 員工檔「薪資」可按月登記實發金額、備註與匯款狀態（已匯／未匯）。也可在員工名錄或薪資區按「匯入本月薪資」，唯讀讀取試算表「薪資計算明細」，以員工編號對應後預覽（新增／金額變更／相同／對不到員工），按確認才寫入。未設定 GOOGLE_SA_JSON 時會顯示設定說明，不影響其他功能。舊系統薪資若有實發金額會遷入此台帳；**打卡／出勤紀錄不遷移、畫面也不顯示**。

## 6. 停用舊人資系統（驗證通過後）

舊系統容器名為 `baiqi-hr`，埠為 NAS 區網 `:8090`。

```sh
sudo docker stop baiqi-hr
# 確定不再自動重啟（驗證後再執行）：
sudo docker update --restart=no baiqi-hr
# 或在該專案目錄：
# docker compose stop
```

不要刪容器、不要刪 `/volume1/docker/baiqi-hr/data` 與備份。至少保留到下一週確認無誤。之後公司只走 companybrain 一個入口。

## 7. 回退

1. 停用新的人資畫面：可先把 companybrain 回到合併前的映像／commit（見下），舊證件資料夾不需還原（新上傳的檔案可留著）。
2. 還原 companybrain 資料庫：

```sh
cd "$COMPANYBRAIN_ROOT"
# 停止 app，避免寫入
sudo docker compose --project-name companybrain --env-file settings.env stop app
# 以備份 SQL 還原（檔名換成第 1 步的備份）
gunzip -c backups/companybrain-YYYYMMDD-HHMMSS.sql.gz | \
  sudo docker compose --project-name companybrain --env-file settings.env exec -T db \
  psql -U companybrain -d companybrain
sudo docker compose --project-name companybrain --env-file settings.env start app
```

3. 程式回到合併前：

```sh
cd "$COMPANYBRAIN_ROOT"
git checkout main
# 或：git reset --hard <合併前的 commit>
sh scripts/apply.sh
```

注意：`apply.sh` 會重建容器，但**不會**自動還原資料庫；資料庫必須用第 2 點的 `psql` 還原。

4. 重新啟動舊人資：

```sh
sudo docker start baiqi-hr
sudo docker update --restart=unless-stopped baiqi-hr
```

舊 SQLite 若未曾被遷移程式寫入（腳本為唯讀），可直接用原資料夾。若曾手動改過舊庫，改用第 1 步的資料目錄備份還原。

## 8. 這次刻意不做的事

- 不推 GitHub、今晚不動 NAS（本文件是明天的手順）。
- **不串接「打卡算薪水」試算表**（舊人資雖有只讀 Apps Script 匯出：`HR_GAS_URL` / `HR_GAS_SECRET`，這次不搬進 companybrain）。員工編號與姓名維持不變，之後若要再連，有穩定對應鍵。
- 不在新畫面新增排班、工單、工時或打卡／出勤功能，也不遷移打卡資料。薪資是按月台帳；若已設定服務帳戶，可從打卡算薪水試算表唯讀匯入「實領薪資」（先預覽再確認），不會寫回試算表，也不匯入打卡明細。
- 不刪舊人資容器與資料。

