/**
 * 🛡️ ConsoleInterceptor - 集中處理控制台攔截邏輯
 * 支援結構化日誌 (timestamp + level) 與 JSON 輸出模式
 */
class ConsoleInterceptor {
    constructor() {
        // 1. 保存原始的 Console 方法 (備份以利後續還原)
        this.originalLog = console.log;
        this.originalWarn = console.warn;
        this.originalError = console.error;
        this.onLog = null;
        this.onError = null;
        this.jsonMode = process.env.LOG_FORMAT === 'json';
    }

    /**
     * 取得 ISO timestamp
     */
    _timestamp() {
        return new Date().toISOString();
    }

    /**
     * 格式化日誌輸出
     */
    _format(level, args) {
        if (this.jsonMode) {
            return JSON.stringify({
                time: this._timestamp(),
                level,
                msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
            });
        }
        // In human mode, we only return the level tag. 
        // The timestamp is added by SystemLogger to avoid duplicates in the CLI.
        return `[${level}]`;
    }

    /**
     * 啟動攔截器
     * @param {Object} callbacks - 包含 onLog 與 onError 的回呼函式
     */
    hijack(callbacks = {}) {
        this.onLog = callbacks.onLog;
        this.onError = callbacks.onError;

        console.log = (...args) => {
            try {
                if (this.jsonMode) {
                    this.originalLog.call(console, this._format('INFO', args));
                } else {
                    this.originalLog.call(console, this._format('INFO', args), ...args);
                }
                if (this.onLog) this.onLog(args);
            } catch (e) {
                if (this.originalError) this.originalError('❌ [Interceptor Log Error]', e);
            }
        };

        console.warn = (...args) => {
            try {
                if (this.jsonMode) {
                    this.originalWarn.call(console, this._format('WARN', args));
                } else {
                    this.originalWarn.call(console, this._format('WARN', args), ...args);
                }
                if (this.onLog) this.onLog(args);
            } catch (e) {
                if (this.originalError) this.originalError('❌ [Interceptor Warn Error]', e);
            }
        };

        console.error = (...args) => {
            try {
                if (this.jsonMode) {
                    this.originalError.call(console, this._format('ERROR', args));
                } else {
                    this.originalError.call(console, this._format('ERROR', args), ...args);
                }
                if (this.onError) this.onError(args);
            } catch (e) {
                // 如果攔截器本身出錯，絕不拋出，防止遞迴
                if (this.originalError) this.originalError('❌ [Interceptor Error]', e);
            }
        };
    }

    /**
     * 還原原始的 Console 方法 (退出系統時調用)
     */
    restore() {
        console.log = this.originalLog;
        console.warn = this.originalWarn;
        console.error = this.originalError;
    }
}

module.exports = new ConsoleInterceptor();
