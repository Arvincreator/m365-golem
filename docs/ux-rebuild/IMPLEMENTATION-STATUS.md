# M0 + M1 交付狀態

日期：2026-09-07。狀態：implemented／automated_test_passed；manual_uat 未執行。M2–M4 未開始。

Branch：`codex/chat-desktop-usability`。UX 程式提交：`10a171c`。起始 HEAD 與既有工作基準提交見 `BASELINE.md`。

## 這次完成

- 中文 IME composition／229 防誤送、Shift+Enter、同步重複送出防護。輸入區自動增高，傳送等待期間可以輸入下一份草稿。
- 以 project＋conversation 作 React 工作區生命週期與草稿 controller key；切換時保留草稿、選取及 File。600ms idle 保存到現有 AES-GCM 欄位加密層，不使用明文 localStorage。
- 草稿 CAS／409、比較版本及明確選擇；ACK 後只清除送出版本，保留期間的新文字，空白版本作 tombstone。失敗或不明時保留文字，不自動重送、不取消可能已被 backend 使用的 batch。
- 附件描述重啟後標記需要重新選取；File 只在目前頁面生命週期。所有 scope 待選 File 合計限制 50 MiB；原服務端附件限制及 readiness 不變。
- 新增後端 project-reference 綁定。舊來源預設未指派，使用者明確加入目前專案後才能選取；API 在讀取內容／排隊前拒絕跨專案引用。
- 各查詢 generation／AbortController，舊 scope 及同 scope 過期結果不更新畫面；取消只作用於讀取，不控制後端 run。
- 一般回答複製／引用／詳細資訊；引用只進草稿、不自動傳送。只有帶結構化 stepId 的 system 訊息作工具紀錄，正常 GOLEM_ACTION 解說仍是一般回答。
- Inspector 預設關閉，使用有 focus trap 的右側 Dialog；Escape 關閉並返回來源按鈕。核准在聊天區可見。16px 正文、840px 內容上限及可獨立捲動的表格。閱讀旧訊息時不因活動泡泡強制跳底。
- 整體結案不覆寫 plan step status／進度條；已略過、受阻、待執行保留各自標示。暫停及停止後續步驟的文案區分已送出的遠端回合。

## 驗證與證據

| 檢查 | 結果 |
|---|---|
| Root Jest | 98 suites／779 tests 通過；使用 `--runInBand --forceExit`，既有 open-handle 問題未冒稱已修复 |
| `test:ux` | 44 項通過，包括加密／WAL、錯誤金鑰、兩個 DB connection 的 CAS、tombstone、scope、偽造來源、ACK 保留新文字及 IME |
| Dashboard lint | 0 errors，43 warnings；含既有 Hook／未使用變數警告，新查詢 dependency 提示已修正，未停用規則 |
| Dashboard build／typecheck | 通過；static export 及 `tsc --noEmit` |
| Architecture | 通過 |
| Protected manifest | 85 個檔案與開工前 bytes 一致；比較基準不是 main |
| Mock browser | 通過：IME／229、Shift+Enter、一次提交、ACK 後新草稿、引用、對話切換恢復、重載保存、Inspector／Escape／焦點及窄視窗無水平溢出 |
| 視覺檢查 | 合成畫面：`output/playwright/ux-rebuild/`，1366×768、1920×1080、1093／911 CSS-pixel 寬度；後兩者不是 Windows 真正 125%／150% UAT |

測試過程中先修正舊測試對「全部步驟完成」的預期及新綁定 mock；保留附件 readiness、核准、歷史與安全預覽檢查。mock server 初次錯用 next start／靜態路徑，修正為明確 static export 路由後通過。沒有 Microsoft 租戶或真實工具動作驗收。

## 設計差異／限制

- 後續語意路由優化：本機能力加入向量索引與保留召回，增加分數比較與退回診斷；65 項相關測試及七個本機模型合成案例通過。詳細設計、啟用方式與驗證限制見 `SEMANTIC-ROUTING.md`。

