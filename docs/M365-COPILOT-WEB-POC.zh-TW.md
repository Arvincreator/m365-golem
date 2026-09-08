# Microsoft 365 Copilot Chat Web POC

## 目前結論

本分支新增 `m365-web` 後端，透過 Playwright 操作可見的 Microsoft Edge 與 Microsoft 365 Copilot Chat 網頁。此路徑不呼叫 Copilot Chat API，也不需要先開啟相關 API 權限。

目前狀態是「POC 已完成真實租戶的人工登入、送出與回覆擷取驗證」，但不是正式環境核准或部署完成。Microsoft 365 前端 DOM 仍可能改版，因此每次 selector 調整都須重新用真實頁面驗證。

## POC 安全邊界

`M365_POC_SAFE_MODE=true` 時，系統會套用以下限制：

- 對話附件只接受由目前專案與對話綁定的本機暫存批次；每個檔案都會重新檢查名稱、類型、大小與雜湊，貼入可見 M365 頁面後，必須等 OneDrive 上傳完成、檔名可見且送出鍵連續穩定可用才會送出。
- 使用者從對話框選擇本機資料夾時，只在加密草稿保存本輪路徑參照，不會因選取而列出、索引或上傳其中檔案。Copilot 必須透過專用的唯讀資料夾動作，先取得最多 100 個直屬項目，或做有掃描上限的檔名搜尋，再只讀取需要的個別文字／程式碼檔；單檔限制 1 MiB、回傳限制 20,000 字。磁碟根目錄、越界路徑、隱藏／依賴／建置路徑、符號連結、非文字格式與可能包含憑證的內容會拒絕。資料夾動作不交給 shell，拖曳資料夾也不會遞迴掃描。
- 專案、對話與訊息會保存於本機加密的 M365 Workspace 資料庫，供 Codex 式專案對話重新載入；但不寫入 GOLEM 長期記憶、金字塔聊天記憶或舊版預覽緩衝。
- 不初始化或注入 GOLEM 的長期記憶、Embedding 記憶、Wiki 內容或舊對話。新建或尚未綁定 M365 的專案對話會在使用者第一次明確送訊時，一併送出不含本機指紋的 Golem 操作背景；之後每回合只注入目前專案脈絡與最小必要的工具路由提示。
- 可見 Edge 一次仍只派送一則訊息，但使用者可繼續輸入，後續對話會依 FIFO 排隊；Action 另有獨立序列佇列。佇列內會保存每則訊息當時選定的回覆模式與工具偏好，避免後來改設定影響前一則。程序異常終止時，尚未派送的程序內佇列不視為已完成。
- 不召回或注入 GOLEM 的全域記憶、Wiki 或整本技能庫；只載入目前專案的近期狀態與語意相關記憶、使用者本輪選定的知識來源，以及向量路由命中的少量工具與節錄使用指南。專案記憶包含經確認的工作紀錄、規則、決策、現況、專案偏好，以及過去有效做法、失敗根因與避免再次踩坑的經驗；需要較早紀錄時，只能在目前專案範圍內查詢。
- 模型可以提出 `GOLEM_ACTION`，但所有本機指令、可執行 Skill 與 MCP 動作都先寫入原版 `pendingTasks`，顯示在目前專案對話右側；是否自動核准依使用者選定的核准模式與風險等級決定。原版 Action Gate 與命令風險檢查仍會在執行前生效。多代理功能已從 M365 版退役。
- 提出實際工具動作時，Copilot 依真正送入執行器的 action，以 50 字內的「實際操作與核對內容，正在執行並確認中…」回報進度；不採用可能與執行內容不符的計畫標題，內部命令與技術名稱也不顯示在一般對話中。
- 同一個自主工作的 action 進度在主對話中只呈現一張預設收合的執行卡，執行中會顯示動畫與最新動作；使用者展開後才看到完整逐步紀錄。正式結果仍以一般 Golem 回覆呈現。M365 產生的 `Plain Text` 或其他程式碼檢視也會還原成獨立內容卡，而不是把語言標籤與行號攤平成段落。
- 不啟動背景自主喚醒或反思回合。
- 不執行 Dashboard 的背景遠端版本或 Git 更新巡檢；更新檢查端點只回傳本機停用狀態。
- 不啟動 GOLEM 對話歸檔或 24 小時瀏覽器自動重啟；瀏覽器健康檢查只會在使用者明確送出訊息時發生。
- 啟動時不自動送出任何訊息。
- 不把 M365 頁面 HTML 傳給 Gemini DOM Doctor。
- M365 回覆中的可見附件／下載連結會以可點擊連結帶回 Golem 介面，但不會在沒有使用者要求時自行下載；實際存取仍受 Microsoft 登入狀態、租戶政策與連結時效限制。
- 不修剪或移除 M365 應用程式的頁面 DOM。
- 不隱藏 Edge 視窗，讓登入、MFA、條款與租戶提示保持可見。
- 不自動刪除 Edge 設定檔鎖定檔；設定檔正在使用時會停止並請使用者處理。
- 只允許導航到已列入程式允許清單的 Microsoft 365 Copilot Chat 網域。

