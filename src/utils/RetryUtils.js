// ============================================================
// ⚡ RetryUtils — 統一 Jittered Exponential Backoff 重試工具
// 靈感來自 NousResearch/hermes-agent agent/retry_utils.py
// ============================================================

/**
 * 計算 Jittered Backoff 延遲時間（毫秒）
 * @param {number} attempt      - 當前重試次數（0-based）
 * @param {number} baseDelayMs  - 基礎延遲（ms），預設 1000
 * @param {number} maxDelayMs   - 最大延遲（ms），預設 30000
 * @param {number} jitterFactor - 抖動係數（0.0~1.0），預設 0.5
 * @returns {number} 延遲毫秒數
 */
function jitteredBackoff(attempt, baseDelayMs = 1000, maxDelayMs = 30000, jitterFactor = 0.5) {
    const expDelay = baseDelayMs * Math.pow(2, attempt);
    const jitter = (Math.random() * 2 - 1) * jitterFactor * expDelay; // ±jitterFactor
    return Math.min(Math.max(expDelay + jitter, baseDelayMs / 2), maxDelayMs);
}

/**
 * 帶重試的非同步函數執行器
 * @param {Function} fn                      - 要執行的非同步函數
 * @param {object}  [opts]
 * @param {number}  [opts.maxRetries=3]      - 最大重試次數
 * @param {number}  [opts.baseDelayMs=1000]  - 基礎延遲（ms）
 * @param {number}  [opts.maxDelayMs=30000]  - 最大延遲（ms）
 * @param {string}  [opts.label='']          - 日誌標籤
 * @param {Function}[opts.shouldRetry]       - 判斷是否應重試的回調 (error) => boolean
 * @returns {Promise<any>}
 */
async function withRetry(fn, opts = {}) {
    const {
        maxRetries = 3,
        baseDelayMs = 1000,
        maxDelayMs = 30000,
        label = '',
        shouldRetry = () => true,
    } = opts;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;

            const isLast = attempt === maxRetries;

            if (isLast || !shouldRetry(e)) {
                if (label) {
                    console.error(`❌ [RetryUtils]${label ? ` [${label}]` : ''} 已達最大重試次數 (${maxRetries})，放棄。最後錯誤: ${e.message}`);
                }
                throw e;
            }

            const delayMs = jitteredBackoff(attempt, baseDelayMs, maxDelayMs);
            console.warn(`⚠️ [RetryUtils]${label ? ` [${label}]` : ''} 第 ${attempt + 1} 次失敗 (${e.message})，${(delayMs / 1000).toFixed(1)}s 後重試...`);
            await _sleep(delayMs);
        }
    }

    throw lastError;
}

/**
 * 帶重試的 fetch / HTTP 請求封裝
 * @param {string} url
 * @param {object} [fetchOptions]
 * @param {object} [retryOpts]  - 同 withRetry opts
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, fetchOptions = {}, retryOpts = {}) {
    return withRetry(
        async () => {
            const res = await fetch(url, fetchOptions);
            if (!res.ok) {
                const err = new Error(`HTTP ${res.status}: ${res.statusText}`);
                err.statusCode = res.status;
                throw err;
            }
            return res;
        },
        {
            label: `fetch:${url.slice(0, 60)}`,
            // 429 / 5xx 才重試，4xx（除429）不重試
            shouldRetry: (e) => {
                const code = e.statusCode;
                if (!code) return true; // 網路錯誤 → 重試
                return code === 429 || (code >= 500 && code < 600);
            },
            ...retryOpts,
        }
    );
}

// ── Private ───────────────────────────────────────────────────
function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { jitteredBackoff, withRetry, fetchWithRetry };
