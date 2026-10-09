# 百麒 Companybrain：NAS＋Gemini 安裝步驟

這是可安裝的第一版。提供 NAS PostgreSQL 儲存、單一管理帳號登入、對象建檔、往來紀錄、待辦月曆、Gemini 文字整理草稿、試填資料匯入及備份。

已加入 LINE 多人、照片、語音、歷史查詢與每日到期通知，設定及更新請看 [LINE_SETUP.md](LINE_SETUP.md)。PDF 上傳與員工個別權限尚未提供。AI 整理在資訊完整時自動儲存，缺資料需人工補充；不會直接改合約或價格主檔。

原本的 chatgpt.site 和 GitHub Pages 網址仍是前端體驗版。**本次 NAS 安裝會由 NAS 一起提供網頁與後端。正式使用請開 NAS 的新網址。** 網頁、登入和 API 使用同一個網址，無需在每台裝置登入 DSM 或安裝 NAS 管理工具。

## 1. 下載程式

先確認 DSM 套件中心的 Container Manager 已安裝並啟動。

到 https://github.com/bai-qi-laundering/companybrain ，按 Code → Download ZIP。

解壓縮，將 `companybrain-main` 內的檔案放至 NAS：

`/volume1/docker/companybrain`

若你的 docker 共用資料夾在別的磁碟區，以下 `/volume1` 一起改成實際路徑。資料夾內應直接有 `index.html`、`compose.yaml`、`backend`、`scripts`、`docs`、`.env.example`，不要再多包一層 companybrain-main。

保留原本的 equipment-manager 資料夾與容器；此專案使用獨立的資料庫 volume。

## 2. 產生 NAS 設定檔

DSM → 控制台 → 任務排程器 → 新增 → 排程的任務 → 使用者定義的指令碼。

- 名稱：`companybrain-prepare`
- 使用者：`root`
- 不啟用自動排程；只手動執行這一次。
- 任務設定 → 使用者定義的指令碼，貼上：

```sh
set -eu
cd /volume1/docker/companybrain
sh scripts/prepare-settings.sh
```

儲存後選取這個任務，按「執行」。檔案 `settings.env` 就會出現在 companybrain 資料夾。此步驟會產生隨機資料庫密碼與登入密碼，重複執行不會覆蓋已有設定。在 Synology 上，此檔只允許 root 與 administrators 群組讀寫；請用 NAS 管理員帳號編輯。

若檔案沒出現，先查看任務的執行結果／輸出，確認路徑正確。

## 3. 填入網址、密碼與 API Key

用 DSM 的「文字編輯器」開啟 `settings.env`。如果沒有這個套件，先到套件中心安裝「文字編輯器」，再於 File Station 開啟檔案。也可下載到電腦編輯後上傳覆蓋，只在自己的 NAS 保存這份檔案。

假設你的 NAS 區網 IP 是 `192.168.1.100`，設定如下：

```dotenv
DB_PASSWORD=保留系統產生的值
ADMIN_USER=admin1
ADMIN_PASSWORD=你自己的16字以上英數密碼
GEMINI_API_KEY=你自己的GeminiAPI金鑰
GEMINI_MODEL=gemini-3.1-flash-lite
PUBLIC_ORIGIN=http://192.168.1.100:8788
APP_BIND=0.0.0.0
APP_PORT=8788
COOKIE_SECURE=false
```

這段是說明範例，不要把「保留系統產生的值」或「你自己的…」當成實際值。`DB_PASSWORD` 保留自動產生的英數密碼。第一次安裝後不要任意更改資料庫密碼。

`PUBLIC_ORIGIN` 要換成實際 NAS IP，包含 `http://` 和 `:8788`，結尾不要加 `/`。請從這個完全相同的網址登入；如果用別名，請把設定一併改成別名。

初次只在公司內網測試，所以 COOKIE_SECURE=false。不要把 8788 直接轉發到網際網路。正式遠端使用改 HTTPS，設定方法在第9步。

Gemini API Key 不用貼給助手，不要上傳 GitHub。`settings.env`、`.env` 已加入忽略規則。

## 4. 建立並啟動容器

在 DSM 任務排程器建立第二個手動任務：