上述限制只約束 GOLEM 自己的記憶、日誌與動作。Microsoft 365 服務端的聊天歷史、稽核、保留或 eDiscovery 政策，以及獨立 Edge 設定檔中的 Cookie、快取與登入狀態，仍依 Microsoft 與租戶政策保存；本 POC 不會關閉或清除它們。

官方參考：[Copilot Chat 存取位置](https://learn.microsoft.com/en-us/copilot/overview#where-to-access-copilot-chat)、[隱私、提示與回覆保存說明](https://learn.microsoft.com/en-us/copilot/privacy-and-protections)。

M365 版的主要入口是本機 Dashboard；舊版 Telegram／Discord 通道不屬於目前支援流程。第一次驗證仍建議只用無敏感測試文字。

這也不是整台主機的緊急停止開關：如果原專案另有使用者事先啟用、且與本聊天無關的獨立整合或排程，它們仍須在各自設定中停用。

## Golem 啟動背景與每輪工具路由

這一版沿用原始 `project-golem-main` 的核心設計，不另造一套代理協定：

1. 新專案對話的第一則使用者訊息會帶入 Golem 身分、目前人格、本機 harness 與 M365 推理層的分工、Action 格式、人工核准規則及 Observation 回傳方式。它不會在背景自動送出啟動訊息。
2. 初始背景不會列出 Windows 使用者名稱、本機絕對路徑、系統指紋或完整 Skill/MCP 清單。這些資料不是教會模型使用工具所必需，也不應整包送往 M365。
3. 每一輪都由原版工具向量索引依使用者意圖篩選候選工具。M365 模式的向量索引使用純本機模型，內容只包含 Skill／MCP 的名稱、說明與觸發詞，與聊天長期記憶分開；命中的 Skill 會附上精簡使用指南，命中的 MCP 會附精確 server/tool/schema，一般唯讀本機檢查則會給出 `command` Action 範例。內建的 `m365-session-bridge` 只在使用者提供精確 SharePoint Online／OneDrive for Business 網址時加入候選，不得被描述為整個 M365 搜尋工具。
4. 當使用者已明確要求查看、列出、檢查、搜尋或操作，且本輪路由已有可行工具時，模型應直接產生最小必要的 `GOLEM_ACTION`，不可只回答「我可以提出 Action」。
5. Action 仍不是執行結果。它必須先出現在本機待核准區，由使用者核准並通過 Action Gate；只有收到本機 Observation 後，模型才能描述實際結果。
6. 每次工具 Observation 都會要求模型同步檢視專案記憶；若應寫入卻只口頭說「會記住」，宿主會自動補正一次。記憶寫入由宿主管理，不會取代或阻擋正在執行的 Action。

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
M365_RESPONSE_TIMEOUT_MS=180000

PLAYWRIGHT_M365_BROWSER_CHANNEL=msedge
PLAYWRIGHT_M365_STEALTH_ENABLED=false
PLAYWRIGHT_M365_BLOCK_HEAVY_RESOURCES=false
```

不要把帳號、密碼、MFA 驗證碼、Cookie 或 Token 寫入 `.env`、測試檔或日誌。

## 第一次人工驗證流程

1. 全新下載先執行 `Install-M365-Golem.bat`，並依畫面指示在 `edge://extensions` 人工載入內建 Session Bridge 的 unpacked extension；之後執行 `Start-Golem.bat`。啟動器會確認 `.env` 使用 `m365-web`，再啟動本機 Dashboard 與獨立的可見 Edge 工作視窗。M365 POC 預熱不要求先建立 GOLEM persona 或記憶。
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
| `M365_ATTACHMENT_LEGACY_REJECTED` | 收到未綁定專案／對話的舊式附件 | 由目前 M365 對話框重新選取、貼上或拖曳附件 |
| `M365_LOCAL_FOLDER_*` | 本輪資料夾參照失效、超出範圍或要求讀取受保護內容 | 重新選取特定資料夾，或改為指定安全的相對檔案路徑；不要放寬資料邊界 |
| `M365_SEND_UNCONFIRMED` | 已嘗試一次送出，但無法確認是否成功 | 不自動重送；先查看 Edge 頁面，避免重複訊息 |
| `M365_RESPONSE_NOT_FOUND` | 送出成功，但在設定的等待時間內沒有命中可信的 Copilot 回覆節點 | 查看主控台的 selector 計數；診斷只含節點屬性與文字長度，不含提示或回覆內容 |

## 尚未通過的項目

- 尚未驗證租戶的服務端聊天歷史、稽核與資料保留設定；這些不由 GOLEM 安全模式控制。
- 尚未證明目前 selector 能涵蓋其他租戶、語言或未來 Microsoft 365 UI 版本；找不到可信節點時仍會在設定的等待時間內停止且不自動重送。
- M365 網頁附件與回覆中的可見下載連結已納入傳輸；語音、Agent 與其他 Microsoft 365 工作負載自動操作仍不在範圍。內建 Session Bridge 與其他 Skill/MCP 只能在其既有權限、本機政策與核准範圍內執行，不能視為租戶管理員已授權或正式上線。
- `M365_POC_SAFE_MODE=false`、`M365_LOCAL_MEMORY_ENABLED=true` 或 `M365_ACTIONS_ENABLED=true` 即使存在，也不代表已核准；啟用前需要另外做資料邊界、權限與人工審查。工具總開關即使開啟，也只代表可以「提出並人工核准」本機工具動作，不是自動核准。

## 內建 Session Bridge 的發布邊界

- GitHub 只保存 `integrations/m365-session-bridge` 的可重建原始碼、鎖版依賴、manifest template 與 deny-first policy template。
- 安裝時才在 `%LOCALAPPDATA%\M365-Golem\m365-session-bridge` 產生政策、IPC 秘密與稽核紀錄；`data/mcp-servers.json` 與 Native Messaging 實機 manifest 也只存在本機。
- 初始 policy 允許非破壞性寫入工具，但不內建任何租戶、站台或文件庫白名單。支援但未列入的精確 SharePoint／OneDrive 目標會顯示原生核准視窗；覆寫、回收、永久刪除、外部分享與權限變更預設關閉，拒絕、逾時、401 或 403 都不得繞過。
- Edge 擴充功能不能靜默安裝，必須由使用者在 `edge://extensions` 親自載入。這個人工步驟與 Microsoft 登入／MFA 都不是自動測試通過就能取代的正式驗收。

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