- 後續工具路由修正：以使用者「在桌面新增 Word 報告」等三種說法重現 command lane 未選取；補上明確本機文件製作辨識，以及遠端來源不可用不等於本機製作不可用的能力邊界。要求檢查實際文件函式庫、解析使用者指定本機目的地及驗證真實檔案，不能把文字改副檔名冒充 DOCX。遠端建立與純解釋仍不路由到本機製作。39 項路由／政策／協定測試與架構檢查通過；後端需重新啟動載入，未宣稱 Copilot 真實 Word 產出或完整 SharePoint 流程驗收通過。

- 後續提醒修正：WAITING_USER／BLOCKED／RECONCILE_REQUIRED 的操作移至主對話輸入區上方，側欄保留狀態摘要。新增八秒通知與持續提示，不因相同狀態輪詢重複彈出；定期同步 runs，涵蓋遺漏 socket 事件。使用者點選後才進入補充模式，原對話草稿保留；補充失敗不清除文字，補充只走既有 resume API，人工核對仍須明確選擇。補充文字暫存於當前頁面，未聲稱重新載入可恢復。建置、元件 lint 及 mock browser 的通知／輪詢／模式切換／失敗保留／接續／核對／停止檢查通過。

- 後續 UI 修正：移除 Inspector 重複標題／關閉鈕；1280 CSS px 以上改為 380px 並排側欄，聊天區隨之縮窄且可繼續操作。窄視窗保留有 focus trap 的 Dialog。側欄標頭固定、內容獨立捲動；關閉後焦點返回入口。建置、元件 lint、mock browser 的縮寬／不遮擋／持續輸入／按鈕切換／Escape／窄視窗檢查通過，更新合成截圖。

- M1 按現有路由格式新增 `/api/projects/:projectId/conversations/:conversationId/draft` GET／POST，沒有重造 chat dispatch。GET 回應 no-store；新增端點檢查實際 socket、精確本機 Host／Origin，拒絕 forwarded headers。
- 草稿 controller、query ticket 與訊息工具列已拆出 features；chat page 尚未完全拆成藍圖中所有元件。M2 繼續按功能拆分，不為拆檔改控制層。
- Inspector 桌面並排、窄視窗抽屜；未實作可拖拉欄寬。
- 正文複製使用已保存的可見回答內容，不額外取得遠端協定。沒有假串流、假模型選擇、假 Undo／分支／成果 vault。
- 最後一刻關閉／斷電前的未保存按鍵不保證恢復。記憶體中的 File 不落盤，重載需重選。未新增全文搜尋、事件 journal 或跨視窗全局提交 intent ledger（M2）。

## Migration、備份與回退

在現有 schema versions 1／2 後新增 version 3。新增 `conversation_drafts` 與 `project_reference_bindings`，不改既有欄位格式。遷移前使用 SQLite `VACUUM INTO` 建立同目錄、隨機尾碼的 `*.pre-ux-v3-*.sqlite` 一致性備份，包含已提交 WAL 內容，保留原欄位加密。只在測試 DB 執行過；沒有開啟正式 DB 進行遷移。

回退時先關閉擁有 DB 連線的 Golem 程序，保留當前 DB 與本機備份；回退 UX commit 可保留新增表。不要回退包含最新安全修正的基準提交。若要還原 pre-v3 備份，需明確接受遷移後本機新增資料遺失，另行由使用者執行；不得只覆蓋正在使用的主 DB、忽略 WAL。備份不進 Git、不自動刪除。

## 使用者人工 UAT

1. 在此功能分支啟動本機 Golem，確認加密草稿可保存；以合成專案開始，不使用真實客戶資料。
2. 用微軟注音組字／選字，再測試一般 Enter 和 Shift+Enter；確認一個意圖只有一輪遠端提交。
3. 兩個視窗編輯同一草稿，確認衝突比較；切換兩個專案，核對文字、工具、參考資料不混用。
4. 選一個小型合成附件、重載後重選，再由使用者送出；在可見 Edge 確認 OneDrive readiness、回覆及核准／拒絕。
5. 在 1366／1920 螢幕及 Windows 125%／150% 縮放檢查 Inspector、長文、表格、焦點及閱讀位置。
6. 以合成多步驟任務人工測試暫停／停止後續、傳送不明時核對。PR 保持未合併，未部署／發布 release。
