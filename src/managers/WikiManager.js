// ============================================================
// 📖 WikiManager — LLM 維護的持久知識 Wiki 層
// ============================================================
// 基於 llm-wiki.md 的「知識 Wiki 模式」:
// - Raw Sources (對話、事件) → Wiki Pages (結構化知識實體)
// - LLM 維護 wiki，人類提問與策展
// - index.md (內容目錄) + log.md (時序日誌)
// ============================================================

const fs   = require('fs');
const path = require('path');

// Wiki 中最大的單頁字元數（防止注入時撐爆 context）
const MAX_PAGE_CHARS = 8000;
// 單次 query 最多注入的總字元數
const MAX_INJECT_CHARS = 20000;
// log.md 每次最多讀取的行數
const MAX_LOG_LINES = 200;

/**
 * 📖 WikiManager
 *
 * 管理 `<userDataDir>/wiki/` 目錄下的 Markdown 知識頁面。
 *
 * 目錄結構：
 * wiki/
 * ├── index.md          ← 內容目錄（自動維護）
 * ├── log.md            ← append-only 更新日誌
 * ├── user/             ← 使用者相關知識
 * │   └── profile.md
 * ├── projects/         ← 專案相關知識
 * └── decisions/        ← 架構決策紀錄
 */
class WikiManager {
    /**
     * @param {string} userDataDir - Golem 的 userData 根目錄 (e.g. ./golem_memory)
     */
    constructor(userDataDir) {
        this.userDataDir = userDataDir;
        this.wikiDir     = path.join(userDataDir, 'wiki');
        this.indexPath   = path.join(this.wikiDir, 'index.md');
        this.logPath     = path.join(this.wikiDir, 'log.md');
    }

    // ─── Init ─────────────────────────────────────────────────

    /**
     * 初始化 wiki 目錄與必要的預設檔案
     * 安全地幂等執行（多次呼叫無副作用）
     */
    init() {
        // 建立基礎目錄
        const dirs = [
            this.wikiDir,
            path.join(this.wikiDir, 'user'),
            path.join(this.wikiDir, 'projects'),
            path.join(this.wikiDir, 'decisions'),
        ];
        for (const d of dirs) {
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        }

        // 初始化 index.md（若不存在）
        if (!fs.existsSync(this.indexPath)) {
            fs.writeFileSync(this.indexPath, this._defaultIndex(), 'utf8');
        }

        // 初始化 log.md（若不存在）
        if (!fs.existsSync(this.logPath)) {
            fs.writeFileSync(this.logPath, `# Wiki 更新日誌\n\n`, 'utf8');
        }
    }

    // ─── Page CRUD ────────────────────────────────────────────

    /**
     * 讀取一個 wiki 頁面，路徑相對於 wikiDir
     * @param {string} pagePath - e.g. 'user/profile.md'
     * @returns {string|null}
     */
    readPage(pagePath) {
        const full = path.join(this.wikiDir, pagePath);
        if (!fs.existsSync(full)) return null;
        const content = fs.readFileSync(full, 'utf8');
        return content.length > MAX_PAGE_CHARS
            ? content.slice(0, MAX_PAGE_CHARS) + '\n\n_[內容超過限制，已截斷]_'
            : content;
    }

    /**
     * 寫入（覆蓋）一個 wiki 頁面
     * @param {string} pagePath - 相對於 wikiDir，e.g. 'user/profile.md'
     * @param {string} content  - Markdown 內容
     * @param {string} [reason] - 更新原因（寫入 log.md）
     */
    writePage(pagePath, content, reason = '手動更新') {
        this.init();
        const full = path.join(this.wikiDir, pagePath);
        const dir  = path.dirname(full);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(full, content, 'utf8');
        this._appendLog('update', pagePath, reason);
        this._rebuildIndex();
    }

