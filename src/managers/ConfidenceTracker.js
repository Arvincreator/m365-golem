class ConfidenceTracker {
    constructor(chatLogManager) {
        this.chatLogManager = chatLogManager;
        this._isInitialized = false;
    }

    async _ensureInit() {
        if (this._isInitialized) return true;
        if (!this.chatLogManager || !this.chatLogManager.db) {
            return false;
        }

        try {
            await this.chatLogManager.runAsync(`
                CREATE TABLE IF NOT EXISTS metacognition (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp INTEGER,
                    query TEXT,
                    response TEXT,
                    score REAL,
                    label TEXT,
                    flags TEXT,
                    extractor_status TEXT
                );
            `);
            this._isInitialized = true;
            console.log("🌟 [Metacognition] AUQ 信心追蹤系統已掛載運行");
            return true;
        } catch (e) {
            console.error("❌ [Metacognition] 初始化 metacognition 資料表失敗:", e.message);
            return false;
        }
    }

    /**
     * 評估單次回應的信心分數 (AUQ)
     * @param {string} responseText - AI 回應文字
     * @param {string} extractorStatus - ResponseExtractor 的提取狀態
     * @param {string} userQuery - 用戶原本的問題
     * @returns {Object} 評估結果 { score, label, flags }
     */
    evaluate(responseText, extractorStatus, userQuery = "") {
        let score = 1.0;
        const flags = [];

        // 1. 狀態評估 (30%)
        let statusScore = 1.0;
        if (extractorStatus === 'TRUNCATED') {
            statusScore = 0.5;
            flags.push('TRUNCATED_RESPONSE');
        } else if (extractorStatus === 'FALLBACK_DIFF') {
            statusScore = 0.3;
            flags.push('PARTIAL_OR_UNSTABLE');
        } else if (extractorStatus === 'TIMEOUT') {
            statusScore = 0.0;
            flags.push('TIMEOUT');
        }
        score -= (1.0 - statusScore) * 0.3;

        // 2. 模糊語言與拒絕詞偵測 (50%)
        const vagueWords = ['也許', '可能', '我不確定', '不太清楚', '應該是', '大概', '似乎', '某種程度上'];
        const rejectionWords = ['我無法', '我不能', '抱歉，我不', '我沒有權限', '對不起，我'];
        
        let vagueCount = 0;
        for (const word of vagueWords) {
            if (responseText.includes(word)) vagueCount++;
        }
        if (vagueCount > 0) {
            score -= Math.min(vagueCount * 0.15, 0.3); // 最多扣 30%
            flags.push(`VAGUE_LANGUAGE(${vagueCount})`);
        }

        let isRejected = false;
        for (const word of rejectionWords) {
            if (responseText.includes(word)) isRejected = true;
        }
        if (isRejected) {
            score -= 0.5; // 拒絕回答直接扣 50%
            flags.push('REJECTION_DETECTED');
        }

        // 3. 內容長度合理性 (20%)
        const textLen = responseText.length;
        if (textLen < 20 && !isRejected) {
            score -= 0.2; // 太短可能代表缺乏自信或不完整
            flags.push('TOO_SHORT');
        } else if (textLen > 500) {
            score = Math.min(1.0, score + 0.1); // 詳盡回答可加權回補
            flags.push('DETAILED');
        }

        // 確保在 0.0 ~ 1.0 之間
        score = Math.max(0.0, Math.min(1.0, score));

        // 決定標籤
        let label = "高信心";
        if (score < 0.4) label = "不確定";
        else if (score < 0.6) label = "低信心";
        else if (score < 0.8) label = "中等信心";

        const result = {
            score: Number(score.toFixed(2)),
            label,
            flags: flags.join(',')
        };

        const emoji = label === "高信心" ? "✅" : (label === "中等信心" ? "🟡" : (label === "低信心" ? "🔶" : "❓"));
        console.log(`🧠 [Metacognition] 回應自我評估: ${emoji} ${result.label} (${(result.score * 100).toFixed(0)}%) | 觸發指標: [${result.flags || '無'}]`);

        return result;
    }

    /**
     * 將評估結果寫入歷史紀錄
     */
    async record(evaluation) {
        if (!(await this._ensureInit())) return;

        try {
            await this.chatLogManager.runAsync(
                `INSERT INTO metacognition (timestamp, query, response, score, label, flags, extractor_status)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    Date.now(),
                    evaluation.query || "",
                    evaluation.response || "",
                    evaluation.score,
                    evaluation.label,
                    evaluation.flags || "",
                    evaluation.extractor_status || "UNKNOWN"
                ]
            );
        } catch (e) {
            console.error("❌ [ConfidenceTracker] 寫入紀錄失敗:", e.message);
        }
    }

    /**
     * 讀取最近的歷史紀錄
     */
    async getHistory(limit = 20) {
        if (!(await this._ensureInit())) return [];
        try {
            return await this.chatLogManager.allAsync(
                `SELECT * FROM metacognition ORDER BY timestamp DESC LIMIT ?`, 
                [limit]
            );
        } catch (e) {
            console.error("❌ [ConfidenceTracker] 讀取歷史失敗:", e.message);
            return [];
        }
    }

    /**
     * 取出簡單統計資料供 Dashboard 使用
     */
    async getStats() {
        if (!(await this._ensureInit())) return null;
        try {
            const rows = await this.chatLogManager.allAsync(
                `SELECT score, label FROM metacognition ORDER BY timestamp DESC LIMIT 100`
            );
            
            if (rows.length === 0) return { avgScore: 0, count: 0, distribution: {} };

            let total = 0;
            const dist = { "高信心": 0, "中等信心": 0, "低信心": 0, "不確定": 0 };

            for (const r of rows) {
                total += r.score;
                if (dist[r.label] !== undefined) {
                    dist[r.label]++;
                }
            }

            return {
                avgScore: Number((total / rows.length).toFixed(2)),
                count: rows.length,
                distribution: dist
            };
        } catch (e) {
            console.error("❌ [ConfidenceTracker] 讀取統計失敗:", e.message);
            return null;
        }
    }
}

module.exports = ConfidenceTracker;
