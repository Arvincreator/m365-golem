// ============================================================
// ⚡ HookSystem — Pre/Post Tool-Use Lifecycle Hooks
// Inspired by OpenHarness PreToolUse/PostToolUse architecture
// ============================================================

/**
 * 輕量 Hook 事件系統，不依賴外部套件。
 *
 * 支援事件：
 *   pre_tool_use   — 工具/技能執行前觸發
 *   post_tool_use  — 工具/技能執行後觸發
 *
 * ctx 物件結構：
 *   {
 *     type: 'skill' | 'mcp' | 'browser',  // 工具類型
 *     name: string,                         // 工具/技能名稱
 *     trigger: string,                      // 觸發原因（使用者指令文字）
 *     silent: boolean,                      // 設為 true 可靜音此次 log
 *     [key]: any                            // 額外 metadata
 *   }
 */
class HookSystem {
    constructor() {
        /** @type {Map<string, Function[]>} */
        this._handlers = new Map();
    }

    /**
     * 註冊 Hook Handler
     * @param {string} event - 事件名稱 ('pre_tool_use' | 'post_tool_use')
     * @param {Function} handler - async (ctx, result?) => void
     */
    on(event, handler) {
        if (typeof handler !== 'function') {
            throw new TypeError(`[HookSystem] Handler 必須是函數`);
        }
        if (!this._handlers.has(event)) {
            this._handlers.set(event, []);
        }
        this._handlers.get(event).push(handler);
        return this; // 支援鏈式呼叫
    }

    /**
     * 移除指定 Handler
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
        if (!this._handlers.has(event)) return this;
        const list = this._handlers.get(event).filter(h => h !== handler);
        this._handlers.set(event, list);
        return this;
    }

    /**
     * 觸發 Hook 事件，按順序執行所有 Handler（錯誤隔離，單一 handler 失敗不影響後續）
     * @param {string} event
     * @param {object} ctx  - 工具執行上下文
     * @param {*} [result]  - 僅 post_tool_use 使用
     */
    async emit(event, ctx, result) {
        const handlers = this._handlers.get(event);
        if (!handlers || handlers.length === 0) return;

        for (const handler of handlers) {
            try {
                await handler(ctx, result);
            } catch (e) {
                // 錯誤隔離：單一 hook 失敗不中斷流程
                console.warn(`⚠️ [HookSystem] ${event} handler 執行失敗: ${e.message}`);
            }
        }
    }

    /**
     * 清除特定事件的所有 Handler
     * @param {string} event
     */
    clear(event) {
        this._handlers.delete(event);
        return this;
    }

    /**
     * 取得目前已註冊的 Handler 數量（用於診斷）
     */
    stats() {
        const result = {};
        for (const [event, handlers] of this._handlers.entries()) {
            result[event] = handlers.length;
        }
        return result;
    }
}

// ── 全域單例 ──────────────────────────────────────────────────
// 整個 app 共用同一個 HookSystem 實體，
// 各模組可以 require 後直接 .on() 掛載 handler。
const hookSystem = new HookSystem();

// ── 內建 Default Hooks ────────────────────────────────────────

// Default pre_tool_use：技能執行前印出追蹤 log（可被靜音）
hookSystem.on('pre_tool_use', (ctx) => {
    if (ctx.silent) return;
    console.log(`⚡ [Hook:pre] ${ctx.type}::${ctx.name}${ctx.trigger ? ` — "${ctx.trigger.slice(0, 60)}"` : ''}`);
});

// Default post_tool_use：技能執行後印出耗時（可被靜音）
hookSystem.on('post_tool_use', (ctx, result) => {
    if (ctx.silent) return;
    const dur = ctx._startMs ? `${Date.now() - ctx._startMs}ms` : '?ms';
    const ok = result && result.error ? '❌' : '✅';
    console.log(`⚡ [Hook:post] ${ok} ${ctx.type}::${ctx.name} (${dur})`);
});

module.exports = { HookSystem, hookSystem };
