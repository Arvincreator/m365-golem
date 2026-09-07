# M365 Golem 桌面使用體驗升級：完整技術藍圖

版本：1.0  
日期：2026-09-06  
用途：供 Codex 在 Windows 本機儲存庫實作、測試與提交可審查的變更。  
檢視基準：`Arvincreator/m365-golem`，`main`，`3f91ecbe2e45666f277b20fd1f6b8596e93147a6`。  
文件狀態：實作規格；不是已完成修改、測試或正式部署的宣告。

> 核心目標：讓 Golem 更容易開始對話、更容易閱讀及管理工作成果、更清楚知道任務做到了哪裡；保留原本「可見 Edge → Web M365 Copilot → Action／Observation → 本機執行與核准」的控制方式。
>
> 預設第一個開發任務只執行 M0＋M1。M2～M4 是同一份完整路線圖，不代表允許一次重寫全部。每一里程碑都應可獨立測試、審查與回退。

## 0. 規格讀法與優先原則

本文件的「必須／不得」是驗收約束；「建議值」是可依實測調整的產品設定，不是目前已量測的結果。「新增 API／型別／檔案」均為設計目標，不能當成現有功能直接引用。

若本機 HEAD 與基準 commit 不同，Codex 必須重新檢查差異及現有測試，保留較新功能；不得為套用這份文件而 checkout 舊版、覆蓋使用者修改或刪除現有功能。

衝突時依序遵守：

1. 使用者「不改控制 Web M365 的方式」及資料／安全邊界。
2. 最新儲存庫內適用的開發規範及經驗證的行為契約。
3. 本文件的必須項目。
4. 視覺與效能的建議值。

沒有能力證據的功能應標為「尚未支援」，不能以假資料、只改前端狀態或模型聲稱完成來假裝支援。

## 1. 已核對的現況

以下為指定 commit 的靜態程式碼觀察，不是 Windows／M365 實機測試結果。來源索引見第 22 節。

| 區域 | 已存在的實作 | 本次處理方向 |
|---|---|---|
| 前端 | Next.js 16.1.6、React 19.2.3、TypeScript、Tailwind、Radix、react-markdown、Socket.IO；production 設定支援 static export。[R1] | 沿用現有技術，不換框架、不另造後端 |
| 專案／對話 | 專案工作資料夾、多對話、M365 遠端對話綁定、重新命名、封存。[R2][R3] | 保留，補草稿、搜尋、置頂及更好的導覽 |
| Web M365 | `PageInteractor.interact()` 經可見 Edge 送出、附件處理及完整信封回覆擷取。[R4] | 控制與擷取契約凍結 |
| 執行 | Action Gate、工具核准、多步驟任務、暫停／恢復／取消／人工核對。[R5] | 改可讀性與狀態投影，不改安全決策 |
| 訊息 | `page.tsx` 集中輸入、讀取、附件、核准、任務顯示；目前訊息讀取為 `limit=500`，另有 2.5 秒輪詢及 log 觸發重抓。[R2] | 按責任拆元件，再改善增量更新 |
| 輸入 | Enter 送出邏輯沒有完整 IME 組字排除；草稿與選取資源為頁面 state。[R2] | IME、安全送出、對話草稿隔離優先 |
| 呈現 | 有 Markdown、程式碼複製／下載及 HTML 隔離預覽。[R6] | 擴充為有來源及版本的成果工作區 |
| 資料 | SQLite 表格中的多個敏感欄位使用 ciphertext／iv／tag；金鑰缺少時拒絕明文 fallback。[R7] | 新資料沿用欄位加密，不建立明文搜尋副本 |
| 專案規則 | Golem 會產生專案 `AGENTS.md`，並管理專案記憶。[R8] | 不把 Codex 開發規範寫進客戶工作區規則 |
| 回覆方式 | `auto / quick / thoughtful` 在 chat route 對應回覆指示，不是可驗證的模型 ID。[R10] | UI 稱「回覆方式」，不得包裝成模型切換 |
| 完成狀態 | 畫面會在 run 完成後將每個計畫步驟顯示成 completed。[R2] | 整體完成與逐步完成分離 |
| 測試 | 存在來源文字字串式 UI 回歸檢查。[R11] | 保留必要檢查，增加真實元件及瀏覽器行為測試 |

重要更正：不能把「部分 SQLite 欄位加密」描述成「所有本機檔案、索引、AGENTS.md、輸出檔與 Edge profile 都加密」。實際保護範圍必須逐一記錄；本案新增的敏感儲存不得降低既有保護。

## 2. 範圍與不做事項

### 2.1 本案交付

- 對話優先的介面、可靠輸入框、獨立草稿、訊息工具列。
- 更好的專案／歷史搜尋、封存／置頂、長對話及事件更新。
- 可追溯的任務狀態、核准卡片、成果預覽、來源與版本。
- 最後才新增 Windows 桌面外殼；原本瀏覽器 Dashboard 仍可使用。

### 2.2 本案不做

不換 Copilot API、OpenAI API、Claude API 或其他 provider；不新增 Microsoft OAuth／App Registration；不搬移登入 Cookie／Token；不逆向 M365 私有介面；不把 M365 放進 Electron WebView；不把 Golem 部署到 Azure；不增加跨裝置同步或中央客戶資料庫。

不承諾 ChatGPT 的模型能力、即時語音、影像生成、原生 Canvas、雲端歷史分支或即時 token 串流。可借鏡交互設計，但不使用 OpenAI 的商標或假裝是官方產品。

不要為本案全面清理歷史模組、全面升級依賴、重寫記憶檢索或加上無關的多代理機制。

## 3. 不可破壞的技術邊界

### 3.1 兩條既有通道，分開保留

```text
使用者
  → 新版 Golem React UI
  → 既有 localhost Express API／新的本機 UX 服務
  → 既有 dispatch／conversation binding／queue
  → 既有 Playwright + 可見 Edge
  → Microsoft 365 Copilot Chat 網頁
  → 既有完整信封擷取與 Action／Observation 解析
  → 既有 Action Gate／Skills／MCP／本機執行
  → 結果回到原對話

SharePoint／OneDrive 檔案動作
  → 原本的 Action Gate／MCP
  → 既有 M365 Session Bridge
  → 原本 Edge Extension／Native Messaging 及政策
```

本機 HTTP API 是 Golem UI 與本機服務的通訊，不是新增 Copilot API。

### 3.2 控制層檔案凍結

M0 建立受保護檔案 manifest，M1～M4 每次提交都比較基準 Git blob／雜湊。至少包括：

```text
src/core/PageInteractor.js
packages/protocol/ProtocolFormatter.js
packages/protocol/ResponseExtractor.js
packages/protocol/NeuroShunter.js
src/utils/ResponseParser.js
src/utils/M365RenderedCode.js
integrations/m365-session-bridge/**
```

另外檢查專案現有的 M365 provider／selector／Edge 啟動設定及安全預設值，加入 manifest。不能猜路徑，須以本機搜尋確定。

