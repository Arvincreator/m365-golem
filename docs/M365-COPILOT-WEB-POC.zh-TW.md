# Microsoft 365 Copilot Chat Web POC

## 目前結論

本分支新增 `m365-web` 後端，透過 Playwright 操作可見的 Microsoft Edge 與 Microsoft 365 Copilot Chat 網頁。此路徑不呼叫 Copilot Chat API，也不需要先開啟相關 API 權限。

目前狀態是「POC 已完成真實租戶的人工登入、送出與回覆擷取驗證」，但不是正式環境核准或部署完成。Microsoft 365 前端 DOM 仍可能改版，因此每次 selector 調整都須重新用真實頁面驗證。

## POC 安全邊界

`M365_POC_SAFE_MODE=true` 時，系統會套用以下限制：

- 只允許純文字聊天，不處理附件。
- 專案、對話與訊息會保存於本機加密的 M365 Workspace 資料庫，供 Codex 式專案對話重新載入；但不寫入 GOLEM 長期記憶、金字塔聊天記憶或舊版預覽緩衝。
- 不初始化或注入 GOLEM 的長期記憶、Embedding 記憶、Wiki 內容或舊對話。新建或尚未綁定 M365 的專案對話會在使用者第一次明確送訊時，一併送出不含本機指紋的 Golem 操作背景；之後每回合只注入目前專案脈絡與最小必要的工具路由提示。
- 一次只處理一則訊息；處理期間必須在程序記憶體暫持當前文字，第二則訊息會被拒絕而不排隊，完成後不保留「上一則重試」內容。這不是作業系統層級的記憶體清除保證。
- 不召回或注入 GOLEM 記憶、Wiki、參考文件、學習紀錄或整本技能庫；工具路由只提供本輪向量檢索命中的少量工具與節錄使用指南。
- 工具總開關預設關閉。本工作副本是在使用者明確同意後才啟用；模型可以提出 `GOLEM_ACTION`，但所有本機指令、Skill、MCP 或多代理動作都先寫入原版 `pendingTasks`，顯示在目前專案對話右側；使用者未按「核准執行」前不會執行。原版 Action Gate 與命令風險檢查仍會在核准後生效。
- 不啟動背景自主喚醒或反思回合。
- 不執行 Dashboard 的背景遠端版本或 Git 更新巡檢；更新檢查端點只回傳本機停用狀態。
- 不啟動 GOLEM 對話歸檔或 24 小時瀏覽器自動重啟；瀏覽器健康檢查只會在使用者明確送出訊息時發生。
- 啟動時不自動送出任何訊息。
- 不把 M365 頁面 HTML 傳給 Gemini DOM Doctor。
- 不擷取 M365 回覆中的附件或下載連結。
- 不修剪或移除 M365 應用程式的頁面 DOM。
- 不隱藏 Edge 視窗，讓登入、MFA、條款與租戶提示保持可見。
- 不自動刪除 Edge 設定檔鎖定檔；設定檔正在使用時會停止並請使用者處理。
- 只允許導航到已列入程式允許清單的 Microsoft 365 Copilot Chat 網域。

上述限制只約束 GOLEM 自己的記憶、日誌與動作。Microsoft 365 服務端的聊天歷史、稽核、保留或 eDiscovery 政策，以及獨立 Edge 設定檔中的 Cookie、快取與登入狀態，仍依 Microsoft 與租戶政策保存；本 POC 不會關閉或清除它們。

