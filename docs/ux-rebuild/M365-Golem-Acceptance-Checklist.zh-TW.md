# M365 Golem 改版驗收清單

版本：1.0｜2026-09-06  
搭配：`M365-Golem-Desktop-UX-Blueprint.zh-TW.md`  
初始狀態：全部「未執行」。此文件不是測試通過報告。

每個項目執行後，追加環境、commit、命令／操作、實際結果與證據。狀態使用：未執行、通過、失敗、受阻、不適用（附理由）。不能以已寫程式取代通過。

## A. M0：工作樹、邊界與測試環境

| ID | 測試／檢查 | 通過條件 | 初始狀態 |
|---|---|---|---|
| A01 | 檢查 branch／HEAD／git status | 記錄基準；未覆蓋、刪除或 stash 使用者既有修改 | 未執行 |
| A02 | 確認新功能分支 | 不在 main 開發，不 force reset 同名分支 | 未執行 |
| A03 | 比較 protected manifest | Web M365 控制／信封 parser／Bridge 等受保護檔案未變；無新增替代 provider | 未執行 |
| A04 | 檢查真實資料隔離 | 測試 DB／金鑰／檔案皆為合成；未讀真實 profile／Cookie／客戶資料 | 未執行 |
| A05 | 跑基準測試與 build | 記錄通過／失敗／環境缺件；不得把基準失敗藏起來 | 未執行 |
| A06 | 檢查 release／Git diff | 無 .env、DB、WAL、SHM、附件、私密日誌、金鑰或絕對機器路徑 | 未執行 |
| A07 | 檢查本機 API／Socket 信任來源 | 新端點不能用偽造 X-Forwarded-For／任意 Host／外站 Origin 取得本機特權 | 未執行 |

## B. M1：輸入、草稿、隔離與訊息

| ID | 測試／操作 | 通過條件 | 初始狀態 |
|---|---|---|---|
| B01 | 模擬 compositionstart→Enter→compositionend | 不呼叫 submit／dispatch | 未執行 |
| B02 | 模擬 compositionend 先發生、keydown keyCode=229 | 不誤送；另保留 Windows 注音人工測試 | 未執行 |
| B03 | 英文 Enter、Shift+Enter、連續 keydown | 正確送出／換行；repeat 不多送 | 未執行 |
| B04 | 點兩次送出＋Enter 同時觸發 | 同一輸入快照只產生一次本機提交 | 未執行 |
| B05 | 送出 A 文字後馬上輸入 B | A 成功回應不清掉 B；草稿版本不回退 | 未執行 |
| B06 | A 客戶輸入草稿及選工具→切 B→回 A | B 不含 A 草稿／選取；A 恢復自身內容 | 未執行 |
| B07 | A 對話慢查詢在 B 查詢後才返回 | B 的 messages／runs／errors／sources 不被 A 覆蓋 | 未執行 |
| B08 | 同一 scope 舊請求晚返回 | 不覆蓋較新的訊息與 delivery 狀態 | 未執行 |
| B09 | 切換頁面取消讀取請求 | 不產生取消 run／重送／刪附件等副作用 | 未執行 |
| B10 | 草稿 idle 保存後重新載入 | text／資源選擇可恢復，從 server 加密資料取得 | 未執行 |
| B11 | 缺少或使用錯誤 encryption key | 明確失敗，不存明文、不自動重設 DB | 未執行 |
| B12 | 在 SQLite／WAL／log／localStorage 搜測試秘密字串 | 草稿敏感內容無明文副本；測試須涵蓋新增持久儲存 | 未執行 |
| B13 | 主視窗與第二視窗同時保存不同版本 | 409 衝突可理解；保留文字，不靜默互相覆蓋 | 未執行 |
| B14 | 送出清除後讓舊 debounce 返回 | 舊草稿不復活；tombstone／revision 正常 | 未執行 |
| B15 | 網路斷線或提交 ACK 遺失 | 顯示需確認並保留文字，不自動重送；不誤刪後端正在用的 batch | 未執行 |
| B16 | 重啟有待選附件的草稿 | 檔名可見但標明重新選取；不宣稱原始 File 已恢復 | 未執行 |
| B17 | 10 檔／25MiB／50MiB 邊界與無效格式 | 後端原本限制不降低；錯誤檔不被偷偷上傳 | 未執行 |
| B18 | 只選檔／貼圖、但沒有送出 | 沒有 M365 上傳；不自動讀取剪貼簿歷史 | 未執行 |
| B19 | 引用一段 AI 回答／複製整則回答 | 引用進同 scope 草稿；複製不混入隱藏控制協定；不自動送出 | 未執行 |
| B20 | 回覆只是解釋 GOLEM_ACTION 字樣 | 不被誤認成可核准的真實工具動作 | 未執行 |
| B21 | 後端拒絕跨專案 referenceId／conversationId | 不是只有 UI 過濾，直接 API 請求也不能混客戶 | 未執行 |
| B22 | 右側收合、長表格、長文、125%／150% 縮放 | 無橫向頁面溢出；主要輸入／核准控制可用 | 未執行 |
| B23 | 鍵盤切換及抽屜焦點 | 操作有 aria label／可見 focus；關閉回到來源控制項 | 未執行 |
| B24 | 使用者正在閱讀舊訊息時收到新答案 | 不強制捲到底；可按未讀／回底部 | 未執行 |

