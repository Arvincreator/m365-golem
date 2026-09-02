# M365 Golem

M365 Golem 是一套 Windows 本機 AI 工作台。它沿用 Project Golem 已驗證的
Action／Observation、Skills、MCP、人工核准與專案記憶架構，將推理層改為使用
**可見的 Microsoft Edge + Microsoft 365 Copilot Chat 網頁**；不呼叫 Copilot
Chat API，也不要求把 Microsoft 帳密、MFA、Cookie 或 Token 交給 Golem。

目前定位是可下載安裝的 POC／DEV 版本，不是 Microsoft 365 租戶正式上線核准。

## 主要能力

- Codex 式「專案 → 多個對話」工作區，同一專案共享獨立的工作規則與脈絡。
- 第一次對話載入 Golem 身分、專案背景、Action 規則與工具使用方式。
- 每輪只篩選並注入最相關的 Skills／MCP 工具，不把整本工具庫送進對話。
- 工具動作透過原版 Action Gate 執行，Observation 回到同一個專案對話。
- 內建 M365 Session Bridge，可操作**精確網址**指向的 SharePoint Online 或
  OneDrive for Business 檔案與資料夾。
- 專案本機資料加密保存；登入與 MFA 始終在可見 Edge 由使用者親自完成。

## 系統需求

- Windows 10／11
- Node.js 20 以上
- npm
- Microsoft Edge
- 可使用 Microsoft 365 Copilot Chat 的組織帳號

## 全新下載後安裝

1. 從 GitHub 下載並解壓縮，或 clone 本倉庫。
2. 雙擊 `Install-M365-Golem.bat`。
3. 安裝器會以鎖版依賴建置 Golem、Dashboard 與內建 Session Bridge。
4. 依安裝畫面提示，在 Edge 開啟 `edge://extensions`：
   - 開啟「開發人員模式」；
   - 點「載入解壓縮」；
   - 選擇
     `integrations\m365-session-bridge\apps\edge-extension\dist`。
5. 雙擊 `Start-Golem.bat`。
6. 在自動開啟的可見 Edge 視窗自行完成登入與 MFA，再從本機工作台開始對話。

也可以在 PowerShell 執行：

```powershell
npm.cmd run install:m365
npm.cmd run dashboard
```

只檢查乾淨下載後的安裝計畫，不修改檔案或登錄：

```powershell
npm.cmd run install:m365:plan
```

## 內建 M365 Session Bridge

Bridge 隨本倉庫一起發布，不需要使用者另外下載另一個專案。安裝器會：

1. 從 `integrations/m365-session-bridge` 的 TypeScript 原始碼重建元件；
2. 只在目前 Windows 使用者的 `HKCU` 註冊 Edge Native Messaging host；
3. 將 `m365-session-bridge` 合併到本機 `data/mcp-servers.json`；
4. 在 `%LOCALAPPDATA%\M365-Golem\m365-session-bridge` 建立每台電腦專屬的
   政策、IPC 秘密與稽核紀錄。

它只支援精確 SharePoint Online／OneDrive for Business 網址與檔案操作，**不是**
Microsoft Graph、Outlook、Teams、Calendar 或整個 M365 的搜尋連接器。初始政策：

- 寫入預設關閉；
- 覆寫、永久刪除、外部分享、權限修改、批次刪除及任意 HTTP 永遠預設禁止；
- 未列入的支援站台必須經本機原生核准視窗確認；
- 本機檔案範圍預設只允許目前 M365 Golem 專案根目錄；
- Microsoft 365 權限仍完全來自使用者現有的 Edge 登入與租戶授權。

Bridge 不會讓 Golem 自動取得整個 M365。若需要 Outlook、Teams、Calendar 或一般
SharePoint 搜尋，應另外使用權限範圍清楚的官方連接器。

## GitHub `main` 的乾淨發布界線

`main` 應只包含可重建、可審查的來源與範本。下列內容不得提交：

- `.env`、帳密、Token、Cookie、Edge profile 或 MFA 資料；
- `node_modules`、Next.js／TypeScript 編譯輸出；
- `data/mcp-servers.json` 與任何機器絕對路徑；
- M365 租戶、站台或文件庫白名單；
- Bridge 的 IPC 秘密、政策修改、日誌與 Native Messaging 實機 manifest；
- 本機專案對話、資料庫、向量索引與使用者長期偏好。

這些內容都在安裝或執行時於本機生成，並由 `.gitignore` 排除。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `npm.cmd run dashboard` | 啟動本機工作台與可見 Edge |
| `npm.cmd run install:m365` | 執行完整 Windows 安裝 |
| `npm.cmd run install:m365:plan` | 唯讀檢查全新安裝前提 |
| `npm.cmd run bridge:build` | 重建內建 Session Bridge |
| `npm.cmd run bridge:test` | 執行 Bridge 單元／整合測試 |
| `npm.cmd run arch:check` | 檢查架構邊界 |
| `npm.cmd test -- --runInBand` | 執行 Golem 測試 |

## 安全與驗收

- [M365 Copilot Chat Web POC 安全與驗收說明](docs/M365-COPILOT-WEB-POC.zh-TW.md)
- [M365 專用來源分析與差異](docs/M365-ONLY-SOURCE-ANALYSIS.zh-TW.md)
- [內建 Bridge 說明](integrations/m365-session-bridge/README.md)

自動測試、成功建置、人工 Edge 登入、租戶授權、實際檔案操作、正式部署與 production
核准是不同階段；不得因為其中一項通過就宣稱其他階段也完成。

## 授權與來源

本專案由 Project Golem 原始碼改造，保留原倉庫的來源歷史與模組化設計。使用與再散布
受本倉庫 [LICENSE](LICENSE) 約束；公司或組織的正式營運使用，仍須完成權利與法務確認。
