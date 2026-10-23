# 客衣攝影機獨立服務（規劃中）
部署目標：Synology DS223 Container Manager，與現有 CompanyBrain AI 服務隔離。

## 已確認
- 攝影機：192.168.1.87，ONVIF 8087；原始 Python 測試每 8 秒拍照、QR 穩定 1 秒。
- QR 格式：HOTEL:<飯店代碼>（須先完成群組綁定）。
- LINE Webhook 現有入口：https://fileserver.tailbb066f.ts.net:10000/api/line/webhook（不可替換）。
- 客衣工作群組收到成功或異常通知；飯店群組只收相應照片。
- 已成功送出且滿 24 小時的暫存照片自動清除；未送達者保留並警示。
- 管理員綁定群組需要 GARMENT_ADMIN_USER_IDS 白名單。
- LINE 圖片 originalContentUrl / previewImageUrl 必須是 LINE 伺服器可讀取的 HTTPS 網址，且需要難猜測的短期 token。
- 不公開 NAS 整個照片資料夾；不將攝影機密碼、LINE Token 放進 GitHub。

## 尚未完成（禁止直接部署）
1. 攝影機擷取程式容器化、RTSP 斷線重連及錯誤監控。
2. QR 解析、飯店群組查詢、照片任務佇列及傳送去重。
3. LINE 圖片安全公開端點與原圖/預覽圖。
4. 24 小時清理及未成功傳送的保留、告警。
5. 群組綁定功能整合測試、NAS 網路與 HTTPS 可達性測試。
6. 正式版部署及回復方案。
