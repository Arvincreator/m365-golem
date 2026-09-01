# Project Golem M365-only 源專案分析與 Harness 設計門檻

> 文件狀態：Analysis Gate 完成，可依本文的第一階段範圍開始實作。  
> 分析日期：2026-08-31  
> 適用工作副本：`C:\Users\arvin\Desktop\M365-golem`  
> 原始專案：`C:\Users\arvin\Desktop\project-golem-main`（唯讀，未修改）
>
> **Owner 架構變更（2026-09-01）**：本文件原先的「只保留專案／對話／設定」與「移除 Skills、MCP、Action Gate、Agents、Persona、Memory 等」是 2026-08-31 的第一版窄化提案，已被後續明確決策取代。工作副本改採「原版做減法」：只退役 RPG、股票、加密貨幣與羈絆日記；其餘原版模組保留。MCP／Skill／多代理等工具能力必須保留，但工具總開關預設關閉；若 Owner 日後明確啟用，每項模型提出的動作仍須在目前 M365 專案對話的本機核准面板逐次核准。本文後續標為「第一版」的窄化內容保留作歷史分析，不代表目前實作範圍。

## 1. 結論先行

技術上可行，但不能把原版的 Gemini 對話頁網址與 selector 換成 M365 就宣稱完成。原版是「單一 Golem、全域記憶、記憶體 ActionQueue、單一 Web Dashboard 聊天桶」；它沒有 Codex 類型的 `Project → Conversation/Thread → Run → Step/Checkpoint` 持久化模型，也沒有足以支撐會計師事務所的客戶隔離、保留期限與明確核准狀態。

建議把產品核心收斂為：

1. 只操作可見的 Microsoft Edge 與 `m365.cloud.microsoft/chat`，不使用 Copilot Chat API 或 Microsoft Graph。
2. 固定單一 M365 Copilot Web 後端，不再讓使用者在 UI 選 Gemini、Ollama、LM Studio 或其他通道。
3. 本機建立「專案」；一個專案可以有多個獨立對話。
4. 每個本機對話綁定一個 M365 Copilot Web conversation URL；不得跨專案自動召回全域記憶。
5. 每個多步驟工作建立獨立 Run，逐步留下 event 與 checkpoint；重新啟動後可以判斷應續跑、等待人員、人工對帳或已完成。
6. 多步驟工作預設仍只在同一個 M365 Web 對話內連續推理與產出文字；OS 指令、Skill、MCP 與多代理保留為另層、預設關閉且需逐次本機核准的工具能力。附件與未核准的 Microsoft 365 寫入仍不開放。
7. Sidebar 採 Codex 式專案／對話樹與右側輸出、來源、工具面板；保留原版必要模組，只在 M365 模式同時從 UI 與 API 退役 RPG、股票、加密貨幣與羈絆日記。

這個方向借用主流 harness 的結構，但不引入大型 agent framework，也不聲稱複製 Codex 內部實作。現有 Node.js、Express、Next.js、Socket.IO 與 SQLite 已足以完成第一版。

## 2. 目標、非目標與完成證據

### 2.1 目標

- M365 Copilot Web-only。
- 會計師事務所的單機、單一登入使用者 POC／DEV 邊界。
- 專案可新增、改名、封存；每個專案可新增多個對話。
- 對話在 GOLEM 本機可保留並在重新啟動後載入。
- 本機對話與 M365 Web conversation 明確綁定，切換時不混線。
- 多步驟 Run 可觀察、可暫停、可等待人工輸入、可恢復、可取消。
- 所有外部寫入仍只有使用者已核准的 M365 對話訊息；不得靜默啟用其他動作。

### 2.2 第一版非目標

- 不呼叫 Copilot Chat API、Graph API 或未核准的企業 API。
- 不自動登入、不保存帳密、MFA、Cookie 或 Token 到專案資料庫。
- 不支援多使用者、中央伺服器、RBAC、跨裝置同步或高可用。
- 不支援附件、語音、引用下載、Agent Builder、SharePoint／Outlook／Teams 寫入。
- 不支援本機 shell、Skill、MCP、多代理或背景自主喚醒。
- 不把 UI 成功等同正式環境核准、資料保護核准或租戶政策核准。

### 2.3 完成證據

