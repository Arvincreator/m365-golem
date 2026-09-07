# 工具語意路由優化

日期：2026-09-07。使用者要求優化向量路由，本次調整工具索引與候選選擇，不變更執行權限、M365 傳輸或核准流程。

- 本機文件製作、本機環境檢查及 Copilot 原生資料查找以能力描述加入既有本機向量索引。能力是候選描述，不是新工具或已安裝函式庫的保證。
- 保留最多三個能力候選，避免大量 MCP／範例占滿一般召回清單。既有 Skills／MCP 可用性篩選仍生效。
- LanceDB 明確使用 cosine 距離，再以 `1 - distance` 評分。本機能力需達 0.55，並高於原生候選至少 0.03；門檻是初版調校值，不代表通用準確率。
- 本機 command 可由語意候選提供，不再完全依賴關鍵字命中；明確遠端目的地、概念解釋與能力目錄問題仍有排除規則。語意相似本身不授權執行。
- 原生查找與本機製作分別判斷依賴，已有來源可繼續處理；不得編造尚未取得的來源內容。
- 向量搜尋最多等待 2.5 秒，失敗／空索引／逾時會明確退回關鍵字。診斷以 `[ToolRouter:diagnostics]` 輸出模式、退回原因、工具 ID／分數與選擇原因，不輸出使用者問題或文件內容。目前是診斷紀錄，尚未做成管理介面。

## 驗證

- 65 項路由、向量索引、M365 初始化、政策及協定測試通過；架構檢查通過。
- `node scripts/check-semantic-routing.cjs`：使用本機快取的 Transformers.js 中文模型，關閉模型網路下載；七個合成案例通過，包括未命中關鍵字的本機成果、Word、本機檢查、原生查找、遠端目的地、概念解釋與混合來源。
- 另以真實 LanceDB 暫存索引驗證 cosine 查詢及能力保留查詢。沒有使用客戶內容，也沒有執行 Copilot 任務或租戶檔案操作。
- 七個案例不代表完整工具庫準確率；仍需擴充失敗案例，驗證真實任務產出。後端重新啟動後，背景索引同步才會納入新能力；未就緒時診斷會顯示 fallback。
# Resource discovery and recovery

M365 action rules now require checking relevant resources before concluding inability:

- `golem-check python` (also `golem_check`) locates an executable through PATH without a shell; no argument probes python, py, node and git. A lookup failure means unverified, not uninstalled. Version, imports and permissions still require task-specific checks.
- `golem-check tools <task description>` asks the active brain's existing router for enabled Skill/MCP candidates and usage guides. It performs discovery only, preserves router filtering, and does not establish authentication or execute the discovered tools.
- Local Python/Node scripts are allowed through the existing command lane when appropriate. They retain Action Gate authorization, must use verified runtimes and actual inputs, and must validate produced artifacts.
- Failure handling separates missing inputs, runtime/package problems, argument errors, transport failures and access denials. Recovery is bounded to two changed/evidence-based retries; independent work can continue while a dependent step needs human assistance.

Validation: ToolScanner, TaskController, ProtocolFormatter M365 and ToolRouter suites pass (58 tests). This is automated host/protocol validation; live Copilot selection and tenant file access still require a real session test after restarting the backend.
