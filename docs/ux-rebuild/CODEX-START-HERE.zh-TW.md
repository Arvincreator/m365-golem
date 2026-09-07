# 給 Codex 的執行指令：M365 Golem 桌面體驗改版

把下面「任務指令」交給 Codex，在本機 `m365-golem` 儲存庫執行。這份文件的預設範圍是 M0＋M1，不是一次重寫整個專案。

## 任務指令

請在目前開啟的 `Arvincreator/m365-golem` 本機儲存庫，依下列文件實際修改程式、補測試並交付可審查的 diff，不要只提供建議或另一份計畫：

- `docs/ux-rebuild/M365-Golem-Desktop-UX-Blueprint.zh-TW.md`
- `docs/ux-rebuild/M365-Golem-Acceptance-Checklist.zh-TW.md`

先閱讀目前適用的根目錄／子目錄 AGENTS.md 與既有規範。保留它們，不覆蓋。特別區分 Codex 的開發指示與 Golem 在客戶工作資料夾內自主管理的 AGENTS.md／專案記憶；本次不得修改真實客戶規則。

### 目標

把現有 Golem 改成更順手、可信的桌面助理介面，但不改動原本控制 Web M365 的方式。第一輪只完成藍圖 M0 與 M1：輸入與草稿安全、對話隔離、非同步競態、訊息操作、版面及可信的任務狀態。

### 不可改動的邊界

維持可見 Edge、既有 Playwright 控制流程、M365 信封／Action／Observation、對話綁定、dispatch lease、序列化隊列、附件上傳檢查、核准與人工核對語意。

不得換成 API provider；不得新增 Microsoft OAuth／App Registration；不得讀取或匯出 Cookie／Token；不得把 M365 內嵌到 WebView；不得修改 Bridge 的站台／路徑白名單與寫入政策；不得提高自動核准權限、偷偷重送或直接操作真實客戶資料。

凍結檔案依藍圖第 3 節，並搜尋本機現有 M365 provider／selector／Edge 啟動設定加入保護清單。只有 UI、UX service、scope 驗證、加密資料的新增欄位與測試可依藍圖修改。無法在此邊界內完成的個別需求，記錄阻礙並保留原行為，不繞路實作。

### 開工步驟

1. 檢查 `git status`、目前 branch、HEAD 與 remote。文件基準是 `3f91ecbe2e45666f277b20fd1f6b8596e93147a6`，但須以目前本機較新程式為準，先記錄差異。不得 reset、clean、覆蓋或自動 stash 使用者既有修改。
2. 在確認不破壞現有工作後，建立或安全重用 `feat/chat-desktop-usability`。已有同名分支時先核對內容，不 force reset。若需新 worktree，不複製正式 .env、DB、profile 或秘密。
3. 核對依賴、scripts、來源與測試；安裝依賴前讀 lifecycle scripts，沿用 lockfile。不得為了改 UI 全面升級套件。
4. 建立 `docs/ux-rebuild/BASELINE.md`，記錄 HEAD、可執行測試、既有失敗、受保護檔案清單及 mock 測試方法。基準測試的失敗必須區分環境缺件與程式錯誤。
5. 對 M1 規格補能失敗的行為測試，再以小步驟完成實作。控制層保護 manifest 的比較結果需列入驗收。

### M1 必須完成

- 中文 IME 組字／選字不誤送；Shift+Enter 換行；雙擊／連續 Enter 不產生重複送出。
- 按 projectId＋conversationId 隔離草稿、參考檔及工具選擇。持久草稿沿用本機欄位加密，無金鑰不得退回明文 localStorage。
- 草稿 CAS／revision、多視窗衝突、送出後只清除已提交版本，舊 autosave 不能把它復活。附件 File 不假裝能在重啟後恢復。
- 舊對話慢回覆不能覆蓋新對話；同一對話的舊請求也不能蓋掉較新狀態。讀取取消不等於取消後端工作。
- 一般回覆的複製與引用追問，維持原訊息與遠端歷史；不自動重播工具。
- 右側 Inspector 按需開啟，聊天閱讀空間、字級及輸入框改善；保留既有工具入口與安全預覽。
- 任務整體完成不把所有步驟強制標為成功；暫停／停止後續步驟／遠端回合可能仍完成的文案明確。
- 真實功能可用才顯示可用；不做假串流、假下載、假 Undo 或假模型選擇。

M1 不必實作 Electron、全文事件 journal、完整成果 vault、全部格式預覽或雲端功能。這些是 M2～M4，不能因規格很完整就自行擴張第一輪範圍。

### 測試規則

使用合成資料、測試 DB／金鑰／暫存資料夾與 mock M365 結果。UI E2E 不得自動開啟真實 Microsoft 登入或存取租戶。真實 Windows／M365 UAT 留給使用者明確執行。

沿用實際存在的 scripts，例如：

```powershell
npm.cmd run arch:check
npm.cmd test -- --runInBand
npm.cmd --prefix web-dashboard run lint
npm.cmd --prefix web-dashboard run build
```

檢查 TypeScript 設定後補明確 typecheck；新增元件及 mock UI E2E scripts 後再執行。不存在的命令不得聲稱通過。拆元件使來源字串式測試失效時，以等價或更強的行為測試替換，不能直接刪掉安全斷言。

### 結束前交付

完成 M0＋M1 後停止，不自行進入 M2～M4。提供修改檔案與設計決策、實際測試結果、基準既有失敗與新失敗、邊界檔未改的證據、migration／回退方式、合成資料畫面及明天的人工 UAT 步驟。

更新 `docs/ux-rebuild/IMPLEMENTATION-STATUS.md`，列清目前 milestone、完成／未完成項目、commit、已跑／未跑測試與下一步。允許在新功能分支做可審查的本機 commit；未另獲明確指示前，不 push main、不自動 merge、不發布 release、不改遠端權限。

若缺少依賴／權限或需要人工決策，說明具體阻礙；其他不受阻的本機測試與實作仍應完成。不得用假通過或修改安全預設來繞過阻礙。

## 更短的啟動訊息

> 請先閱讀 `docs/ux-rebuild/CODEX-START-HERE.zh-TW.md`，依其中指令及技術藍圖，實際完成 M0＋M1，修改程式與測試；保留 Web M365 控制、信封／Action／Observation、Bridge 及核准機制。在新功能分支交付可審查結果，不動 main，不自行進入 M2～M4。