以下為「行為契約凍結」，即使旁邊新增讀取或觀測介面也不得改變：

- Action Gate 風險判斷、人工核准及拒絕後不執行。
- dispatch lease、隊列序列化、對話／request 綁定。
- 已送出、未送出、結果不明的區分，及既有人工核對／重試條件。
- 附件大小／數量限制、暫存生命週期、等待 OneDrive 處理及 send readiness。
- 多步驟上限、暫停／取消／重啟恢復的既有語意。
- M365 登入、MFA、租戶提示由使用者在可見 Edge 處理。

可在既有「結果已保存」之後增加 UX 通知或成果登記，但不得觸發額外模型回合、增加重試、改寫 Action，或把 UI metadata 注入模型協定。

若某項需求只能修改上述控制層才能完成，該項應停止實作，記錄 ADR，保留舊行為及清楚的未支援提示；不以繞路實現。

## 4. 目標介面與互動設計

### 4.1 三區佈局

左側是找對話：新對話、搜尋、最近、置頂、專案與封存。中央是對話及輸入。右側為可收合 Inspector，分「成果／進度／來源」。

建議尺寸：左側 264px，可調 220–360px；中央正文最大寬度 840px；右側 380px，可調 320–520px。正文 16px、行距約 1.7，表格與程式碼可獨立橫向捲動。

寬度不足約 1180px 時右側改抽屜；不足約 900px 時左側也可收合。不以硬塞三欄犧牲閱讀。驗收至少包含 1366×768、1920×1080，以及 Windows 125%／150% 顯示縮放。

右側預設關閉，記住使用者的非敏感版面偏好。收到核准時在聊天區顯示卡片，不強制搶走焦點。產生成果時在分頁顯示數量與提示，使用者自行打開。

AI 回覆採乾淨文件式排版；使用者訊息保留淡色泡泡。`golem_A` 等內部 ID 不作為主要顯示名稱。錯誤碼放詳細資訊；主要文案說清楚影響及下一步。

### 4.2 導覽、空白畫面與狀態

「新對話」仍必須屬於一個專案。有 active project 就在該專案建立；沒有就提供選擇或建立「一般工作」專案的介面。不得自動取消資料隔離、複製所有專案規則或宣稱新對話不留存。

一般工具、Skills、MCP 可從輸入框選用；人格、終端、記憶防火牆等放進進階工具，不刪除既有入口。回覆方式顯示「自動／快速／仔細」，核准模式是另一個獨立設定，不得因切換仔細或工作模式而自動核准。

已連結 M365 是對話綁定狀態，不等於現在登入有效。分別顯示本機連線、對話綁定與最近可知的登入／執行狀態；不知道就顯示「尚未檢查」，不得背景送測試 prompt。

### 4.3 可及性與快捷鍵

所有按鈕有可讀名稱、鍵盤焦點與 tooltip；抽屜／對話框有 focus trap，關閉回到原控制項；狀態用文字及圖示，不只顏色。不要用 live region 不斷重讀整段答案。

Ctrl+K 開啟本機指令／搜尋介面，Escape 關閉選單，不默默取消正在執行的工作。快捷鍵不得在 IME 組字或已被其他元件處理的事件中攔截。動畫尊重 reduced-motion。

## 5. 前端模組拆分

保留 Next 路由、既有 selection provider、API client 與 Socket 連線。新增功能資料夾，按里程碑逐步搬移，不一次刪掉舊聊天頁。

```text
web-dashboard/src/features/m365-workspace/
  components/
    WorkspaceShell.tsx
    WorkspaceSidebar.tsx
    ConversationHeader.tsx
    MessageList.tsx
    MessageItem.tsx
    MessageToolbar.tsx
    ChatComposer.tsx
    AttachmentTray.tsx
    InspectorPanel.tsx
    RunStatusCard.tsx
    ApprovalCard.tsx
    SourcePanel.tsx
    ArtifactPanel.tsx
    SearchDialog.tsx
  hooks/
    useConversationSnapshot.ts
    useConversationDraft.ts
    useWorkspaceEvents.ts
    useMessagePagination.ts
  lib/
    scope-key.ts
    composer-input.ts
    message-view-model.ts
    run-view-model.ts
    event-reducer.ts
  contracts.ts
```

既有 `M365MessageContent.tsx` 保留作 Markdown／程式碼 renderer，M3 再抽出可重用 artifact preview。`chat/page.tsx` 最後只負責路由編排，避免同時處理 API、附件、run state 及全部 JSX。

第一版不需要新增大型狀態管理框架。先使用現有 React Hooks／Context，將查詢、草稿及 UI state 明確分開；若確實需外部 store，選一套並記錄原因，不能同時引入多套快取框架。

## 6. 輸入框、草稿與附件

### 6.1 IME 與鍵盤送出

檢查 `nativeEvent.isComposing`、composition ref，並以 `keyCode === 229` 作有限相容處理；229 只用於 IME 相容，不擴大使用已淘汰的 keyCode API。[W1]

需涵蓋 compositionstart／compositionend 與 Enter 的前後順序，並測試微軟注音。Shift+Enter 換行；一般 Enter 才送出；重複 keydown、已 preventDefault、選單選項確認、Alt 組合鍵不得送出。Ctrl+Enter 等替代行為須由明確設定決定。

輸入框自動增高，建議 48–240px；超出後內捲動。不因送出請求進行中鎖住新的草稿輸入，但對同一待送快照使用同步 in-flight guard，避免雙擊／連續 Enter 建立兩次相同提交。

### 6.2 每個對話獨立的草稿

以 `(projectId, conversationId)` 為 key 管理：

```ts
interface ComposerDraft {
  schemaVersion: 1;
  projectId: string;
  conversationId: string;
  text: string;
  responseMode: 'auto' | 'quick' | 'thoughtful';
  referenceFileIds: string[];
  mcpServerNames: string[];
  skillIds: string[];
  quote: { messageId: string; excerpt: string } | null;
  attachmentDescriptors: Array<{
    id: string;
    fileName: string;
    size: number;
    lastModified: number;
    state: 'local_selected' | 'needs_reselect';
  }>;
  revision: number;
  updatedAt: string;
}
```

上述為邏輯型別；敏感部分在資料庫中以整包加密 JSON 儲存，不按此型別明文落盤。

先更新記憶體，再於 600ms idle debounce 保存至既有本機加密資料層。切換對話時保留舊 scope 的快照並啟動保存；不能把快照送到新 scope。UI 區分「已在本機保存／保存中／尚未保存」。

`beforeunload` 或關閉視窗最後一刻的非同步保存不保證完成，不能宣稱突然斷電也不遺失最後按鍵。送出前可做明確 flush；若只在記憶體可用，顯示警告，不 fallback 成明文 localStorage。

多視窗使用 revision compare-and-swap。初次建立 `expectedRevision=0`；衝突回 409，保留本視窗文字並提供合併／使用此版本的明確操作，不靜默 last-write-wins。

