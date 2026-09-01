/**
 * 🎨 Local Embedding Provider (免 API Key)
 * 使用 Transformers.js 在本地進行運算，具備極佳隱私性。
 */
const { Worker } = require('worker_threads');
const path = require('path');

class LocalProvider {
    constructor(modelName = 'Xenova/bge-small-zh-v1.5') {
        this.modelName = modelName;
        this.worker = null;
        this.msgId = 0;
        this.callbacks = new Map();
    }
    
    async _init() {
        if (this.worker) return;
        return new Promise((resolve, reject) => {
            console.log(`📥 [Memory:Embedding] 正在背景啟動本地模型 Worker: ${this.modelName}...`);
            this.worker = new Worker(path.join(__dirname, 'embeddingWorker.js'), {
                workerData: { modelName: this.modelName }
            });

            this.worker.on('message', (msg) => {
                if (this.callbacks.has(msg.id)) {
                    const { resolve, reject } = this.callbacks.get(msg.id);
                    this.callbacks.delete(msg.id);
                    if (msg.success) resolve(msg.data);
                    else reject(new Error(msg.error));
                }
            });

            this.worker.on('error', (err) => {
                console.error('❌ [Memory:Embedding] Worker error:', err);
                reject(err);
            });

            const id = ++this.msgId;
            this.callbacks.set(id, { resolve: () => resolve(), reject });
            this.worker.postMessage({ type: 'init', id });
        });
    }
    
    async getEmbedding(text) {
        await this._init();
        return new Promise((resolve, reject) => {
            const id = ++this.msgId;
            this.callbacks.set(id, { resolve, reject });
            this.worker.postMessage({ type: 'embed', id, text });
        });
    }
    
    getIdentifier() { 
        return `local_${this.modelName.replace(/[^a-z0-9]/gi, '_')}`; 
    }
}

module.exports = LocalProvider;