## C. M1：任務與安全語意

| ID | 測試／操作 | 通過條件 | 初始狀態 |
|---|---|---|---|
| C01 | pending action 尚未核准 | 不執行任何本機／遠端寫入 | 未執行 |
| C02 | 拒絕／過期／其他對話的 approval | backend 拒絕，UI 不假成功 | 未執行 |
| C03 | run=CANCELED 但既有遠端回合仍完成 | 文案為停止後續；最後結果仍可保存但不觸發額外後續工作 | 未執行 |
| C04 | RUNNING 時按 pause | 明確表示目前步驟後暫停；不宣稱已中止 Edge | 未執行 |
| C05 | run 完成但 plan 有 skipped／blocked／pending | 各步保留原狀態，非全部打勾；人工結案來源可見 | 未執行 |
| C06 | 傳送結果 ambiguous／reconcile_required | 不自動重送、不開啟另一條 API／瀏覽器通道 | 未執行 |
| C07 | quick／thoughtful／auto 切換 | 只改原本 responseMode，UI 不捏造實際模型名稱 | 未執行 |
| C08 | 長時間等待完整信封 | 真實階段文字，不做假 token 串流或虛構思考內容 | 未執行 |

## D. M2：搜尋、分頁與事件

| ID | 測試／操作 | 通過條件 | 初始狀態 |
|---|---|---|---|
| D01 | 目前專案／全本機／封存範圍搜尋 | 範圍明確；預設不混入其他專案；不洩漏無 scope 資料 | 未執行 |
| D02 | 搜尋早於最近 500 則的內容 | 能查較早紀錄或顯示 partial／未掃描範圍，不假裝查完 | 未執行 |
| D03 | 搜尋中文、英文大小寫及惡意 HTML 字串 | 內容可比對且高亮安全，無 HTML 注入 | 未執行 |
| D04 | 點搜尋結果／around-message | 正確訊息進入閱讀視窗，不載入全部歷史或切錯對話 | 未執行 |
| D05 | 檢查索引／瀏覽器 cache／URL／log | 無解密全文 FTS、JSON 副本、搜尋 query 日誌或外部索引服務 | 未執行 |
| D06 | 多訊息相同 createdAt＋prepend | keyset 不漏不重，scroll anchor 保持 | 未執行 |
| D07 | 舊訊息 delivery 改變 | 仍可經 revision 更新，不只處理新訊息 | 未執行 |
| D08 | 收到 duplicate／out-of-order events | 依 eventId／revision 去重，不出現重複答案 | 未執行 |
| D09 | Socket 斷線、重連、cursor 過期 | resync snapshot，沒有 replay 模型回合或 command | 未執行 |
| D10 | 跨專案過濾導致全域 sequence 跳號 | 不誤判為資料遺失、不無限重抓 | 未執行 |
| D11 | 偽造 Socket room subscription | 無法取得其他 scope 資料；事件無 prompt／path／token | 未執行 |
| D12 | 同 intentId 同內容／不同內容 | 回原結果／409；後端只有一次可核對提交 | 未執行 |
| D13 | intent 已保留但提交狀態不明時重啟 | 進 reconcile，不自動重送 | 未執行 |
| D14 | 多專案側欄與 5,000 則合成長對話 | lazy fetch；效能實測有環境與 p50／p95，沒有全量重抓風暴 | 未執行 |
| D15 | 封存執行中的對話 | 沿用 backend 拒絕或原本安全規則；本機封存不稱遠端刪除 | 未執行 |

## E. M3：成果、預覽、版本與檔案