送出時捕捉文字及草稿 revision；只有本機收到已接受排隊的證據後，才以 CAS 清除「該版本」草稿。若使用者期間輸入新文字，不得一起清除。清除應更新 tombstone／revision，取消舊 debounce，防止舊 autosave 把已送出的草稿復活。

服務失敗或傳送結果不明時保留文字，但不自動重送。不得把 UI 清空等同遠端已收到。

### 6.3 附件生命週期

沿用既有檔案檢查、每輪最多 10 個、每檔 25 MiB、總計 50 MiB 的目前預設；實作時以後端驗證及設定為準，UI 不提高限制。[R12]

待選 `File` 物件只可在目前頁面生命週期內按對話保留。所有草稿的附件總記憶體亦設上限，第一版建議 50 MiB；超限要求使用者移除／重新選取，不能把其他對話附件悄悄寫到磁碟。

重新載入後，描述資料可恢復但標為「需要重新選取原檔」；不能用檔名假裝原檔存在。只有使用者送出後才走現有 batch staging，不為保存草稿而提前上傳 M365。

上傳層級至少分清楚「本機選取、交付本機服務、等待 M365 處理、可送出、送出已確認」。只有取得真實 byte 計數才顯示百分比，其餘顯示階段文字。

支援 Ctrl+V 貼圖時，只處理當次 paste 事件中使用者提供的內容，沿用原附件檢查；不讀取整體剪貼簿歷史，不自動截全螢幕。預覽 Object URL 在移除、送出、換頁銷毀時撤銷。

不得因傳送 ACK 遺失就刪除仍可能被 backend 使用的 staging batch；只能依服務端確認的生命週期清理。

### 6.4 參考資料隔離

參考文字、這輪上傳原檔、專案規則、MCP／Skills 是不同概念，UI 用不同標籤呈現。切換對話不可繼承前一個客戶的選取。

現有 reference-file 選擇是從可用清單按 ID 解析；需補查專案授權綁定，不能只靠前端過濾。[R10] 將既有未分類參考檔標為未指派，由使用者明確加入專案或核准為共用範本；不可批次自動開給所有專案。

在進入既有送出流程前，由 server 驗證 conversation 屬於 project、reference 綁定有效、MCP／Skill 仍可用。這是本機 scope 驗證，不是改 Web M365 操作協定。

## 7. 非同步競態與資料狀態

### 7.1 三種 state 分離

- 伺服器事實：messages、runs、approvals、binding、artifacts，以 ID 正規化。
- 本機未提交內容：draft／pending files，以 scope 管理。
- 畫面偏好：左右欄寬、選取分頁、閱讀位置，可保存非敏感設定。

每次載入 capture scope 及 generation；切換時取消舊 GET 請求，在每一個寫入 cache／setState 的位置再檢查 scope／generation。AbortController 不等同取消後端動作，只用於放棄讀取。React 官方亦以 cleanup 與忽略失效回覆防止請求競態。[W2]

不能只在 `.catch()`／`.finally()` 檢查 mounted，讓已過時的內層 `loadMessages()` 繼續 setState。

### 7.2 同 scope 舊回覆也不能覆蓋新回覆

服務端回傳 resource revision。reducer 對每個 entity 比較版本，不接受較舊的 snapshot 覆蓋已收到的新 message delivery／run 更新。相同 messageId 去重；optimistic item 以 clientIntentId 對上正式 requestId，再替換，不能顯示兩份。

若 API 尚未提供版本，M1 先使用查詢 generation 防止同 scope out-of-order，M2 再完成持久 revision；不可用時間字串比較當作永久可靠版本。

## 8. 訊息操作與歷史管理

### 8.1 M1 交付

每則一般回覆提供複製、引用追問、詳細資訊。複製以使用者可見答案為主，不把隱藏協定／Action JSON 混進去。引用保留 messageId，將使用者選取的可見文字放進當前 scope 的草稿，不自動送出。

工具紀錄可折疊，但不能全靠正則把含有 `GOLEM_ACTION` 字樣的正常解說誤判成真正待核准。優先依伺服器提供的 message source／tool receipt／pending action ID 分類；無結構證據時當一般訊息，不顯示可核准按鈕。

### 8.2 M2 交付

置頂／取消置頂、封存入口、搜尋結果定位。封存沿用既有檢查，不強行封存正在執行的工作。封存／本機刪除不等於 M365 遠端歷史刪除，文案必須分開。

「修改後再問」第一版採新一輪修正版，保留舊訊息不改遠端。不得刪掉舊答案或回播過去工具動作來假裝原地編輯。

真正分支列為後續選配：使用者選擇可見對話片段 → 顯示摘要與來源 → 建立新的本機對話及新的遠端綁定 → 正常 bootstrap。名稱應是「帶入脈絡開新對話」，不得宣稱複製模型內部狀態。不得帶入舊 approval、待執行 command 或可執行 observation。沒有完整驗收前不交付假分支功能。

「重新回答」也是新一輪請求，不是重新執行既有 request。M1 不必交付此按鈕，以免因追求外觀製造重複動作。

## 9. 搜尋、分頁與長對話

### 9.1 搜尋

預設目前專案，使用者可明確切換所有本機專案或包含封存。結果顯示專案、對話、時間、可見文字片段，點擊取得目標訊息附近的視窗，不要求一次載入完整對話。

第一版採 server 端「依 scope 取加密資料 → 受限批次解密 → 記憶體比對 → 回傳片段」。不得使用 SQLite `LIKE` 搜 ciphertext；不得將解密內容加入磁碟 FTS、另一份 JSON 索引、外部 embedding API 或瀏覽器持久快取。

大型資料採分批掃描及可取消 job；若只搜尋部分資料，明確回傳 `partial=true`、已掃描範圍及 continuation cursor。UI 必須顯示範圍，不能把「尚未掃描」說成沒有結果。

NFKC／英文大小寫／空白正規化可用於搜尋，但保留原文顯示與可追蹤位置；高亮不直接拼接原始 HTML。查詢文字放 POST JSON body，不在 URL、遙測或日誌記錄內容。清空查詢時取消未完成搜尋。

未來需索引再另寫 ADR：加密方案、洩漏模型、重建／清除規則及實測收益；不能為速度先犧牲資料保護。

### 9.2 訊息分頁

初次建議取最新 50 則，每次向上加 50 則，上限由後端限制。使用穩定 keyset cursor，以 `(created_at, id)` 或新增持久序號排序；不可只用時間戳，因可能同時寫入多則。

舊訊息仍可能更新 delivery state，因此增量更新必須包含 entity revision，不能只查「created_at 大於最後一則」。搜尋定位使用 around-message API。

先分頁、memoized renderer 及受限頁面視窗；實測有需要再做變高列虛擬化。虛擬化必須保留原生文字選取、搜尋定位、鍵盤可及性及圖片載入後的 scroll anchor，不能只追求 DOM 數量。

