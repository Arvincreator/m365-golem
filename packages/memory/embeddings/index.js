const LocalProvider = require('./LocalProvider');
const GeminiProvider = require('./GeminiProvider');
const OllamaProvider = require('./OllamaProvider');
const { CONFIG } = require('../../../src/config');

/**
 * 🧠 Embedding Provider Factory
 * 負責根據配置建立正確的 Provider 實例
 */
class EmbeddingFactory {
    static create(keyChain) {
        const providerType = CONFIG.EMBEDDING_PROVIDER || 'local';
        
        if (providerType === 'local') {
            return new LocalProvider(CONFIG.LOCAL_EMBEDDING_MODEL);
        } else if (providerType === 'gemini') {
            return new GeminiProvider(keyChain);
        } else if (providerType === 'ollama') {
            return new OllamaProvider(CONFIG.OLLAMA_EMBEDDING_MODEL);
        } else {
            console.warn(`⚠️ [Embedding] 未知的 Provider 類型: ${providerType}，將退回本地模式。`);
            return new LocalProvider();
        }
    }
}

module.exports = {
    EmbeddingFactory,
    LocalProvider,
    GeminiProvider,
    OllamaProvider
};