- 原始專案不變，所有變更只在安全工作副本。
- Architecture check、M365 專用測試、Dashboard TypeScript／build 通過。
- 真實可見 Edge 完成：建立專案、建立兩個對話、各自送收訊息、切換後不混線、重新啟動後歷史仍在。
- 建立一個至少三步的 Run，能顯示 step/event，能暫停與恢復。
- 在「送出已發生但回覆未確認」情境，系統進入 `RECONCILE_REQUIRED`，不得自動重送。
- 不必要的 Sidebar 項目消失，且相對應後端 route 在 M365-only 模式未註冊或明確拒絕。

## 3. 原始專案的實際運作方式

以下是源碼追蹤結果，不是 README 推測。

### 3.1 啟動與組裝

- `apps/runtime/index.js` 是實際 runtime 入口；它初始化 logger、Dashboard、Brain、TaskController、AutonomyManager、ConversationManager 與 ActionQueue。
- `getOrCreateGolem()` 建立單一 `golem_A` runtime。Web Dashboard 雖有 Golem selector，但聊天並沒有 Project／Thread domain。
- 啟動期間會預熱 Browser、Memory 與 Skills；原版也會啟動記憶壓縮、自主喚醒、反思、歸檔、外部通道與重生訊號等背景工作。
- Dashboard 的訊息最後都會進入 `ConversationManager.enqueue()`。

### 3.2 一般訊息鏈

```text
Dashboard POST /api/chat
  → apps/runtime/index.js handleUnifiedMessage
  → ConversationManager.enqueue / debounce / processQueue
  → GolemBrain.sendMessage
  → ProtocolFormatter 建立帶 BEGIN/END 的 prompt
  → PageInteractor 在瀏覽器輸入並送出一次
  → ResponseExtractor 等待新回覆與 envelope
  → NeuroShunter 解析 reply / memory / actions
  → Dashboard Socket.IO 顯示結果
```

關鍵事實：`web-dashboard/routes/api.chat.js` 對 Web Dashboard 使用固定 `chatId: 'web-dashboard'`；`server.chatHistory` 也是程序記憶體 Map。它不是持久化的多對話實作。

### 3.3 記憶與聊天歷史

- `src/managers/ChatLogManager.js` 以每個 Golem 一個 SQLite 檔保存 message 與 summary，並建立 FTS。
- `GolemBrain` 還可使用 LanceDB Pro 或 SystemNative memory driver，並在每次對話前 recall。
- `ConversationManager` 會把使用者與助理訊息寫入 log，並把向量記憶、參考檔案與 profile 注入下一回合。
- 原版的 scope 是 Golem／profile，不是客戶專案或對話。若直接打開原記憶功能，不同客戶案件可能互相召回內容。
- Pyramid memory 的 hourly／daily／monthly／yearly／era 壓縮是知識彙整，不等於可恢復的 workflow checkpoint。

### 3.4 原版為何看起來能「連續工作」

- `NeuroShunter` 解析模型輸出的 `GOLEM_ACTION`。
- `TaskController.runSequence()` 逐一把 action 轉成 command／skill 呼叫。
- `CommandHandler` 或 `SkillHandler` 執行後，把 observation 再送回 ConversationManager，形成下一回合。
- `ActionQueue` 保證程序內依序執行，但只保存 JavaScript function closure 與陣列；重啟後無法重建。
- `SecurityManager` 依風險等級決定自動執行或等待核准，但它不是 deny-first 的資料分類與客戶案件隔離策略。

因此原版是「可在同一程序內迴圈」，不是「可稽核、可重啟續跑、具 at-most-once 邊界的 durable workflow」。

### 3.5 瀏覽器層

- `GolemBrain.sendMessage()` 產生 request id 與 `[[BEGIN:id]]`／`[[END:id]]` envelope。
- `PageInteractor.interact()` 找輸入框、輸入、只送出一次，再交給 `ResponseExtractor` 等待可信回覆。
- 原版 BrowserLauncher 為 Gemini 做 stealth、資源阻擋與 profile lock 清理；這些行為不能直接沿用到企業 M365 登入頁。

### 3.6 Dashboard 與暴露面

`web-dashboard/server.js` 原版註冊 upload、chat、config、skills、system、persona、golems、memory、memory firewall、MCP、diary、prompt pool、RPG、stock、crypto、reference files、calendar 等 routes。

`web-dashboard/src/app/dashboard/layout.tsx` 也把這些功能全部放進 Sidebar。只隱藏選單不足以縮小攻擊面；M365-only 模式應從 route registration 就採 allowlist。