    /**
     * 刪除一個 wiki 頁面
     * @param {string} pagePath
     */
    deletePage(pagePath) {
        const full = path.join(this.wikiDir, pagePath);
        if (fs.existsSync(full)) {
            fs.unlinkSync(full);
            this._appendLog('delete', pagePath, '頁面刪除');
            this._rebuildIndex();
        }
    }

    /**
     * 列出所有 wiki 頁面（遞迴掃描）
     * @returns {Array<{path: string, size: number, mtime: Date}>}
     */
    listPages() {
        this.init();
        const results = [];
        this._scanDir(this.wikiDir, this.wikiDir, results);
        return results.filter(p =>
            p.path !== 'index.md' && p.path !== 'log.md' && p.path.endsWith('.md')
        );
    }

    // ─── Ingest ───────────────────────────────────────────────

    /**
     * 攝入新知識：讓 LLM 決定如何整合到 wiki 中
     * 此函式只構造提示詞並回傳，由 GolemBrain 負責發送
     *
     * @param {string} sourceTitle - 來源名稱 (e.g. '使用者對話', '技術文件')
     * @param {string} sourceContent - 來源內容
     * @param {string[]} [relevantPages] - 可能需要更新的頁面路徑清單
     * @returns {string} 攝入提示詞
     */
    buildIngestPrompt(sourceTitle, sourceContent, relevantPages = []) {
        this.init();

        const indexContent = this.readPage('index.md') || '（尚無內容）';
        let pagesContext = '';
        for (const p of relevantPages) {
            const content = this.readPage(p);
            if (content) pagesContext += `\n\n---\n## 現有頁面：${p}\n${content}`;
        }

        return `【Wiki 攝入指令】
你是 Golem 的知識庫管理員。你需要將以下新資訊整合到結構化的 Wiki 知識庫中。

**新資訊來源**：${sourceTitle}
**內容**：
${sourceContent}

**現有 Wiki 目錄** (index.md)：
${indexContent}
${pagesContext}

**你的任務**（請嚴格按照以下格式回覆）：

1. 分析哪些 wiki 頁面需要新建或更新（每個頁面的路徑相對於 wiki/ 目錄）
2. 對每個需要更新的頁面，輸出如下格式：

\`\`\`wiki-page
path: user/profile.md
---
（完整的 Markdown 頁面內容）
\`\`\`

3. 回覆結束後，輸出：
WIKI_INGEST_DONE`;
    }