官方參考：[Copilot Chat 存取位置](https://learn.microsoft.com/en-us/copilot/overview#where-to-access-copilot-chat)、[隱私、提示與回覆保存說明](https://learn.microsoft.com/en-us/copilot/privacy-and-protections)。

若訊息是從 Telegram 或 Discord 傳入，該平台與 Bot 的訊息保存政策也會另外適用；要求「GOLEM 本機不留存」不等於這些外部通道沒有留存。因此第一次驗證建議只用本機 Dashboard 與無敏感測試文字。

這也不是整台主機的緊急停止開關：如果原專案另有使用者事先啟用、且與本聊天無關的獨立整合或排程，它們仍須在各自設定中停用。

## Golem 啟動背景與每輪工具路由

這一版沿用原始 `project-golem-main` 的核心設計，不另造一套代理協定：

1. 新專案對話的第一則使用者訊息會帶入 Golem 身分、目前人格、本機 harness 與 M365 推理層的分工、Action 格式、人工核准規則及 Observation 回傳方式。它不會在背景自動送出啟動訊息。
2. 初始背景不會列出 Windows 使用者名稱、本機絕對路徑、系統指紋或完整 Skill/MCP 清單。這些資料不是教會模型使用工具所必需，也不應整包送往 M365。
3. 每一輪都由原版工具向量索引依使用者意圖篩選候選工具。M365 模式的向量索引使用純本機模型，內容只包含 Skill／MCP 的名稱、說明與觸發詞，與聊天長期記憶分開；命中的 Skill 會附上精簡使用指南，命中的 MCP 會附精確 server/tool/schema，一般唯讀本機檢查則會給出 `command` Action 範例。
4. 當使用者已明確要求查看、列出、檢查、搜尋或操作，且本輪路由已有可行工具時，模型應直接產生最小必要的 `GOLEM_ACTION`，不可只回答「我可以提出 Action」。
5. Action 仍不是執行結果。它必須先出現在本機待核准區，由使用者核准並通過 Action Gate；只有收到本機 Observation 後，模型才能描述實際結果。

舊對話不會被追溯補送完整啟動背景；但每輪 Action 規則與工具路由仍會更新。要驗證完整啟動教育，請建立新的專案對話。

## 建議設定

請在 `.env` 使用獨立工作設定檔，避免和日常 Edge 視窗共用同一個瀏覽器資料目錄：

```env
GOLEM_BACKEND=m365-web
PLAYWRIGHT_PROFILE=m365-work
PLAYWRIGHT_HEADLESS=false

M365_COPILOT_URLS=https://m365.cloud.microsoft/chat
M365_POC_SAFE_MODE=true
M365_LOCAL_MEMORY_ENABLED=false
M365_ACTIONS_ENABLED=false
M365_AUTO_BOOT_PROMPT=false
M365_PAGE_READY_TIMEOUT_MS=20000
M365_RESPONSE_TIMEOUT_MS=60000

PLAYWRIGHT_M365_BROWSER_CHANNEL=msedge
PLAYWRIGHT_M365_STEALTH_ENABLED=false
PLAYWRIGHT_M365_BLOCK_HEAVY_RESOURCES=false
```

不要把帳號、密碼、MFA 驗證碼、Cookie 或 Token 寫入 `.env`、測試檔或日誌。

## 第一次人工驗證流程

1. 在 Windows 安全工作副本執行 `Start-M365-POC.bat`；它會確認 `.env` 使用 `m365-web`，再啟動本機 Dashboard 與獨立的可見 Edge 工作視窗。M365 POC 預熱不要求先建立 GOLEM persona 或記憶。
2. 若畫面進入 Microsoft 登入頁，GOLEM 會回報 `M365_HUMAN_LOGIN_REQUIRED` 並停止；由使用者自行完成帳密、MFA、裝置合規或條款確認。
3. 登入完成並看到 Copilot Chat 輸入框後，再從 GOLEM 明確送出一則無敏感資料的測試訊息。
4. 建議測試文字使用唯一標記，例如：`請只回覆 POC-M365-READY-20260831`。
5. 驗證 GOLEM 收到同一標記，且 Microsoft 365 頁面只新增一組使用者訊息與一組 Copilot 回覆。
6. 關閉並重開 GOLEM，確認獨立 Edge 設定檔能保留登入狀態；若租戶要求重新驗證，仍由使用者人工完成。

2026-08-31 的受監督驗證結果：租戶在 Edge 重啟後要求使用者重新登入；登入後連續兩則純文字訊息皆成功送出，回覆透過 `[role="article"].fai-CopilotMessage [data-testid="lastChatMessage"]` 擷取，狀態為 `ENVELOPE_COMPLETE`，並顯示於本機 Dashboard。執行中的 Edge 程序也已確認不含 `--no-sandbox` 或 `--disable-setuid-sandbox`。

安全模式中的 `/new` 只會重新載入 Copilot Chat 頁面，不保證 Microsoft 端建立一個全新對話；必須以可見 Edge 畫面確認。M365 專案對話只接受本機工作台中、且綁定同一 conversationId 的工具核准；舊版未綁定對話的 Dashboard callback 仍會被拒絕。

實際測試不要使用客戶資料、個資、未公開財務資料或其他機密內容。

## 可辨識的停止狀態

| 狀態碼 | 意義 | 下一步 |
| --- | --- | --- |
| `M365_HUMAN_LOGIN_REQUIRED` | 位於 Microsoft 登入或 MFA 流程 | 使用者在可見 Edge 視窗完成驗證，再重試 |
| `M365_TENANT_BLOCKED` | 頁面顯示租戶原則未開放 Copilot Chat | 請管理部確認租戶開關或授權 |
| `M365_UI_NOT_READY` | 已到 M365 網域，但找不到可信的聊天輸入框 | 人工查看頁面提示；必要時更新 selector |
| `M365_UI_BUSY` | Copilot 仍顯示正在產生回覆 | 不送出新訊息；先查看 Edge 並等待完成 |
| `M365_UNEXPECTED_HOST` | 目標或跳轉網域不在允許清單 | 停止，不要繞過；先確認網址與登入流程 |
| `M365_INSECURE_URL` | 目標或跳轉不是 HTTPS | 停止；只使用正式 HTTPS 網址 |
| `BROWSER_PROFILE_IN_USE` | 同一個 Edge 工作設定檔正被其他程序使用 | 關閉該設定檔視窗後重試，不刪鎖定檔 |
| `M365_ATTACHMENT_DISABLED` | POC 收到附件請求 | 改用無敏感資料的純文字測試 |
| `M365_SEND_UNCONFIRMED` | 已嘗試一次送出，但無法確認是否成功 | 不自動重送；先查看 Edge 頁面，避免重複訊息 |
| `M365_RESPONSE_NOT_FOUND` | 送出成功，但 60 秒內沒有命中可信的 Copilot 回覆節點 | 查看主控台的 selector 計數；診斷只含節點屬性與文字長度，不含提示或回覆內容 |

## 尚未通過的項目

- 尚未驗證租戶的服務端聊天歷史、稽核與資料保留設定；這些不由 GOLEM 安全模式控制。
- 尚未證明目前 selector 能涵蓋其他租戶、語言或未來 Microsoft 365 UI 版本；找不到可信節點時仍會在 60 秒內停止且不自動重送。
- M365 網頁本身的附件、引用、語音、Agent 與 Microsoft 365 工作負載自動操作仍不在傳輸 POC 範圍。另行安裝的 Skill/MCP 只能在其既有權限與本機核准範圍內執行，不能視為租戶管理員已授權或正式上線。
- `M365_POC_SAFE_MODE=false`、`M365_LOCAL_MEMORY_ENABLED=true` 或 `M365_ACTIONS_ENABLED=true` 即使存在，也不代表已核准；啟用前需要另外做資料邊界、權限與人工審查。工具總開關即使開啟，也只代表可以「提出並人工核准」本機工具動作，不是自動核准。

## 外部範例的採用邊界

本 POC 參考了 [nobodyzxc/m365-copilot-cli](https://github.com/nobodyzxc/m365-copilot-cli) 的 Playwright 網頁層做法（檢視基準：[`5c14038`](https://github.com/nobodyzxc/m365-copilot-cli/commit/5c1403818e335778285e8b054089ce3434c48340)）；該專案的終端畫面只是介面，底層同樣是操作登入後的 Copilot 網頁。此次只吸收較明確的 DOM 訊號與完成判定觀念：`Ask`／`Copilot` 輸入框、`data-content="ai-message"`／`data-message-author="bot"` 回覆節點、typing/busy 指示器，以及「新回覆文字穩定後才視為完成」。

沒有搬用它的終端 UI、headless 預設、`auth-windows.json` session 匯出、純文字 prompt history、寬鬆 selector 自動改寫或包含回覆內容的 DOM debug dump。本 POC 仍使用可見 Edge 的獨立 persistent profile、人工登入/MFA、保守 selector、找不到即停止，以及 GOLEM 本機不留存聊天內容的邊界。

## 自動驗證

本 POC 的自動驗證至少應包含：

```powershell
npm.cmd run arch:check
npm.cmd test -- --runInBand tests/BrowserLauncher.m365.test.js tests/PageInteractor.m365.test.js tests/WebBackend.m365.test.js tests/Config.m365.test.js tests/ProtocolFormatter.m365.test.js tests/ResponseExtractor.m365.timeout.test.js tests/GolemBrain.m365.init.test.js tests/ResponseParser.m365.test.js tests/NeuroShunter.m365.test.js tests/ConversationManager.m365-privacy.test.js tests/MessageManager.m365-transient.test.js tests/WebServer.m365-transient.test.js tests/WebChatRoutes.m365.test.js tests/SystemRoutes.m365.test.js tests/AutonomyManager.m365.test.js
```

Dashboard 可執行 TypeScript 檢查與正式 build。若安全工作副本使用外部 `node_modules` 接合點，Turbopack 可能拒絕該接合點；可用 `next build --webpack` 做同等的完整編譯驗證。