### 3.7 背景與自主功能

原版預設存在 Autonomy、Reflection、記憶壓縮、更新檢查、通道登入與重生訊號等長生命週期行為。這些功能與「使用者明確打開某個客戶案件才送出 M365 訊息」的工作模式衝突，M365-only 第一版必須保持關閉。

## 4. 已完成的 M365 POC 與目前缺口

目前安全工作副本已完成：

- 新增 `m365-web` backend policy。
- 使用可見 Microsoft Edge 與獨立 persistent profile。
- 人工完成登入／MFA；程式不接觸認證資料。
- 只允許 M365 Chat HTTPS host allowlist。
- 純文字送出與真實回覆擷取已在租戶實測成功。
- selector 找不到、頁面忙碌或送出狀態不明時 fail closed，不自動重送。
- 安全模式關閉本機記憶、聊天歷史、動作、附件、多代理與背景自主功能。

但正因為安全模式刻意不留資料，現在尚無：

- 專案。
- 多對話。
- 本機歷史。
- M365 conversation URL 綁定。
- durable Run／Step／Checkpoint。
- 程序重啟後的恢復判斷。
- accounting-client isolation。

既有 POC 邊界與驗證證據見 `docs/M365-COPILOT-WEB-POC.zh-TW.md`。

## 5. 主流 Harness 作法與採用方式

### 5.1 OpenAI Codex／ChatGPT 公開架構概念

OpenAI 把 harness 定義為模型周圍的執行系統：維持跨回合狀態、串流事件、工具、邊界、失敗處理與人工核准。公開的 Codex App Server protocol 把 `thread/start`、`thread/resume`、`thread/fork` 與 `turn/start` 分開；公開說明也把 Project 當作多個 chat、檔案、指示與來源的共同容器。

長任務的公開建議是保存明確 Outcome、Constraints、Verification，並能 pause／resume／steer；開始長任務不應擴張原有 sandbox 或 approval policy。

採用：Project、Thread、Turn／Run、Goal、Event、Approval 分離。  
不採用：Codex SDK／App Server、OpenAI API、shell sandbox 或工作樹概念；本產品後端仍只有 M365 Web。

來源：