- 名稱：`companybrain-start`
- 使用者：`root`
- 不啟用自動排程。
- 指令碼：

```sh
set -eu
cd /volume1/docker/companybrain
sh scripts/apply.sh
```

儲存後按「執行」。首次會下載 Node.js、PostgreSQL 映像並建置程式，時間取決於 NAS 和網路。程式使用 port 8788；若已被其他服務使用，將 APP_PORT 與 PUBLIC_ORIGIN 的 port 一起換成另一個閒置號碼。

到 Container Manager → 容器，可看到名稱以 `companybrain-app`、`companybrain-db` 開頭的兩個容器。兩個都應持續運行，不應一直重新啟動。資料庫只供這個專案內部連線，不對外開放 5432。

## 5. 開啟網頁及登入

手機先連公司 Wi-Fi，瀏覽器開啟：

`http://你的NAS區網IP:8788`

應出現「公司資料登入」。輸入 settings.env 的 ADMIN_USER 與 ADMIN_PASSWORD。

登入後應顯示「NAS 已連線」，初始只有百麒檔案，沒有示範飯店、示範金額或示範待辦。

另一台電腦開同一個網址登入；新增一件待辦，另一台按「重新載入」或等約20秒確認看到同一筆。編輯表單開啟時會暫停自動更新，避免打字中的內容被干擾。若兩台同時編輯，第二台可能收到版本衝突訊息：先關閉表單並重新載入，再重新操作；未儲存的內容不要先清除。

此版是共用的管理帳號，尚未有員工個別權限。設定內網 HTTP 僅供受信任公司網路初次測試，正式公司資料請完成 HTTPS。

## 6. 建立真正的合作對象

對象名錄 → 新增對象。填飯店或設備商名稱、聯絡人、職務、負責人、合約期間。價格每行用下列格式：

```text
浴巾,18,2026-10-01
床單,22,2026-10-01
```

對象有固定 ID，編輯名稱不會另建第二個對象。資料庫會保留每次修改前後的稽核紀錄；這些稽核歷史目前還沒有獨立的網頁查閱畫面。

## 7. 測試 Gemini

登入後按上方「AI 整理」，輸入完整年份的測試文字：

> 2026/09/20 到 2026/09/23 上海出差，參加洗滌展，搭華航商務艙。

按「整理並儲存」。資料完整時會自動儲存；若有缺漏，顯示整理內容，補填後再儲存。

再測一筆待辦：

> 請提醒我明天確認設備報價明細。

Gemini 應整理並儲存待辦，月曆會標示日期；資料不足時先補充。

只寫「09/20」沒有年份時，系統要求補填，避免把年份猜錯。若對象未建檔，先建立對象，再重新整理或在表單選擇正確對象。

預設模型是 Gemini 3.1 Flash-Lite。若你的專案無此模型權限，修改 GEMINI_MODEL 成 AI Studio 中可用、支援結構化輸出的模型，再執行 companybrain-start 重建。金鑰與模型在 NAS 後端使用，不會送給瀏覽器。

## 8. 匯入以前試填的內容

程式更新後，在原本「同一台裝置、同一個瀏覽器、同一個預覽網址」開啟體驗版，按「匯出試填資料」，取得 JSON 檔。未修改的示範紀錄不會被匯出；已用示範筆修改過的內容需自行檢查。

NAS 正式網頁登入後按「匯入資料」，選這個 JSON。匯入採追加模式，不會清空現有資料；遇到同一 ID 但不同內容會停止，避免覆蓋。

改到不同網址不會自動搬移瀏覽器資料。若曾在多台裝置試填，需分別匯出及檢查。

## 9. 設定公司外部也能使用的 HTTPS 網址

這一步需要你可控制的網域／DDNS 名稱、有效 HTTPS 憑證及可到達 NAS 的連線。只有新增 DSM 反向代理規則，並不會自動完成 DNS、路由器或隧道設定。若現在已有外網通道，先確認它如何轉送，使用獨立的 companybrain 網址，不要直接覆蓋設備管理系統的規則。

一般 DSM 反向代理方式：

