const { CONFIG } = require('../../../src/config');
const OllamaClient = require('../../../src/services/OllamaClient');

class OllamaProvider {
    constructor(modelName = CONFIG.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text', options = {}) {
        this.modelName = modelName;
        this.client = options.client || new OllamaClient({
            baseUrl: options.baseUrl || CONFIG.OLLAMA_BASE_URL,
            timeoutMs: options.timeoutMs || CONFIG.OLLAMA_TIMEOUT_MS
        });
    }

    async getEmbedding(text) {
        return this.client.embed(text, { model: this.modelName });
    }

    getIdentifier() {
        return `ollama_${String(this.modelName).replace(/[^a-z0-9]/gi, '_')}`;
    }
}

module.exports = OllamaProvider;