使用者距底部超過建議 96px 時不自動捲回；新訊息只顯示未讀計數及回到底部。prepend 舊頁使用 messageId＋offset 保持錨點。

### 9.3 側欄

避免每 15 秒列所有專案後，再逐專案取所有對話的 N+1 模式。先載入專案及有限最近對話；展開專案再分頁取得。事件只 invalidate 受影響節點，不重置使用者展開狀態或捲動位置。[R2]

## 10. 本機事件更新與去重

### 10.1 不改模型串流

沿用 Socket.IO，不另外加 SSE、訊息 broker 或雲端通道。推送的是本機已確認的狀態變化，不是修改 M365 回覆擷取。

Socket.IO 保證訊息順序，但預設不保證每個事件都送達；connection-state recovery 也不能取代重新同步。[W3][W4] 因此資料庫與 snapshot 才是 source of truth。

### 10.2 事件契約

```ts
interface WorkspaceEvent {
  schemaVersion: 1;
  eventId: string;
  streamId: string; // 例如 conversation:<id>，不是 Microsoft Token
  sequence: number;
  projectId: string;
  conversationId?: string;
  entityType: 'message' | 'run' | 'approval' | 'draft' | 'artifact' | 'project';
  entityId: string;
  entityRevision: number;
  change: 'created' | 'updated' | 'archived' | 'removed';
  occurredAt: string;
}
```

event 預設只有 ID／版本／類型，不 broadcast prompt、檔案全文或絕對路徑。只有已驗證可讀的 scope 才能 subscribe；不能相信 renderer 指定任意 projectId 就給資料。

需要可補取時，在本機資料層新增 append-only UX journal／outbox，於對應資料寫入後發布；同一交易可整合的本機變更應一起 commit。不能為補事件而重送模型請求。若觀測掛鉤無法提供可靠事件，保留低頻 snapshot 作修復，不更改核心控制流程。

sequence 必須在固定 stream 內定義。若使用全域 sequence 並過濾不同專案，序號跳號不等於事件遺失，不能誤觸循環重載。

### 10.3 重新同步

取得帶 snapshot cursor 的快照，訂閱後補取 cursor 之後事件；重複 eventId 丟棄。cursor 過期回 `RESYNC_REQUIRED`，取新 snapshot 並建立新的基線，不重播任何 command。

前景正常連線以事件為主；首次切換、重新連線與回到前景強制 resync。保留約 15–30 秒低頻修復輪詢；背景頁可延長到 60 秒或停止，前景恢復時補同步。這些是建議值，不要影響既有執行節奏。

### 10.4 送出意圖的本機去重

M1 先做同步 double-submit guard 與「非冪等 mutation 不自動重試」。既有 apiPost 與 apiWrite 的預設 retry 不相同，不能在重構時不小心換成會重試的 helper。[R13]

M2 可加 optional `clientIntentId`，只存在本機 API metadata，不進入 prompt。以 `(conversationId, clientIntentId)` 唯一；相同 ID＋相同 payload fingerprint 回傳原本接受結果；相同 ID＋不同內容回 409。檢查、保留與映射必須具原子性，不能做先查再寫的競態。

崩潰發生在「已保留 intent，但無法確知是否已交給 dispatcher」時，標記 `needs_reconcile`，不可自動提交第二次。這只提供本機防重與可核對狀態，不宣稱端到端 exactly-once。

既有 M365 requestId／envelope／lease 不改。若整合 intent 必須改協定，本里程碑只保留前端防重，記錄未完成能力，不繞過。

## 11. 任務、核准、停止與完成

### 11.1 RunViewModel 只投影，不另造執行引擎

以現有 run、step、approval、delivery 與 binding 事實推導畫面，不建立互相矛盾的新狀態機。

| 真實狀況 | 主要顯示 | 不得聲稱 |
|---|---|---|
| 本機接收、尚未派送 | 已排隊 | M365 已收到 |
| 正在送往 M365 | 傳送中 | 模型正在深度思考 |
| 送出確認、尚未有完整回覆 | 等待 M365 回覆 | token 串流中 |
| 有 pending approval | 等待核准 | 已執行 |
| 有 running tool receipt | 本機工具執行中 | 計畫所有步驟都在跑 |
| continuation 被取消、當前回合可能未結束 | 已停止後續步驟，本輪可能仍會完成 | 已中止 M365 或撤銷已寫入檔案 |
| binding／run 需要核對 | 需要人工核對 | 已安全重試 |
| 無可靠訊號 | 狀態待確認 | AI 已經完成 |

不提供虛構的模型思考內容；只顯示可見計畫摘要、工具紀錄及可證明的工作狀態。

### 11.2 核准卡片

顯示動作目的、工具、讀／寫分類、目標專案、檔案與影響範圍、是否覆寫及有效期限。缺少可驗證欄位則提示需看詳細指令；不可讓 AI 自報低風險就改核准策略。

核准必須攜帶既有 actionId、conversationId 並由 backend 再驗證；只有適用且未過期的 pending task 能按。核准中 disabled，回應遺失先查狀態，不能直接再按一次。拒絕不執行。

「只本次」不等於「永久允許」；這次改版不新增批次自動核准，也不放寬原本 auto approval 規則。Tool、Run、Bridge 可能是不同核准點，不可把一種核准冒充其他授權。

### 11.3 取消與暫停

沿用原有 endpoints。只顯示 backend 有能力履行的操作。尚未派送的普通訊息若沒有安全取消 API，先不提供取消佇列按鈕；不得只從前端隱藏後稱取消。

暫停按鈕說明「完成目前步驟後暫停」；取消說明「停止後續步驟」。已完成的寫入不提供假 Undo，應另走具風險評估的補償動作，不在本案實作。

### 11.4 完成狀態修正

移除以 `run.status === 'COMPLETED'` 強制每個 plan step completed 的投影。保留 completed／skipped／blocked／pending 等原始狀態。

整體完成另標明來源：工具／宿主證據、Copilot 計畫回報、或使用者核對；只能使用現有紀錄能支持的分類。計畫說做完，不等於正式覆核通過。

進度顯示「已完成 3／5、略過 1、待確認 1」等真實計數。若進度條計入 skipped，標成「已處理步驟」，不要標成「成功率」。人工結案可以關閉整體工作，但不改寫步驟歷史。

## 12. 成果工作區與來源追溯

### 12.1 三種成果，不能混為一談

| kind | 可證明的事 | 合法操作 |
|---|---|---|
| `message_code` | 某一則訊息內確實包含這份程式碼／Markdown | 預覽、複製、使用者主動匯出；不得稱已落地本機檔 |
| `local_file` | 已核對檔案 bytes、位置、大小與 hash，且屬於目前專案 | 預覽、另存副本、顯示資料夾；依政策開啟 |
| `remote_link` | 原本回覆或 Bridge 結果提供一個遠端來源連結 | 開啟來源；未下載前不得提供假本機預覽或假下載成功 |