- [Codex as a platform: build on the open agent harness](https://developers.openai.com/blog/codex-as-a-platform)
- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Long-running work](https://learn.chatgpt.com/docs/long-running-work)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)

### 5.2 LangGraph

LangGraph 明確區分：

- Checkpointer：單一 thread 的短期狀態、對話連續性、HITL、故障恢復。
- Store：跨 thread 的長期資料，例如使用者偏好與共同知識。
- 記憶體 saver 重啟就遺失，production 應用持久化 checkpointer。
- checkpoint 必須有 retention／pruning，否則長對話會無限增長。

採用：thread checkpoint 與 project-level shared context 分開；第一版 project shared context 只有使用者明確填寫的專案說明，不自動從其他對話萃取「記憶」。

來源：[LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)

### 5.3 Microsoft Agent Framework

Microsoft 的 Workflow checkpoint 在每個 superstep 完成後保存 executor state、待處理訊息、待處理 request／response 與 shared state；HITL 透過 request/response port 暫停，恢復 checkpoint 後仍能重新發出待處理人工請求。

採用：每一個 M365 Web turn 前後都落 checkpoint；人工核准是 persisted request，不是一次性的前端 modal。

來源：

- [Microsoft Agent Framework checkpoints](https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints)
- [Microsoft Agent Framework human-in-the-loop](https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop)

### 5.4 Temporal

Temporal 的核心觀念是把工作歷史持久化，讓程序故障後從已完成進度續跑。第一版不引入 Temporal server，但採用「完成步驟不可因重啟而被無條件重做」的設計原則。

來源：[Temporal documentation](https://docs.temporal.io/)

## 6. 目標 Domain Model

### 6.1 Project

代表一個獨立工作範圍，例如一個內部專案或一個案件群組。

建議欄位：

- `id`：隨機 UUID，不含客戶名稱或個資。
- `name`：使用者可見名稱。
- `description`：使用者明確填寫的共同背景。
- `instructions`：新對話首回合可見地注入的專案規則。
- `status`：`active | archived`。
- `created_at`、`updated_at`。
- `retention_mode`：第一版 `manual`；未經確認不自動刪除。

### 6.2 Conversation／Thread

每個 Project 可有多個 Conversation。它是本機持久化容器，並對應至零或一個 M365 Web conversation。

建議欄位：

- `id`、`project_id`、`title`、`status`。
- `remote_conversation_url`：只允許 M365 allowlist URL。
- `remote_conversation_id`：從 `/chat/conversation/{id}` 取得的 opaque locator；不是認證憑證。
- `binding_state`：`unbound | bound | reconcile_required | broken`。
- `project_context_version`：建立對話時注入的專案規則版本。
- `last_message_at`、`created_at`、`updated_at`。

不得保存 Cookie、access token、帳密或 MFA 資料。

### 6.3 Message

- `id`、`conversation_id`、`role`、`content_ciphertext`、`content_iv`、`content_tag`。
- `source`：`user | m365 | system`。
- `request_id`、`run_id`、`step_id`。
- `delivery_state`：`local | dispatch_started | confirmed | response_confirmed | ambiguous | failed`。
- `created_at`。

訊息內容應以 AES-256-GCM 應用層加密；金鑰由 `.env` 的專用隨機值提供且不得進版控。這仍不是正式金鑰管理或 BitLocker 證明，正式使用前需由公司 IT 決定 Windows 金鑰保管與備份政策。若金鑰缺失，持久化功能應 fail closed，不可退回明文。

### 6.4 Goal／Run／Step／Checkpoint

- Goal：`objective`、`constraints`、`verification`、`max_steps`。
- Run：一次多步驟執行，含目前狀態、目前 step、開始／完成時間、錯誤碼。
- Step：一次具名工作單元；第一版通常對應一次 M365 Web turn。
- Event：append-only 狀態事件，供 UI、稽核與故障分析。
- Checkpoint：每次外部送出前、送出確認後、回覆確認後、等待人工時保存狀態快照。
- Approval：持久化的 request／decision；含原因、決策者顯示名稱（選填）、時間與狀態。

所有關聯 ID 使用隨機 UUID。不得把客戶統編、姓名、conversation URL 或 prompt 內容放進 ID。

## 7. Run 狀態機

```text
DRAFT
  → WAITING_START_APPROVAL
  → QUEUED
  → RUNNING
      ├─→ WAITING_USER ──→ RUNNING
      ├─→ WAITING_APPROVAL ──→ RUNNING
      ├─→ PAUSED ──→ QUEUED
      ├─→ RECONCILE_REQUIRED ──→ RUNNING / FAILED / CANCELED
      ├─→ BLOCKED
      ├─→ FAILED
      ├─→ CANCELED
      └─→ COMPLETED
```

狀態變更必須與 event／checkpoint 在同一 SQLite transaction 完成。

### 7.1 外部送出的 at-most-once 邊界

瀏覽器 UI 沒有可用的交易式 idempotency key。程式只能把本機 `request_id`／`run_id`／`step_id` 放進可見 prompt，並在送出前記錄 `dispatch_started`。

若程序在「點下送出」後、收到確認前中斷，不能假設失敗，也不能自動重送；恢復時必須進入 `RECONCILE_REQUIRED`，由可見 Edge 或可信 DOM 證據判斷該訊息是否已存在。這是第一版最重要的安全邊界。

### 7.2 並行限制

一個 Edge persistent profile 與一個可見頁面同時只能安全驅動一個 Run。第一版可有多個專案與對話，但全域只允許一個 active browser dispatch；其他 Run 保持 `QUEUED` 或 `PAUSED`。這不是效能限制的假裝，而是避免切錯 M365 conversation 的正確性控制。

## 8. M365 Conversation 綁定流程

### 8.1 新對話

1. 本機先建立 `unbound` Conversation。
2. 使用者選取該對話後，程式導航到允許清單中的 M365 Chat 新對話頁。
3. 第一則訊息成功送收後，讀取目前 `/chat/conversation/{id}` URL。
4. 驗證 HTTPS、host、path 格式，再更新為 `bound`。
5. 若第一則訊息狀態不明，不綁定其他頁面，改為 `reconcile_required`。

### 8.2 恢復既有對話

1. 選取 Conversation 時，程式導航到其已驗證的 remote URL。
2. 在送訊息前再次確認目前 URL 與 binding 相符。
3. 若使用者在 Edge 手動切換到另一個 M365 chat，系統停止而不是把訊息送到錯誤案件。

### 8.3 本機與 Microsoft 端保留是兩套系統

本機 Message store 是 GOLEM 的工作紀錄；M365 tenant 端仍依 Microsoft 365 的聊天歷史、稽核、eDiscovery 與 retention policy 保存。刪除本機對話不等於刪除 Microsoft 端紀錄，反之亦然，UI 必須明示。

## 9. 多步驟連續工作的第一版語意

第一版不是讓模型任意執行電腦動作，而是「有目標、有上限、可暫停、可恢復的多回合 M365 文字工作」。

### 9.1 建立 Run

使用者提供：

- Outcome：要完成什麼產出。
- Constraints：資料、格式、禁用方法與邊界。
- Verification：什麼證據才算完成。
- Max steps：第一版建議預設 6、上限 12。

系統顯示將送出的初始 prompt 與步數上限，使用者按「開始」才進入 Queue。

### 9.2 每一步

M365 回覆除了使用者可見答案外，可帶一個嚴格、不可執行任意命令的 run-control block：

```text
[GOLEM_RUN]
{"status":"continue|wait_user|wait_approval|complete|blocked","step_summary":"...","next_prompt":"...","evidence":["..."]}
[/GOLEM_RUN]
```

`next_prompt` 只能成為下一則 M365 文字訊息，不能被解釋為 shell、MCP、Skill、URL navigation 或附件指令。解析失敗即停止並進入 `WAITING_USER`，不得猜測。

### 9.3 自動前進條件

只有下列條件同時成立才可送下一步：

- 使用者已核准啟動此 Run。
- 尚未超過 `max_steps`。
- 前一步回覆已可信確認並已落 checkpoint。
- 狀態明確為 `continue`。
- 沒有人工輸入、敏感資料、外部動作或 ambiguous dispatch。
- active browser lease 仍屬於同一 conversation。

否則必須暫停。

## 10. 會計師事務所的資料與核准邊界

### 10.1 第一版資料分類

- 開發／驗證只使用無敏感測試資料。
- 正式導入前，至少需要定義：客戶機密、個資、未公開財務資料、稅務資料、查核工作底稿、帳密／token 的處理規則。
- Prompt 與 Copilot 回覆可能同時存在 M365 tenant 與本機加密 store；Owner 必須知道這是雙重保留。
- 不自動把某個對話摘要寫成跨對話 memory。

### 10.2 人工核准

第一版需要：

- Run 開始核准。
- `RECONCILE_REQUIRED` 的人工對帳。
- 刪除專案／對話的明確確認。

未來若開放檔案、MCP 或 Microsoft 365 寫入，每一種 side effect 都要另外建立 action type、資料範圍、preview、approval 與 evidence；不能沿用單一「允許所有動作」開關。

### 10.3 稽核與日誌

- 系統日誌預設只記 ID、狀態、selector count、內容長度與錯誤碼，不記 prompt／response 明文。
- Message 內容只在經授權的歷史 API 解密後回傳給本機 Dashboard。
- Event log 使用 append-only；UI 上的封存不是物理刪除。
- 物理刪除、匯出、備份與 retention purge 是後續獨立功能，需另行核准。

### 10.4 商用授權

源專案 `LICENSE` 是 Source-Available Non-Commercial License；其中明列公司／組織 production business operations 需要商業授權。除非使用者本身就是完整權利人或已取得書面許可，技術 POC 通過不代表可在事務所正式商用。正式部署前需完成權利人／法務確認。

## 11. M365-only Sidebar 與 Route 裁撤

### 11.1 第一版 Sidebar

保留：

1. `專案`：專案清單、新增、改名、封存。
2. `對話`：目前專案的對話清單與聊天畫面。
3. `設定`：M365 連線狀態、可見 Edge、保留／加密狀態、資料邊界說明。

Run 進度、step、checkpoint、等待核准與停止按鈕放在對話頁右側或上方，不額外增加複雜 Sidebar。

移除：日記、人格、Prompt 池／趨勢、股票、加密貨幣、行事曆、RPG、Skills、MCP、Action Gate、Agents、Office、Memory、Memory Firewall、Reference Files，以及多 Golem 操作入口。

### 11.2 後端 allowlist

M365-only 模式只註冊或允許：

- `/api/health`
- `/api/system/status` 的 M365 精簡版
- `/api/chat` 與 `/api/chat/callback` 的 M365 限定行為
- `/api/projects`
- `/api/projects/:id/conversations`
- `/api/conversations/:id/messages`
- `/api/conversations/:id/activate`
- `/api/runs`、`/api/runs/:id/*`
- `/api/approvals/:id/decision`
- 必要的本機登入／登出（若啟用 remote dashboard）

其餘 route 在 M365-only 模式不註冊或回傳明確 `M365_FEATURE_DISABLED`。不能只靠 Sidebar 隱藏。

## 12. 分階段實作

### Slice A：持久化基礎與專案／對話 API

- 新增獨立 `M365WorkspaceStore` SQLite。
- schema migration、transaction、AES-GCM codec、事件日誌。
- Project／Conversation／Message CRUD 與封存。
- 不改動既有全域 ChatLogManager，以免重新打開跨專案 memory。

### Slice B：M365 conversation binding

- 新對話與既有 remote URL 的導覽。
- 送出前 URL／lease 驗證。
- 成功送收後持久化訊息與 binding。
- ambiguous dispatch 進 `RECONCILE_REQUIRED`。

### Slice C：精簡 UI 與 route allowlist

- Sidebar 收斂。
- 專案／多對話 UI。
- 連線與本機資料狀態。
- M365-only 模式不註冊非必要 routes。

### Slice D：Durable Run

- Goal／Run／Step／Checkpoint／Approval。
- bounded auto-continue。
- pause／resume／cancel／wait user。
- 程序重啟後只恢復可安全恢復的狀態；ambiguous 外部送出絕不自動重送。

### Slice E：驗證與安全審查

- 單元、route、state-machine、migration、encryption、crash-recovery 測試。
- Dashboard build。
- 真實 Edge 受監督驗收。
- 檢查日誌、DB、`.env`、browser profile 與 git diff 沒有敏感資料。

## 13. 風險、回復與停損點

| 風險 | 控制 | 停損／回復 |
| --- | --- | --- |
| Microsoft 改版 DOM | 保守 selector、診斷不記內容、fail closed | 停止送出；更新 selector 後重新做真實瀏覽器驗證 |
| 訊息送出狀態不明 | 送出前 checkpoint、一次送出、`RECONCILE_REQUIRED` | 人工確認，不自動 retry |
| 切錯客戶對話 | local/remote binding、送出前 URL 驗證、單一 browser lease | mismatch 立即停止 |
| 不同專案資料污染 | 不啟用原全域 memory；所有 message/run 以 project/conversation FK 隔離 | 關閉持久化功能並回到現有 transient safe mode |
| 本機 DB 外洩 | AES-GCM、內容不進一般 log、金鑰缺失 fail closed | 停用 persistence；由 IT 進行主機與金鑰處置 |
| 程序重啟重做外部步驟 | checkpoint + delivery state；完成步驟不可無條件重跑 | ambiguity 一律停在人工對帳 |
| 商用授權不明 | 正式部署前權利人／法務 Gate | 保持 POC／DEV，不上 production |
| 多使用者錯誤假設 | 第一版明示 single-user、single-profile、single-active-run | 不開放遠端多人使用 |

所有新能力都應由 `M365_WORKSPACE_ENABLED` 與 `M365_RUNNER_ENABLED` 分層開關控制。若 Slice B／D 有問題，可關閉新開關回復目前已驗證的 transient M365 safe mode，無需動到原始專案。

## 14. Analysis Gate 判定

### 已確定

- 不使用 Copilot Chat API。
- 只用可見 Edge 與人工登入。
- 產品模型採 Project → Conversation → Run → Step／Checkpoint。
- 第一版不開放本機或 Microsoft 365 side-effect tools。
- 對話可保留；不同 Project 不共享自動記憶。
- 全域只允許一個 active browser dispatch。
- Sidebar 與後端 route 同時精簡。
- ambiguous send 不自動重送。

### 尚待 Production Gate，而非阻擋 POC／DEV 實作

- 公司正式資料分類與允許輸入 M365 Copilot 的範圍。
- 本機訊息保留期限、物理刪除、備份與 legal hold 規則。
- Windows 金鑰保管、BitLocker／裝置管理證據。
- 多使用者、中央部署與 RBAC。
- 源專案商用授權或權利人確認。
- 租戶端 Copilot retention、audit、eDiscovery 與管理政策確認。

依此範圍可開始 Slice A；每個 Slice 完成後仍須以自動測試與可見狀態證據通過，才進下一個 Slice。