    /**
     * 解析 LLM 對 buildIngestPrompt 的回覆，提取並寫入 wiki 頁面
     * @param {string} llmResponse
     * @param {string} [sourceTitle]
     * @returns {{saved: string[], errors: string[]}}
     */
    parseAndSaveIngestResponse(llmResponse, sourceTitle = '未知來源') {
        const saved  = [];
        const errors = [];

        // 匹配所有 ```wiki-page ... ``` 區塊
        const blockRegex = /```wiki-page\n([\s\S]*?)```/g;
        let match;

        while ((match = blockRegex.exec(llmResponse)) !== null) {
            try {
                const block   = match[1];
                const pathMatch = block.match(/^path:\s*(.+)$/m);
                if (!pathMatch) {
                    errors.push('缺少 path: 欄位');
                    continue;
                }

                const pagePath = pathMatch[1].trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_./]/g, '');
                if (!pagePath.endsWith('.md')) {
                    errors.push(`路徑必須為 .md 檔案: ${pagePath}`);
                    continue;
                }

                // 路徑穿越 (path traversal) 防護
                const resolvedPath = path.resolve(this.wikiDir, pagePath);
                if (!resolvedPath.startsWith(path.resolve(this.wikiDir))) {
                    errors.push(`⚠️ 拒絕路徑穿越攻擊: ${pagePath}`);
                    continue;
                }

                // 提取 --- 分隔符後的內容
                const separatorIdx = block.indexOf('\n---\n');
                const content = separatorIdx !== -1
                    ? block.slice(separatorIdx + 5).trim()
                    : block.replace(/^path:.*\n/, '').trim();

                if (!content) {
                    errors.push(`空白頁面，跳過: ${pagePath}`);
                    continue;
                }

                this.writePage(pagePath, content, `攝入自: ${sourceTitle}`);
                saved.push(pagePath);
            } catch (e) {
                errors.push(e.message);
            }
        }

        if (saved.length > 0) {
            this._appendLog('ingest', saved.join(', '), `來源: ${sourceTitle}`);
        }

        return { saved, errors };
    }

    // ─── Query ────────────────────────────────────────────────

    /**
     * 取得供注入 systemPrompt 的 wiki 知識摘要
     * 優先讀取高密度、長期穩定的知識頁面
     *
     * @param {number} [maxChars=MAX_INJECT_CHARS]
     * @returns {string} 整合後的 wiki 知識文字
     */
    getInjectionContext(maxChars = MAX_INJECT_CHARS) {
        this.init();
        const pages = this.listPages();
        if (pages.length === 0) return '';

        // 優先順序：user/ > decisions/ > projects/ > 其他
        const priority = ['user/', 'decisions/', 'projects/'];
        pages.sort((a, b) => {
            const ai = priority.findIndex(p => a.path.startsWith(p));
            const bi = priority.findIndex(p => b.path.startsWith(p));
            const ap = ai === -1 ? priority.length : ai;
            const bp = bi === -1 ? priority.length : bi;
            if (ap !== bp) return ap - bp;
            // 同優先級：按修改時間排序（最近修改優先）
            return b.mtime - a.mtime;
        });

        let context = '📖 **[Wiki 知識庫]** 以下是你已掌握的結構化知識，請視為先驗背景：\n\n';
        let totalChars = context.length;

        for (const page of pages) {
            const content = this.readPage(page.path);
            if (!content) continue;

            const section = `### wiki/${page.path}\n${content}\n\n`;
            if (totalChars + section.length > maxChars) break;

            context    += section;
            totalChars += section.length;
        }

        return totalChars > context.length ? context.trim() : '';
    }

    /**
     * 搜尋 wiki 頁面（簡單關鍵字比對）
     * @param {string} query
     * @returns {Array<{path: string, snippet: string}>}
     */
    search(query) {
        this.init();
        const pages   = this.listPages();
        const results = [];
        const lq      = query.toLowerCase();

        for (const page of pages) {
            const content = this.readPage(page.path) || '';
            if (content.toLowerCase().includes(lq)) {
                // 找出命中片段
                const idx     = content.toLowerCase().indexOf(lq);
                const start   = Math.max(0, idx - 60);
                const end     = Math.min(content.length, idx + query.length + 60);
                const snippet = (start > 0 ? '...' : '') +
                    content.slice(start, end) +
                    (end < content.length ? '...' : '');
                results.push({ path: page.path, snippet: snippet.replace(/\n/g, ' ') });
            }
        }
        return results;
    }

    // ─── Lint ─────────────────────────────────────────────────

    /**
     * 健康檢查：找出孤兒頁面、過時內容等問題
     * @returns {Object} lint 報告
     */
    lint() {
        this.init();
        const pages  = this.listPages();
        const index  = this.readPage('index.md') || '';
        const report = {
            total:       pages.length,
            orphans:     [],     // 不在 index.md 中的頁面
            stale:       [],     // 超過 30 天未更新
            small:       [],     // 過小（< 50 字元，可能是空殼頁面）
            summary:     '',
        };

        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

        for (const page of pages) {
            // 孤兒頁（不在 index 中）
            if (!index.includes(page.path)) {
                report.orphans.push(page.path);
            }
            // 過時頁
            if (page.mtime < thirtyDaysAgo) {
                const daysOld = Math.floor((Date.now() - page.mtime) / (24 * 60 * 60 * 1000));
                report.stale.push({ path: page.path, daysOld });
            }
            // 過小頁
            if (page.size < 50) {
                report.small.push(page.path);
            }
        }

        const issues = report.orphans.length + report.stale.length + report.small.length;
        report.summary = issues === 0
            ? `✅ Wiki 健康度 OK：共 ${pages.length} 個頁面，無問題。`
            : `⚠️ Wiki 發現 ${issues} 個問題：孤兒頁×${report.orphans.length}、過時頁×${report.stale.length}、空殼頁×${report.small.length}`;

        this._appendLog('lint', '-', report.summary);
        return report;
    }

    // ─── Log ──────────────────────────────────────────────────

    /**
     * 讀取最近的 wiki 更新日誌
     * @param {number} [lineLimit]
     * @returns {string}
     */
    readLog(lineLimit = MAX_LOG_LINES) {
        if (!fs.existsSync(this.logPath)) return '（尚無日誌）';
        const lines = fs.readFileSync(this.logPath, 'utf8').split('\n');
        return lines.slice(-lineLimit).join('\n');
    }

    // ─── Private ──────────────────────────────────────────────

    /** 在 log.md 尾端追加一條新記錄 */
    _appendLog(operation, target, detail = '') {
        const ts      = new Date().toISOString().slice(0, 10);
        const hms     = new Date().toTimeString().slice(0, 8);
        const entry   = `## [${ts} ${hms}] ${operation} | ${target}${detail ? `\n> ${detail}` : ''}\n\n`;
        fs.appendFileSync(this.logPath, entry, 'utf8');
    }

    /** 重建 index.md */
    _rebuildIndex() {
        const pages = this.listPages();
        if (pages.length === 0) {
            fs.writeFileSync(this.indexPath, this._defaultIndex(), 'utf8');
            return;
        }

        // 依目錄分組
        const groups = {};
        for (const page of pages) {
            const parts = page.path.split('/');
            const cat   = parts.length > 1 ? parts[0] : '其他';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(page);
        }

        let content = `# Wiki 索引\n\n_最後更新：${new Date().toLocaleString('zh-TW')} | 共 ${pages.length} 個頁面_\n\n`;

        for (const [cat, catPages] of Object.entries(groups)) {
            content += `## ${cat}/\n\n`;
            for (const page of catPages) {
                // 嘗試讀取第一行作為摘要
                const raw     = this.readPage(page.path) || '';
                const firstH1 = raw.match(/^#\s+(.+)$/m);
                const desc    = firstH1 ? firstH1[1].trim() : '（無標題）';
                const updated = new Date(page.mtime).toLocaleDateString('zh-TW');
                content += `- [${page.path}](${page.path}) — ${desc} _(${updated})_\n`;
            }
            content += '\n';
        }

        fs.writeFileSync(this.indexPath, content, 'utf8');
    }

    /** 遞迴掃描目錄，排除 index.md、log.md 和非 .md 檔 */
    _scanDir(baseDir, currentDir, results) {
        if (!fs.existsSync(currentDir)) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const full     = path.join(currentDir, entry.name);
            const relative = path.relative(baseDir, full);
            if (entry.isDirectory()) {
                this._scanDir(baseDir, full, results);
            } else if (entry.name.endsWith('.md')) {
                const stat = fs.statSync(full);
                results.push({ path: relative, size: stat.size, mtime: stat.mtimeMs });
            }
        }
    }

    /** 預設 index.md 內容 */
    _defaultIndex() {
        return `# Wiki 索引

_此 Wiki 由 Golem 自動維護，用於存儲結構化知識。_

## 目錄分類

- **user/** — 使用者偏好、習慣、目標
- **projects/** — 專案背景與上下文
- **decisions/** — 架構決策與技術選型記錄

> 使用 \`/wiki save <主題>\` 指令讓 Golem 將對話知識整合至此 Wiki。
`;
    }
}

module.exports = WikiManager;