「AI 說已建立 .xlsx」只有文字，不能建立 `local_file`。

### 12.2 型別契約

```ts
type ArtifactKind = 'message_code' | 'local_file' | 'remote_link';
interface ArtifactVersion {
  id: string;
  artifactId: string;
  projectId: string;
  conversationId: string;
  version: number;
  kind: ArtifactKind;
  displayName: string;
  mimeType: string | null;
  byteLength: number | null;
  sha256: string | null;
  evidence: {
    sourceMessageId?: string;
    sourceRequestId?: string;
    sourceRunId?: string;
    sourceActionId?: string;
    observationId?: string;
    verifiedAt?: string;
  };
  sourceReferences: Array<{
    kind: 'uploaded_file' | 'indexed_reference' | 'message' | 'remote_url';
    id: string;
    contentHash?: string;
  }>;
  reviewStatus: 'unreviewed' | 'reviewed' | 'rejected';
  availability: 'available' | 'missing' | 'changed' | 'not_downloaded';
  createdAt: string;
}
```

path／URL、名稱與來源細節在後端敏感欄位加密；UI 使用不透明 ID，不接受 `?path=C:\...` 這類任意路徑 API。reviewStatus 是本機工作標記，不等於正式簽核流程或法定覆核。

### 12.3 成果登記

可信本機動作完成後，由宿主結果 adapter 取得 receipt；解析 schema、核對 scope，再驗證目標檔案。只登記使用者／已核准工具明確涉及的檔案，不能背景掃整顆硬碟或整個 SharePoint。

MCP 回應／Observation 也是外部資料，不能直接信任其中的路徑、檔案類型或完成宣告。必須在本機獨立核對，且不允許跨專案「借用」其他客戶的產物。

舊訊息可以建立 `message_code` 卡片；缺少歷史 receipt 的舊檔不得猜測來源，只能標示「來源未完整記錄」，或由使用者明確匯入後核對。

### 12.4 版本與不可變性

`artifactId` 代表同一成果，version 是已驗證的不可變版本，不是把同名檔案永遠當同一 bytes。工作檔已變更時顯示 `changed`，不可拿新 bytes 冒充舊版。

保存歷史版本需要真正的 byte snapshot。預設使用受控、加密的本機 artifact vault；匯出到專案 `outputs/` 或另存位置是使用者明確操作，匯出後通常為可開啟的明文檔案，必須標明保護範圍。若未實作 byte snapshot，介面只能稱「版本紀錄」，不能提供不存在的回復功能。

大檔案 snapshot／預覽的大小與保留上限放設定；M3 先提供可理解的保留政策與手動清理，不能默默無上限複製客戶資料。原始檔與輸出內容不得加入 Git。

修改成果採新版本或新檔名，不默默覆蓋；與既有 Bridge 的 overwrite 禁止政策衝突時，保持禁止，改走另存新檔。

### 12.5 預覽支援矩陣

| 類型 | M3 基本交付 | 明確限制 |
|---|---|---|
| 文字／Markdown／程式碼 | 格式化閱讀、複製、選段追問、差異比較 | 不執行內容 |
| HTML | 靜態隔離預覽、原始碼、使用者主動匯出 | 不執行 JS、不連外、不開 popup、不讀本機 |
| PNG／JPEG／WebP | 受限解碼、縮放及尺寸資訊 | 不自動從遠端載圖；SVG 不作未清理 inline HTML |
| CSV | 受限列數預覽、欄位型別及複製 | 原始檔不變；匯出文字欄防 formula injection |
| XLSX／DOCX | 先提供已驗證檔案卡片及另存；解析預覽通過安全測試才啟用 | 預覽不等於 Office 完整排版、公式重算或巨集執行 |
| PDF | 先提供安全的檔案操作；採經核對的本機 viewer 才啟用內嵌預覽 | 不上傳第三方線上預覽；禁止腳本與外部資源 |

不要以 CSV 假裝 XLSX，也不要用更換副檔名製造 PDF／Word。每個 parser 應記錄來源、版本、授權、安全狀態及輸入上限，離線或無法查核時不任意新增套件。

### 12.6 HTML 與檔案安全

維持 `sandbox=""`，不得為互動性加 `allow-scripts` 或 `allow-same-origin`。搭配 CSP、sanitize、移除 scripts／event handlers／forms／meta refresh／外部 URL／active SVG。CSP 不是萬靈丹，iframe 內的導覽連結也須清理或變成不可導航，不能只禁 fetch 就聲稱沒有外部請求。

本機檔案取用以 server 登記 ID 解析，驗證 `realpath`、專案 root、Windows 大小寫／separator、junction／symlink／UNC／alternate data streams，並在實際開啟時防範 TOCTOU；不能只用字串 startsWith 判斷。

不提供任意 shell 執行、不自動開啟 .exe／.bat／.ps1／.cmd／.lnk／.url 或巨集文件。顯示資料夾也需驗證 ID 與權限。ZIP／Office parser 限制解壓大小、深度、entries 與路徑，防 path traversal 與資源耗盡。

CSV 匯出時對「文字」欄中以 =、+、-、@ 等可觸發試算表公式的值採安全處理；真正數值與刻意的公式欄位分開，不能把所有負數改成文字。

### 12.7 來源面板

區分「使用者選取」、「宿主確實注入／上傳」、「工具實際讀取」、「答案可見引用」。它們不是同一件事。若無確切注入紀錄，只顯示本輪選取，不宣稱 AI 一定讀過全部內容。

記錄當輪可取得的 project contextVersion、選取／注入 reference ID、工具 receipt 與 source message。不要為補來源重新抓 M365 DOM、使用 Cookie fetch 或發第二個模型請求。

點某一段成果做「選段修改」時，只把明確選取內容及版本指向加入新草稿；仍由原對話及原核准流程執行，不能從 canvas 直接繞過 Gate 寫檔。

## 13. 後端模組與資料模型

### 13.1 新增服務建議

```text
src/services/
  M365UxService.js          # 彙整既有資料，回傳 UI snapshot／capabilities
  M365DraftService.js       # 草稿 CAS、清除與保留政策
  M365SearchService.js      # 本機受限搜尋
  M365UiEventService.js     # event invalidation／補取／resync
  M365ArtifactService.js    # 證據登記、版本、預覽與匯出授權
web-dashboard/routes/
  api.m365-ux.js            # 全部新增本機 UX API
```

仍使用原本 `M365WorkspaceStore` 連線與金鑰管理。新 service 透過 store methods，不各自開 SQLite connection 或複製 `_encrypt` 成第二套密碼系統。

### 13.2 新增表格（按里程碑建立）

