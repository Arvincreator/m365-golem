# 貢獻指南

感謝您有興趣貢獻 Project Golem！這份指南將協助您開始。

## 目錄

- [行為準則](#行為準則)
- [快速開始](#快速開始)
- [開發環境設置](#開發環境設置)
- [架構概覽](#架構概覽)
- [提交變更](#提交變更)
- [測試](#測試)
- [Pull Request 流程](#pull-request-流程)
- [編碼規範](#編碼規範)

## 行為準則

請保持尊重、建設性與協作精神。我們歡迎各種經驗水平的貢獻者。

## 快速開始

### 必備條件

- **Node.js** 20+ (建議 LTS)
- **Docker** (選填，用於容器化部署)
- **Google Gemini API Key** (可在 [aistudio.google.com](https://aistudio.google.com) 取得免費額度)

### 快速上手

```bash
# 複製專案
git clone https://github.com/Arvincreator/project-golem.git
cd project-golem

# 安裝依賴
npm install

# 複製環境變數範本
cp .env.example .env
# 編輯 .env 並加入您的 GEMINI_API_KEYS（可用逗號分隔多組）
```

## 開發環境設置

```bash
# 安裝所有依賴（包含開發依賴）
npm install

# 執行測試
npx jest --verbose

# 檢查架構邊界
npm run arch:check

# 以診斷模式執行
node index.js --doctor
```

## 架構概覽

- **App Layer**：`apps/runtime/index.js`（核心入口）與 `apps/dashboard/plugin.js`（Dashboard 插件）。
- **相容入口**：根目錄 `index.js`、`dashboard.js` 為 shim，確保舊指令可用。
- **`src` 三層骨架**：`src/domain`、`src/application`、`src/infrastructure`（漸進遷移中）。
- **GolemBrain**：AI 核心，透過 **Playwright（瀏覽器模式）** 連結 Google Gemini。
- **Titan Protocol**：Golem 內部使用的結構化回應格式，包含 `[GOLEM_ACTION]`, `[GOLEM_MEMORY]`, `[GOLEM_REPLY]`。
- **Skills**：在 `src/skills/` 中定義的模組化能力。
- **EventBus**：用於組件間通訊的解耦發佈/訂閱系統。

詳細開發說明請參考對應的技能原始碼。

## 提交變更

### 分支命名規範

```
feat/feature-name       # 新功能
fix/bug-description     # 修補錯誤
docs/what-changed       # 文件更新
test/what-tested        # 僅測試相關
refactor/what-changed   # 程式碼重構
```

### Commit 訊息規範

請遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 增加 API 端點的速率限制
fix: 處理 PageInteractor 中的空回應
docs: 加入架構概覽說明
```

## 測試

我們使用 **Jest** 進行測試。所有新功能都應包含測試。

```bash
# 執行所有測試
npx jest --verbose

# 執行特定測試檔案
npx jest tests/EventBus.test.js --verbose
```

## Pull Request 流程

1. **Fork** 專案倉庫。
2. 從 `main` 分支 **建立** 功能分支。
3. **實作** 您的變更並包含測試。
4. **提交** (Commit) 訊息需符合規範。
5. **推送** (Push) 到您的 Fork 倉庫。
6. 對 `Arvincreator/project-golem:main` 發起 **PR**。

## 編碼規範

- 在所有 Node.js 檔案中使用 `'use strict'`。
- 優先使用 async/await 而非原始的 Promises。
- 控制單一檔案長度在 300 行以內。
- Web 控制台 (web-dashboard) 使用 Tailwind CSS 進行樣式設計。

## 需要幫助？

- 提交 [Issue](https://github.com/Arvincreator/project-golem/issues) 回報錯誤或功能請求。
- 在建立新 Issue 前請先檢查現有的 Issue。

---

祝您開發愉快！ 🤖
