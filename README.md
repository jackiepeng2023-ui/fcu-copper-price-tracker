# 原物料物價記錄系統 — 銅價追蹤模組

> **逢甲大學學士後資訊工程系 113 學年度專題**  
> 學生：彭孝桓（Jack Peng）  
> 主題：原物料物價記錄系統（LME 銅期貨 HG=F）

---

## 專案簡介

本系統追蹤 LME 銅期貨（Yahoo Finance 代碼：`HG=F`）每日收盤價，單位 USD/lb。  
支援從 **1980-01-01** 至今的完整歷史資料批次抓取，並提供互動式走勢圖、KPI 看板、爬蟲執行日誌。

---

## 系統架構

| 層級 | 技術 |
|------|------|
| 前端 | 純 HTML + CSS + Chart.js（無框架）|
| 後端 | Node.js 22 + Express 4（ESM `import/export`）|
| 資料庫 | SQLite3（callback 風格，非 better-sqlite3）|
| 爬蟲 | Yahoo Finance v8 Chart API（`HG=F`，HTTPS）|

---

## 快速開始

```bash
# 1. 安裝相依套件（macOS 請先確認 node 22+）
npm install

# 2. 若遇到 sqlite3 macOS Gatekeeper 問題，請先重建 native module
rm -rf node_modules && npm install

# 3. 啟動伺服器
npm start
# → http://localhost:3000
```

---

## 主要功能

- **1980 年至今歷史批次初始化** — 一鍵抓取完整歷史（~11,000+ 筆），已存在自動跳過
- **任意區間批次抓取** — 自訂起迄日期批次爬取
- **今日即時抓取** — 一鍵取得最新 HG=F 收盤價
- **手動新增 / 刪除記錄**
- **Chart.js 互動走勢圖** — 支援日期區間篩選
- **統計 KPI** — 最新價、最高、最低、區間漲跌幅
- **爬蟲執行日誌** — 顯示最近 20 筆執行紀錄

---

## API 文件

OpenAPI 3.0 規格檔：`openapi.yaml`（可匯入 [Swagger Editor](https://editor.swagger.io/) 預覽）

| Method | 路徑 | 說明 |
|--------|------|------|
| GET | `/api/prices?start=&end=` | 查詢銅價記錄 |
| POST | `/api/prices` | 手動新增記錄 |
| DELETE | `/api/prices/:id` | 刪除記錄 |
| GET | `/api/stats` | 統計摘要（KPI）|
| GET | `/api/fetch-range?start=1980-01-01&end=今日` | 批次抓取歷史區間 |
| GET | `/api/fetch` | 今日單筆抓取 |
| GET | `/api/fetch-log` | 最近 20 筆爬蟲日誌 |

---

## 資料庫設計

### `copper_prices`
| 欄位 | 型態 | 說明 |
|------|------|------|
| id | INTEGER PK | 自動遞增 |
| date | TEXT | 日期（YYYY-MM-DD）|
| price_usd | REAL | 收盤價（USD/lb）|
| unit | TEXT | 固定值 'USD/lb' |
| source | TEXT | 資料來源 |
| note | TEXT | 備註 |
| created_at | TEXT | 寫入時間 |

### `fetch_log`
| 欄位 | 型態 | 說明 |
|------|------|------|
| id | INTEGER PK | 自動遞增 |
| fetched_at | TEXT | 執行時間 |
| status | TEXT | 'success' 或 'error' |
| message | TEXT | 詳細訊息 |

---

## 注意事項

- macOS 上的 `sqlite3` 為 native module，若出現 code signature 錯誤，請執行 `rm -rf node_modules && npm install` 重新編譯
- Yahoo Finance API 無需 API Key，但長區間（如 1980 至今）需要 15~45 秒
- `db/sqlite.db` 於啟動時自動建立，不需手動建立

---

## 部署到 Azure / Render

本專案已針對雲端部署做以下調整：

- **PORT**：`bin/www` 已使用 `process.env.PORT || '3000'`，平台動態分配的 port 可正常運作，不需修改。
- **`package.json`**：已加上 `"engines": { "node": ">=18" }`，避免雲端平台用不相容的 Node 版本建置。
- **SQLite 路徑**：`app.js` 會偵測 `WEBSITE_SITE_NAME` 環境變數（Azure App Service 自動注入）：
  - **在 Azure 上** → 資料庫寫入 `/home/data/sqlite.db`（持久化磁碟，重啟、重新部署都不會消失）
  - **本機 / Render** → 沿用 `db/sqlite.db`（Render 免費版重啟後會重置，這是預期行為，作業 demo 足夠用）

### 平台選擇建議

| 需求 | 建議平台 | 原因 |
|------|----------|------|
| 只是交作業 demo，給老師看一次 | **Render** | 15–20 分鐘部署完成，操作步驟最少 |
| 想長期保留 1980 年至今的完整歷史資料（~11,000+ 筆） | **Azure** | F1 方案的 `/home` 資料夾持久化，免費且不會因重新部署而清空 |
| 想累積履歷上「雲端部署經驗」 | **Azure** | App Service + GitHub Actions CI/CD 流程更接近業界實作 |

兩個平台的部署步驟（Build Command、Start Command、環境變數設定、`SCM_DO_BUILD_DURING_DEPLOYMENT` 等）皆需在各自的 Web 後台手動操作，無法由程式自動完成。

---



## GitHub 上傳

```bash
git init
git add .
git commit -m "feat: 完成銅價記錄系統 + OpenAPI 3.0 + 1980歷史一鍵抓取"
git branch -M main
git remote add origin https://github.com/<你的帳號>/fcu-copper-price-tracker.git
git push -u origin main
```