| 表格 | 核心欄位／約束 |
|---|---|
| `composer_drafts` | conversation_id PK、payload ciphertext／iv／tag、revision、cleared flag、updated_at；project 由 conversation 關聯校驗 |
| `conversation_ui_state` | conversation_id PK、pinned、last_read_message_id、revision、updated_at；敏感自訂標籤須加密 |
| `project_reference_bindings` | project_id＋reference_id 唯一、binding scope／啟用狀態；先查相同功能是否已存在 |
| `ux_events` | stream_id＋sequence 唯一、event_id unique、entity ID／revision／type；payload 不含全文 |
| `chat_intents` | conversation_id＋client_intent_id 唯一、payload HMAC、request 映射、狀態；只在不改協定的前提下建立 |
| `artifacts` | artifact_id PK、project／conversation 關聯、current_version_id、敏感描述加密 |
| `artifact_versions` | artifact_id＋version 唯一、immutable snapshot locator、證據／來源加密、hash／size、review／availability |

event、草稿、成果皆有外鍵與清理政策；封存不必刪除，明確本機刪除才清理對應資料。對既有刪除語意不得自動擴張成刪除遠端 M365。

欄位加密沿用現有 authenticated encryption helper，AAD 綁 table／entity ID／field。使用新的 IV；金鑰缺少、格式錯誤或解密失敗時 fail closed，不建立明文 fallback、不自動重設資料庫。

### 13.3 migration 與回退

遷移必須可重入、交易式、只加新表／欄位，不改已有內容格式。先讀 `schema_migrations` 現況後分配新版本，不能假定下一版號。

不要在 `_enqueue` 內呼叫另一個會 `_enqueue` 的公開 store method 而互等；同一 transaction 的內部操作必須使用既有序列化模式。

migration 前對本機 DB 做一致性備份。SQLite 使用 WAL 時不可只複製主檔而遺漏尚在 WAL 的內容：先安全停止所有持有連線的 Golem 實例／完成 checkpoint，或使用經驗證的 SQLite backup 流程。備份留在本機、不進 Git、不公開金鑰。[W9]

功能旗標可退回舊 UI；停用功能不等於移除 schema，也不刪除草稿及成果。舊版程式是否可讀新增 schema 要實測，不能一概保證。降級時保持最新安全修正；不要為回退外觀把資料保護一起退掉。

## 14. 本機 API 契約

所有以下 `/api/m365/ux/...` 路徑為新增規格，不是已存在端點。優先沿用既有 `/api/chat`、activate、reconcile、run start／pause／resume／cancel 與 approval endpoints；不得重造第二條模型送出路徑。

| 新增端點 | 目的 | 主要條件 |
|---|---|---|
| `GET /api/m365/ux/capabilities` | 已實作且可用能力清單 | 不呼叫模型、不暴露秘密 |
| `GET /api/m365/ux/conversations/:id/snapshot` | 訊息頁、run／approval 摘要、cursor | 有限大小、scope 校驗 |
| `GET /api/m365/ux/conversations/:id/messages?before=...` | 歷史 keyset pagination | cursor 屬於該 scope |
| `GET /api/m365/ux/conversations/:id/messages/around/:messageId` | 搜尋定位 | target 必須屬同一對話 |
| `GET /api/m365/ux/conversations/:id/events?after=...` | 補事件 | 過期 cursor 回需重新同步 |
| `GET /api/m365/ux/conversations/:id/draft` | 讀取草稿及 revision | 不讀任意本機檔案 |
| `PUT /api/m365/ux/conversations/:id/draft` | CAS 保存 | expectedRevision、大小限制 |
| `DELETE /api/m365/ux/conversations/:id/draft` | 清除該 revision／tombstone | 條件式請求，避免舊保存復活 |
| `PATCH /api/m365/ux/conversations/:id/ui` | 置頂、已讀及非敏感設定 | 白名單欄位 |
| `POST /api/m365/ux/search` | 唯讀搜尋 job／page | query 在 body，scope／limit／cursor |
| `GET /api/m365/ux/projects/:id/artifacts` | 有證據的成果列表 | 分頁、不背景掃磁碟 |
| `GET /api/m365/ux/artifacts/:artifactId/versions/:versionId/preview` | 已驗證資料的預覽 | 固定 MIME／nosniff／no-store／限大小 |
| `POST /api/m365/ux/artifacts/:artifactId/versions/:versionId/export` | 明確另存副本 | 使用者動作、受限目的地、覆寫檢查 |
| `PATCH /api/m365/ux/artifacts/:artifactId/versions/:versionId/review` | 本機覆核標記 | 不冒充正式 Approvals |

新 API 統一使用 `{ success, data, meta }`，既有 endpoint 不破壞回傳格式。`meta` 可含 `revision`、`cursor`、`hasMore`、`partial`、`snapshotCursor`，只回傳適用欄位。

錯誤至少分 400 輸入錯誤、403 不允許操作、404 不存在／無可讀 scope、409 revision 或 intent 衝突、413 過大、503 服務／金鑰未就緒。不要在錯誤內回傳客戶全文、token、完整本機路徑或其他專案名稱。

`capabilities` 應由實際 feature flag、程式支援與當前安全設定組合；`liveTokenStreaming=false`、`remoteTurnAbort=false`、`crossDeviceSync=false` 不能因為畫面做完就改 true。

## 15. 本機與桌面安全

本案保持 per-user 本機部署，不新增多租戶 SaaS。專案隔離是本機資料與工具範圍，不能宣稱已具公司級 RBAC 或跨帳號安全隔離；不同 Windows 使用者及不同 M365 身分的正式支援應另案驗證。

新路由不能因名稱是 UX 就繞過 API guard。至少保留／加強：loopback bind、精確 Host／Origin 驗證、內容型別與大小限制、CSRF／本機 session 防護、Socket 握手及房間 scope 驗證、path allowlist、敏感內容 no-store。

目前 security helper 有處理 forwarded header 與 local request 的程式，M0 應檢查來源信任；不能將任意客戶送入的 `X-Forwarded-For: 127.0.0.1` 當成本機認證。[R9] 無受信任 proxy 時以實際 socket address 判斷，Host 不接受任意 DNS 別名。CORS 不是授權機制。

若新增本機 session／instance capability，它只能用於 Golem 本機程序，不是 Microsoft Token。不得放 URL、命令列參數、log、localStorage 或 Git；服務端／desktop main 記憶體保存並用受限管道交付。

查詢快取、匯出暫存、SQLite WAL／SHM、crash report、日誌與開發截圖都納入資料處理範圍。診斷僅留錯誤碼、耗時、ID、數量，無 prompt／回覆／檔案全文。

登入與 MFA 仍在 Edge；不新增對 Microsoft 的 telemetry、網路模型呼叫、雲端 OCR 或線上預覽服務。

## 16. Windows 桌面外殼：M4 才實作

### 16.1 架構選擇

選 Electron 作為 Golem UI 的 Windows 外殼，沿用外部 Node.js sidecar 跑現有 runtime。先保留現有安裝前提，再評估包含固定 Node runtime 的安裝包，不在 M1 就處理所有打包細節。

```text
apps/desktop/
  main/             # window lifecycle／owned sidecar／tray／notifications
  preload/          # 窄介面、參數 schema、不可暴露任意 IPC
  package.json
  README.md
```

