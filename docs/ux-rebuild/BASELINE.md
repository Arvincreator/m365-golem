# M0 基準紀錄

日期：2026-09-07。範圍：M0 + M1，依使用者要求開 PR，不合併 main。

- 起始 HEAD：`103876f06b00ab0885d0d4f6c87695e72b7ca2cb`，分支 `codex/m365-workspace-autonomy`。
- 藍圖／遠端 main：`3f91ecbe2e45666f277b20fd1f6b8596e93147a6`。fetch 後確認其檔案樹與起始 HEAD 相同。
- 起始工作樹有大量既有修改。先保存 patch 與狀態於本機 `.tmp/ux-rebuild`，未 reset、clean、stash 或覆蓋它們。
- 基準提交：`c3fcea3`，205 個檔案，單獨保存開工前工作及原始藍圖。這不是本次 UX 作者變更。
- 本次工作分支：`codex/chat-desktop-usability`，使用專案預設功能分支前綴。
- 原始藍圖的 Markdown 行尾兩個空白是換行格式，原文保留。

## 必須分開審查的既有變更

相對 main，基準提交包含工作區自主流程、工具精簡、啟動器及 Bridge 改動。特別是 Bridge 的 default policy 在開工前已是 `writeEnabled: true`、`allowRecycle: false`。本次 UX 沒有更改該政策，也沒有套用任何執行中政策或存取站台；PR 相對 main 仍包含這些既有差異，審查者不能把它们誤認為 UX 改版的必要條件或新授權。

## 保護清單

`protected-files.json` 記錄起始工作樹的 SHA-256，涵蓋 Web M365 provider／Edge 設定、PageInteractor、信封與解析器、附件、dispatch service、run coordinator、核准設定及 Bridge 已追蹤來源。`node scripts/check-ux-protected.cjs` 比較本機原始 bytes；行尾不同的全新 checkout 應另比對基準 Git blob，不能直接稱為控制邏輯改變。

## 執行環境及基準檢查

Windows、Node v24.18.0、npm 11.16.0。既有 root 與 dashboard node_modules 均可用；沒有安裝或升級套件，沿用 lockfile。package lifecycle 只有既有安裝提示。

| 檢查 | 開工前結果 |
|---|---|
| `npm.cmd run arch:check` | 通過 |
| `npm.cmd test -- --runInBand` | 96 suites／766 tests 通過；Jest 有既有 open-handle 提示，測試結束後程序未自動退出 |
| `npm.cmd --prefix web-dashboard run lint` | 2 errors／42 warnings；errors 是 persona 頁的 JSX 引號，這次做等義 escape 修復 |
| `npm.cmd --prefix web-dashboard run build` | 通過，static export |

新增 `typecheck`、`test:ux`、`test:e2e:ux`，未新增測試框架依賴。mock UI 腳本只服務 static export，所有 API 攔截為合成資料，其他網路要求拒絕；使用全新 headless Edge context，不啟動 Golem、讀取實際 .env、DB、profile 或 Microsoft 登入。

基準原始日誌留在 `.tmp/ux-rebuild`，不進 Git。截圖僅含測試腳本內的合成資料。
