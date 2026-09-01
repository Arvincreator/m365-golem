const { CONFIG } = require('../src/config');
const { embeddings } = require('../packages/memory');

describe('EmbeddingFactory with Ollama provider', () => {
    const snapshot = {};

    beforeEach(() => {
        snapshot.EMBEDDING_PROVIDER = CONFIG.EMBEDDING_PROVIDER;
        snapshot.OLLAMA_EMBEDDING_MODEL = CONFIG.OLLAMA_EMBEDDING_MODEL;
    });

    afterEach(() => {
        CONFIG.EMBEDDING_PROVIDER = snapshot.EMBEDDING_PROVIDER;
        CONFIG.OLLAMA_EMBEDDING_MODEL = snapshot.OLLAMA_EMBEDDING_MODEL;
    });

    test('returns OllamaProvider when GOLEM_EMBEDDING_PROVIDER=ollama', () => {
        CONFIG.EMBEDDING_PROVIDER = 'ollama';
        CONFIG.OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';

        const provider = embeddings.EmbeddingFactory.create(null);

        expect(provider.constructor.name).toBe('OllamaProvider');
        expect(provider.modelName).toBe('nomic-embed-text');
    });
});