renderer 載入既有 server 提供的 production Dashboard origin，避免用 `file://` 迫使 API guard 允許 null origin。Next 的 static export 與現有 Express static serving 保留。[R1]

M365 仍在外部可見 Edge；不載入到 Electron renderer，不搬 profile，不要求重新寫登入流程。

### 16.2 Electron 安全設定

`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity=true`；不公開 require、fs、child_process 或通用 ipcRenderer。preload 每個方法單獨 schema 驗證，main 驗證 sender／frame／origin。這些方向符合 Electron 官方安全與 context isolation 指引。[W5][W6]

禁止非預期 navigation／window.open；外部開啟只允許經驗證的 http／https，依 M365 URL 類型轉交既有 Edge activation 或明確外部瀏覽器操作。不允許任意 file／javascript／自訂 scheme。

production CSP 不因方便預覽而放寬；開發 HMR 所需能力不得帶進正式包。若要移除現有 unsafe-eval，分開驗證 production bundle，不能為資安調整破壞建置後再直接跳過測試。

### 16.3 程序與 port ownership

桌面程序先確認 backend 身分與健康，不能看到 port 有回應就相信是 Golem。識別自己啟動的 child PID／instance handshake；外部已存在的 Golem 不由新視窗任意關閉。

沿用經核准的本機 port／origin。若需要動態 port，必須同時調整精確 allowlist 與測試，不改成 `*`、allowRemote=true 或接受所有 localhost ports。M0 先確認現有 dev 3000／3001 與 production 設定。[R3][R9]

初期 sidecar 使用相容的外部 Node 執行，避免把 sqlite3 等 native 模組改由 Electron ABI 直接載入。打包版再驗證 OS、architecture、Node ABI、原生依賴及可重建性，不靠使用者手動複製 node_modules。

### 16.4 桌面功能

主視窗、使用者可設定的全域喚起快捷鍵、小輸入窗、系統匣、視窗位置記憶、完成／待核准通知。快捷鍵衝突要明確提示，不搶註冊其他軟體。

小視窗仍顯示所屬專案，與主視窗共享同一草稿 revision 及送出狀態，不建立獨立隊列。通知預設只顯示「工作完成／需要核准」，不在鎖定畫面顯示客戶名稱或內容。

關閉視窗與結束服務分開；正在工作時說明影響。不得 `taskkill /IM msedge.exe`；只針對自己擁有的程序走既有 graceful shutdown。不自動殺掉使用者日常 Edge。

安裝精靈提供前提檢查、Extension 設定引導、登入開啟及本機診斷，不自動降級安全設定、不要求停用 Smart App Control、不修改租戶政策。版本更新第一版採使用者明確啟動與可回退流程，尚未完成簽章／驗證前不做自動下載執行。

## 17. 能力擴充的取捨

| 能力 | 決策 |
|---|---|
| Prompt／工作範本 | M2 可接現有 prompt pool；範本只填入草稿，未送出前不執行 |
| 專案規則／記憶檢視 | 沿用原 API，顯示版本與作用域，不將開發規範混入客戶規則 |
| 簡易 Canvas | M3 以選段修改＋新版本達成，不直接寫正式檔案 |
| 語音輸入 | 後續獨立需求；採本機或系統能力須先確認資料流，不默默新增付費雲端語音 API |
| 截圖問答 | 先提供使用者明確貼圖；整合螢幕擷取需額外同意與隱私驗收 |
| 真正 token 串流 | 本案不做；需改回覆觀測／擷取契約，另行決策 |
| 中止正在生成的 M365 回覆 | 本案不做；只停止後續步驟，不新增 DOM stop click |
| 影像生成／新增模型 | 本案不做，不用介面宣稱支援 |
| 跨裝置同步／雲端帳號系統 | 本案不做，保持本機資料 |

## 18. 里程碑、依賴與交付

### M0：基準與護欄

讀現有 AGENTS／package scripts／架構與新差異，檢查 git status／branch／remote。建立或安全重用 `feat/chat-desktop-usability`，記錄 HEAD。檢查依賴安裝及既有測試，不啟動真實 M365 自動化。

交付 `BASELINE.md`、受保護檔案 manifest、已知問題／測試失敗分類、mock 資料隔離方法。確認可在不修改真實 .env／DB／Edge profile 下測試 UI。

### M1：日常對話穩定版（第一輪預設交付）

拆出最必要的 ChatComposer／MessageList／RunStatusCard，完成 IME、對話草稿隔離及加密保存、切換競態、複製／引用、按需 Inspector、可讀排版與完成狀態修正。可以分成安全的小 commit，不做一次巨大重構。

最低通過：中文組字不送、雙擊不重複提交、A/B 對話不混、草稿 CAS 不覆蓋新輸入、拒絕不執行、completed 不偽造逐步成功、既有控制檔未變。

M1 不做 Electron、全面事件 journal、全部格式預覽、全資料索引或模型串流。

### M2：找得到、更新順

搜尋與定位、置頂／封存管理、lazy sidebar、keyset pagination、具 scope／revision 的本機事件與 resync，必要時加入不改協定的本機 intent 去重。先確保正確，再量測效能。

交付搜尋範圍與 partial UX、斷線恢復、長對話測試及沒有明文索引的證據。

### M3：有證據的成果工作區

成果卡片與 sources、message_code／local_file／remote_link 區分、最小可用安全預覽、版本快照及新版本修改、明確另存／本機覆核標記。Office／PDF 預覽按 parser 驗收分批啟用，不用假預覽填滿進度。

交付實體 bytes 驗證、來源與版本、path 安全、HTML 不連外／不執行、缺檔與檔案變更狀態。

### M4：Windows 桌面包裝

在 M1～M3 穩定後增加 Electron／Node sidecar，做主視窗、快捷小窗、通知、啟動診斷與打包 smoke test。原瀏覽器 UI 必須仍可運作。

交付 Electron 安全測試、port ownership／退出行為、乾淨 Windows 使用者環境的安裝結果；未做真實安裝不得聲稱正式可發布。

## 19. 測試與驗收策略

完整逐項清單在同資料夾 `M365-Golem-Acceptance-Checklist.zh-TW.md`。

至少三層：純函式／store 與 service 單元測試、React 元件／本機 API 行為測試、Playwright 對 mock Golem UI 的 E2E。測 UI 的 Playwright 與凍結的 M365 Playwright 控制器是不同用途；UI E2E 不登入 Microsoft、不連租戶、不操作真實客戶資料。

mock 預設 deny 外連；只允許指定 localhost test server。使用合成訊息、暫存資料夾、測試專用金鑰與 DB。不得使用正式 .env／Cookie／MFA／客戶檔案，不能讓 fixtures 殘留在 release。

來源字串式測試因拆元件失效時，可改成更強的行為測試，但須保留同等安全契約，不得只刪掉失敗斷言。需對比 baseline 分清既有失敗、新增失敗與環境缺件。

