const crypto = require('crypto');

class ActionQueue {
    constructor(options = {}) {
        this.golemId = options.golemId || 'default';
        this.queue = [];
        this.isProcessing = false;
        this.activeTask = null;
        this.PROCESS_DELAY = Number.isFinite(Number(options.processDelayMs))
            ? Math.max(0, Number(options.processDelayMs))
            : 200;
    }

    /**
     * 加入新任務到行動產線 (Action Queue)
     * @param {Object} ctx - 上下文物件
     * @param {Function} taskFn - 回傳 Promise 的執行函式 (例如 child_process.exec)
     * @param {Object} options - 選項, priority 等
     */
    async enqueue(ctx, taskFn, options = { isPriority: false }) {
        console.log(`📥 [Action Queue:${this.golemId}] 收到新行動任務、加入隊列 (Priority: ${options.isPriority})`);

        const taskItem = {
            id: String(options.id || crypto.randomUUID()),
            ctx,
            taskFn,
            timestamp: Date.now(),
            isPriority: options.isPriority === true,
            metadata: options.metadata && typeof options.metadata === 'object'
                ? { ...options.metadata }
                : {},
        };

        if (options.isPriority) {
            this.queue.unshift(taskItem);
        } else {
            this.queue.push(taskItem);
        }

        this._processQueue();
        return taskItem.id;
    }

    getSnapshot(filter = {}) {
        const conversationId = String(filter.conversationId || '').trim();
        const matches = (task) => !conversationId
            || String(task && task.metadata && task.metadata.conversationId || '') === conversationId;
        const view = (task, status, position) => ({
            id: task.id,
            status,
            position,
            requestedAt: task.timestamp,
            title: String(task.metadata.title || '工具動作'),
            summary: String(task.metadata.summary || ''),
            actionCount: Math.max(1, Number(task.metadata.actionCount || 1)),
            conversationId: String(task.metadata.conversationId || ''),
        });

        const items = [];
        if (this.activeTask && matches(this.activeTask)) {
            items.push(view(this.activeTask, 'running', 0));
        }
        this.queue.forEach((task, index) => {
            if (matches(task)) items.push(view(task, 'queued', index + 1));
        });
        return items;
    }

    /**
     * 內部佇列處理器 (Sequential Execution)
     */
    async _processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;
        const task = this.queue.shift();
        this.activeTask = task;

        try {
            console.log(`⚙️ [Action Queue:${this.golemId}] 從隊列取出，開始非同步執行行動任務...`);

            // 如果上層有指定發送 Typing 可以先發
            if (task.ctx && typeof task.ctx.sendTyping === 'function') {
                task.ctx.sendTyping().catch(() => { });
            }

            // 執行被封裝的物理操作
            await task.taskFn();

            console.log(`✅ [Action Queue:${this.golemId}] 行動任務非同步執行完畢。`);
        } catch (error) {
            console.error(`❌ [Action Queue:${this.golemId}] 行動任務執行失敗:`, error);
            if (task.ctx && typeof task.ctx.reply === 'function') {
                task.ctx.reply(`❌ **系統層任務執行崩潰:**\n\`\`\`\n${error.message}\n\`\`\``, { parse_mode: 'Markdown' }).catch(() => { });
            }
        } finally {
            this.activeTask = null;
            this.isProcessing = false;

            // 稍作延遲再提取下一個任務，避免過度頻繁刷新
            setTimeout(() => this._processQueue(), this.PROCESS_DELAY);
        }
    }
}

module.exports = ActionQueue;
