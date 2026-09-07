# PR 前檢查

日期：2026-09-07。Verdict：GO WITH RISK，僅開 Draft PR 供審查，不是部署／合併批准。

- 基準提交 `c3fcea3` 保存開工前 205 檔變更及藍圖；UX 提交 `10a171c` 為 29 檔、1005 新增行／92 刪除行，含合成截圖。兩者不可混為本次 UX 控制層變更。
- 目標：M0＋M1 的輸入、草稿、scope、訊息操作、閱讀與真實狀態已實作；M2–M4 未開始。完整元件拆分／可拖拉欄寬列為後續，人工 UAT 尚未執行。
- 品質：沿用現有傳送、queue、信封、Action Gate 及加密 helper。85 個控制／Bridge 檔案與開工前 SHA-256 一致。新增端點有實際 HTTP 的 Host／scope／CAS／no-store 測試。
- 證據：98 suites、779 tests 通過，build、typecheck、architecture、mock browser 通過；lint 0 errors／43 warnings。Jest 使用 forceExit 處理既有 open handles，沒有宣稱已修正。
- 發佈資料面：逐項暫存 source／tests／docs／合成 PNG；基準 126 個新增或修改檔案及 UX 29 個檔案的索引掃描未發現實際高可信金鑰格式、DB、profile、.env、日誌或 runtime cache。基準測試裡有禁止特定使用者路徑的 regex 斷言，不是實際資料。掃描是防誤帶檢查，不宣稱形式化機密證明。
- 未推送 `.tmp/ux-rebuild` 的基準 patch／程序日誌。原始藍圖 Markdown 的雙空白換行格式原樣保留；UX diff whitespace 檢查通過。
- 風險：main 的 PR diff 包含原先未提交的工具刪除與 Bridge default policy 差異，需獨立審查，詳見 `BASELINE.md`。UX 沒有套用 live policy，也沒有新增站台權限或執行真實客戶工作。
- 上線前：由使用者完成微軟注音、Windows 縮放、可見 Edge 登入、小附件、核准／拒絕與暫停／停止的合成資料 UAT；備份／回退說明見 `IMPLEMENTATION-STATUS.md`。
