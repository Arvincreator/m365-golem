# 🦞 Golem Web Dashboard v2.1

這是 Project Golem 的官方 Web 控制面板，基於 Next.js 16 與 Tailwind CSS 4 構建。提供實時監控、Agent 會議觀察與多模態互動介面。

## 🌟 核心功能

-   **實時指標**: 監控 CPU、記憶體佔用與系統運行時間。
-   **時序雷達 (Chronos Radar)**: 視覺化即將執行的排程任務。
-   **隊列交通 (Traffic Control)**: 即時觀察訊息處理流程與 Agent 協作狀態。
-   **神經日誌 (Neuro-Link Stream)**: 支援過濾與分類的全域日誌流。
-   **多智能體監控**: 專屬的互動式多 Agent 會議頻道。
-   **技能書備份匯入/匯出**: 支援匯出整本技能書、單一技能檔案，並可從 `.md/.json` 透過預覽與衝突策略快速還原。
-   **雙語介面 (i18n)**: 支援繁體中文 / English 切換，主要頁面與關鍵彈窗已雙語化。
-   **更新跑馬燈提醒**: Dashboard 首頁可即時提示 GitHub 新版，並引導至系統總表一鍵更新。
-   **市場原文顯示策略**: 技能市場與人格市場優先顯示來源原文字段，降低翻譯偏移。
-   **安全強化**: 遠端登入 Session、操作防護（`SYSTEM_OP_TOKEN`）、API rate limit、上傳邊界檢查。

## 🆕 近期更新（2026-03-24）

-   新增全站語系切換（`繁體中文` / `English`），語系偏好會自動記憶。
-   新增首頁更新跑馬燈：偵測到版本落後時，會顯示提示並提供前往一鍵更新入口。
-   技能市場改為優先顯示 `original_description`、`category_name.en` 等原文字段。
-   人格市場改為優先顯示原文 `name / description / role`，設定彈窗可完整套用英文資料。
-   修正人格套用時表單被重複 hydration 覆蓋的問題，套用與儲存流程更穩定。

## 🚀 快速啟動

當您啟動 Project Golem 主程式時，Web Dashboard 會自動隨之啟動：

```bash
# 在根目錄執行
npm run dashboard
```

或是手動啟動開發開發環境：

```bash
cd web-dashboard
npm install
npm run dev
```

啟動後請訪問：[http://localhost:3000/dashboard](http://localhost:3000/dashboard)

## 🛠️ 技術堆疊

-   **框架**: [Next.js](https://nextjs.org/)
-   **通訊**: [Socket.io](https://socket.io/) (實時同步)
-   **樣式**: [Tailwind CSS 4](https://tailwindcss.com/)
-   **元件**: Radix UI + Lucide Icons
-   **視覺化**: Recharts

## 🔧 自定義配置

您可以透過根目錄的 `.env` 檔案調整埠號：
```env
DASHBOARD_PORT=3000
ALLOW_REMOTE_ACCESS=false
# 若開啟遠端存取，建議一併設定：
# REMOTE_ACCESS_PASSWORD=your-strong-password
# SYSTEM_OP_TOKEN=your-operation-token
```

---
**Developed with ❤️ by Arvincreator**