| ID | 測試／操作 | 通過條件 | 初始狀態 |
|---|---|---|---|
| E01 | AI 只有文字說「已建立檔案」 | 不產生已驗證 local_file 卡片或假下載 | 未執行 |
| E02 | message code card | 標為訊息內容，可複製／主動匯出，不假稱先前已寫檔 | 未執行 |
| E03 | 有可信 receipt 與實際 bytes | 比對 scope／path／hash／size，正確登記來源 | 未執行 |
| E04 | remote link 未下載／連結過期 | 顯示遠端來源與未知 availability，不抓 Cookie、不假本機預覽 | 未執行 |
| E05 | 本機已登記檔案外部修改／移除 | 顯示 changed／missing，舊版本不指向新 bytes | 未執行 |
| E06 | 版本回復／另存副本 | 真正有 snapshot 才回復；不默默覆寫；無 snapshot 只能顯示版本紀錄 | 未執行 |
| E07 | 惡意 HTML：script、onerror、form、meta refresh、外部 anchor／CSS URL | 無腳本／外連／popup／導覽／本機讀取；sandbox 不放寬 | 未執行 |
| E08 | 惡意 SVG／超大圖片／壓縮炸彈／ZIP traversal | 受限 parser 拒絕；不寫到目標 scope 外 | 未執行 |
| E09 | ../、Windows junction／symlink／UNC／ADS／大小寫變化 | 不能越過 realpath 與實際開啟的路徑檢查 | 未執行 |
| E10 | .ps1／.exe／.lnk／巨集文件當成果 | 不自動執行；一般開啟入口受限 | 未執行 |
| E11 | CSV 文字欄以 =／+／-／@ 開頭 | 匯出不觸發公式注入；真正數值與刻意公式未被錯誤破壞 | 未執行 |
| E12 | 來源面板有選取但沒有注入／讀取證據 | 不宣稱 AI 已讀；分開呈現選取、注入與引用 | 未執行 |
| E13 | 前端改 artifactId／versionId／conversationId | 不能預覽／匯出另一個專案的檔案 | 未執行 |
| E14 | 本機 reviewed 標記 | 不被描述成主管 Approvals／正式法定覆核 | 未執行 |
| E15 | artifact vault／暫存／刪除／備份 | 加密、上限、清理規則可驗證；匯出的明文保護範圍有說明 | 未執行 |

## F. M4：Electron 與 Windows 人工測試

| ID | 測試／操作 | 通過條件 | 初始狀態 |
|---|---|---|---|
| F01 | renderer 嘗試 require／fs／child_process／任意 IPC | 不可用；contextIsolation、sandbox、webSecurity 開啟 | 未執行 |
| F02 | 惡意 iframe／遠端頁面呼叫 preload | sender／frame／origin 驗證拒絕 | 未執行 |
| F03 | port 被非 Golem 程序占用 | 不信任假服務、不殺該程序、不放寬全部 Origin | 未執行 |
| F04 | 已有 backend → 開關桌面視窗 | 不任意關掉別的 instance；ownership 記錄正確 | 未執行 |
| F05 | 主視窗與快捷小窗同時輸入／送出 | 同一 draft revision／intent，無獨立重複隊列 | 未執行 |
| F06 | 全域快捷鍵衝突、Escape、IME | 可恢復，不攔截組字或錯取消任務 | 未執行 |
| F07 | 鎖定螢幕收到完成／核准通知 | 不含客戶名稱、檔名或內容，除非另有明確設定 | 未執行 |
| F08 | 關閉視窗／結束服務，旁邊開日常 Edge | 只處理己方程序，無 blanket taskkill，保留使用者 Edge | 未執行 |
| F09 | 乾淨 Windows 使用者環境安裝／啟動 | 依賴、Node ABI、原生模組、靜態資源完整，無秘密進包 | 未執行 |
| F10 | 使用者在 Edge 登入／MFA／條款提示 | 流程仍可見、由使用者操作，無新 OAuth／Cookie 移轉 | 未執行 |
| F11 | 一則合成文字與一個小附件實機往返 | 遠端提交數量符合預期，附件仍等待原本 readiness | 未執行 |
| F12 | 人工拒絕低風險測試工具／結果不明核對 | 原安全閘與核對流程仍有效 | 未執行 |
| F13 | 原本瀏覽器版 Dashboard | 不依賴 Electron 才能對話及查看成果 | 未執行 |
| F14 | 更新／降級／migration backup | 版本與備份有驗證；未簽章更新不自動執行 | 未執行 |

## G. 每一里程碑必填交付紀錄

```text
Milestone:
Branch / Commit:
基準 Commit:
作業系統 / Node / npm:
變更摘要:
受保護檔案差異:
新 migration 與備份:
執行過的測試命令與結果:
未執行項目及原因:
基準既有失敗:
本次新增失敗:
安全與資料處理檢查:
合成資料 UI 畫面位置:
人工 UAT 狀態:
回退步驟:
剩餘風險與下一步:
```

只有對應條件實際滿足才填通過。M1 完成時，M2～M4 維持未執行，不因整份規格已閱讀而改成已完成。