建議命令，以本機 scripts 為準：

```powershell
npm.cmd run arch:check
npm.cmd test -- --runInBand
npm.cmd --prefix web-dashboard run lint
npm.cmd --prefix web-dashboard run build
```

M0 確認 TypeScript 設定後加入明確 typecheck script；元件／E2E script 應由實作建立，例如 `test:ux`、`test:e2e:ux`。不存在的 script 不能假裝已跑。Bridge 不應修改；若需做回歸，使用既有 `bridge:test` 並確認 fixture，不執行真實站台寫入。

### 建議效能目標（非既有成績）

在記錄規格的 Windows 參考機上，用 5,000 則合成對話做測試：暖快取切換體感目標 300ms 內；一般輸入不出現持續的 100ms 以上主執行緒阻塞；向上載入維持閱讀位置；搜尋若超過約 1 秒即顯示進度／可取消，不假稱沒結果。

依實測記錄 p50／p95、資料量、記憶體、測試機與 cold／warm；不把低階機器或 M365 服務延遲列為本機渲染性能失敗。模型回覆時間與 UI 接受／顯示時間分開量測。

### 真實 Windows／M365 人工 UAT

使用者明確啟動，先無敏感合成文字，再測試小附件及一次低風險工具。確認一個 UI 意圖只對應預期的一輪遠端提交、登入仍在 Edge、人工核對及拒絕正常。記錄「已實測」與「未測」；自動測試不能替代租戶、授權、資料保留與正式部署核准。

## 20. Git、發布、回退與完成定義

工作樹有既有修改時，不執行 `reset --hard`、`clean -fd`、自動 stash／覆蓋或強制切換。先記錄衝突；可安全獨立工作時在新 worktree 進行，但禁止自動複製 .env／data／Edge profile／IPC secrets。Codex worktree 可能有針對 ignored 檔案的配置能力，這不是授權複製真實秘密。[W7]

每個 commit 聚焦一件事，例如：基準與測試、IME、draft scope、render race、layout、run truth、search、events、artifacts、desktop。不得混入依賴大升級或無關重構。預設只做本機提交，不推 main、不合併、不自動發布或修改 GitHub 權限。

完成一個 milestone 必須交付：

- 改動摘要、完整 diff、保護邊界檢查與資料 migration 說明。
- 實際執行的命令、結果、未跑原因；不能只寫「測試應該通過」。
- 使用合成資料的 UI screenshots／必要測試輸出，不含客戶內容或秘密。
- 尚未支援能力、已知問題、人工 UAT 步驟與回退方法。
- 更新 `IMPLEMENTATION-STATUS.md`，標明目前 milestone、commit、完成項目及下一步。

文件狀態只有 proposed／in_progress／implemented／automated_test_passed／manual_uat_passed 等可證明階段；不得把 implemented 直接寫成 production approved。

## 21. Codex 開始方式

把本資料夾放入本機 repo 的 `docs/ux-rebuild/`，讓 Codex 先讀 `CODEX-START-HERE.zh-TW.md`，再讀本藍圖與清單。保留既有 root／子目錄 AGENTS.md；Codex 會依其規則讀取開發指示，但這些不是 Golem 客戶工作區的 runtime 記憶。[W8]

第一輪完成 M0＋M1 的可測版本後停止並交付報告，不自動擴張到全部 roadmap；若 session 需要接續，更新 IMPLEMENTATION-STATUS，而不是只在聊天說「之後再做」。

本次藍圖沒有修改 GitHub、沒有建立分支、沒有在使用者電腦執行命令。

## 22. 來源與查核範圍

所有 repo 引用皆固定到上述 commit。路徑與段落是靜態檢視依據；Codex 開工時需重新核對本機版本。以下 URL 供原始資料查核，沒有任何憑證。

### 儲存庫來源

Base：`https://github.com/Arvincreator/m365-golem/tree/3f91ecbe2e45666f277b20fd1f6b8596e93147a6`

- [R1] `web-dashboard/package.json`、`web-dashboard/next.config.ts`、根 `package.json`：依賴、scripts、static export／runtime。
- [R2] `web-dashboard/src/app/dashboard/chat/page.tsx`（輸入、state、輪詢、完整步驟顯示）及 `web-dashboard/src/app/dashboard/layout.tsx`（側欄、搜尋、專案樹）。
- [R3] `web-dashboard/routes/api.m365-workspace.js`：既有 projects／conversations／draft 以外的工作區 API、local browser guards。
- [R4] `src/core/PageInteractor.js`：`interact()` 與 complete-envelope response。
- [R5] `src/services/M365RunCoordinator.js`：pause／cancel／resume／recover 行為。
- [R6] `web-dashboard/src/components/M365MessageContent.tsx`：code cards、HTML sandbox、下載。
- [R7] `src/managers/M365WorkspaceStore.js`：schema、ciphertext／iv／tag、key validation、序列化與 transaction。
- [R8] `src/services/M365ProjectWorkspaceService.js`：專案 AGENTS.md／memory 與資料夾。
- [R9] `web-dashboard/server.js`、`web-dashboard/server/security.js`：server、port、security middleware 與 forwarded header 判斷。
- [R10] `web-dashboard/routes/api.chat.js`：responseMode 指示與 reference／MCP／Skills selection。
- [R11] `tests/M365WorkspaceUiRegression.test.js`：來源字串檢查及既有 UI 契約。
- [R12] `README.md`：現有附件預設、可見 Edge、Bridge 分工及發布界線。
- [R13] `web-dashboard/src/lib/api-client.ts`：read／write retry profile 與 API helpers。

可用固定 blob URL 查任一檔案：`https://github.com/Arvincreator/m365-golem/blob/3f91ecbe2e45666f277b20fd1f6b8596e93147a6/<上述路徑>`。

### 官方技術文件（2026-09-06 查核）

- [W1] MDN，keydown 與 IME：`https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event`
- [W2] React，useEffect 與 out-of-order fetch：`https://react.dev/reference/react/useEffect`
- [W3] Socket.IO，delivery guarantees：`https://socket.io/docs/v4/delivery-guarantees`
- [W4] Socket.IO，connection state recovery：`https://socket.io/docs/v4/connection-state-recovery`
- [W5] Electron，security：`https://www.electronjs.org/docs/latest/tutorial/security`
- [W6] Electron，context isolation：`https://www.electronjs.org/docs/latest/tutorial/context-isolation`
- [W7] OpenAI，Codex worktrees：`https://developers.openai.com/codex/environments/git-worktrees`
- [W8] OpenAI，AGENTS.md：`https://developers.openai.com/codex/guides/agents-md`
- [W9] SQLite，WAL 與持久資料：`https://www.sqlite.org/wal.html`

效能數字、UI 尺寸、模組命名、API 路徑、migration 表格與開發里程碑是本藍圖的設計決策，不是上述官方文件所宣稱的產品既有功能。