1. 讓新的網址指向 NAS 所在網路，且外部 HTTPS 流量能到達 NAS 的 443（若已有隧道，按該隧道的轉送設定）。
2. DSM → 控制台 → 登入入口 → 進階 → 反向代理 → 新增。
3. 名稱：companybrain。
4. 來源：HTTPS、你選定的公司專用主機名稱、port 443。
5. 目的地：HTTP、127.0.0.1、port 8788。
6. DSM → 控制台 → 安全性 → 憑證，為此主機名稱設定有效憑證，並指定給對應服務。
7. settings.env 改為下列值：

```dotenv
PUBLIC_ORIGIN=https://你的companybrain完整網址
APP_BIND=127.0.0.1
APP_PORT=8788
COOKIE_SECURE=true
```

保留其他設定，重新執行 companybrain-start。

之後正式網頁只使用 HTTPS 網址；區網 IP:8788 不再直接開放。用手機關掉 Wi-Fi，以行動網路開 HTTPS 網址測試登入、存一筆待辦、再用電腦讀取。

員工／使用者只登入此網頁，不必另外登入 DSM。新增員工個別帳號與權限是後續功能。

## 10. 備份

在任務排程器建立手動任務 companybrain-backup，使用者 root：

```sh
set -eu
cd /volume1/docker/companybrain
sh scripts/backup.sh
```

執行後，`companybrain/backups` 會出現 `.sql.gz` 檔。此備份包括公司資料、LINE 照片／語音原檔、帳號及稽核歷史。先手動確認成功，再視需要設定每天非工作時間執行。

另外保留 settings.env 的安全副本。資料庫 volume 留在 NAS，但僅留在同一台 NAS 不足以防止硬碟或整台 NAS 故障，應再將備份複製到其他安全位置。還原會修改資料庫，請在實際需要還原時再確認目標與檔案。

## 11. 以後更新

備份後，下載 GitHub 新版，覆蓋程式檔案；保留 `settings.env`、`.env`、backups 與資料庫 volume。再執行 companybrain-start。不要按會刪除 volume 的清理操作，也不要執行 `down -v`。

更改 API Key、登入密碼、模型或網址後，也需要重新執行 companybrain-start。重啟會要求重新登入，已存的公司資料會保留。

## 常見問題

| 狀況 | 先檢查 |
| --- | --- |
| 網頁打不開 | NAS IP、手機Wi-Fi、8788是否衝突、兩個容器是否運行、DSM防火牆是否允許受信任區網連到8788 |
| app一直重新啟動 | Container Manager → app容器→詳細資料→日誌；檢查密碼長度、資料庫密碼、PUBLIC_ORIGIN及Secure設定 |
| 顯示「網址不符」 | 開啟網頁的協定、主機、port是否與PUBLIC_ORIGIN完全相同 |
| 登入後一直要求登入 | HTTP測試要COOKIE_SECURE=false；HTTPS正式版要true，且用設定的HTTPS網址 |
| Gemini金鑰或權限無效 | settings.env金鑰是否完整，是否重新執行啟動任務；不要截圖金鑰 |
| 模型不存在／無權使用 | 修改GEMINI_MODEL為專案可用且支援JSON結構化輸出的模型 |
| Gemini額度或速率受限 | 稍後重試並檢查AI Studio用量；不會因此寫入假資料 |
| 另一台看不到 | 是否都使用同一個NAS網址且顯示「NAS已連線」；chatgpt.site體驗版是獨立本機資料 |
| Gemini沒有直接存入 | 檢查缺漏警告或儲存錯誤，先查看清單避免重複新增 |

## 驗證範圍與參考

已完成程式語法、HTTP登入、CSRF、失敗處理、版本衝突、前端本機／NAS模式、PostgreSQL相容資料庫的建表與稽核更新檢查。

尚未使用你的NAS硬體、真實外網DNS／憑證或API Key做端到端測試。首次安裝請依第5、7、9步驗證。第一版每次同步完整清單，後端將對象、紀錄、待辦分表儲存，單次限制各5000筆紀錄／待辦；大量資料時需改為分頁同步。

官方參考：

- https://ai.google.dev/gemini-api/docs/api-key
- https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite
- https://ai.google.dev/gemini-api/docs/generate-content/structured-output
- https://kb.synology.com/en-global/DSM/help/ContainerManager/docker_project

