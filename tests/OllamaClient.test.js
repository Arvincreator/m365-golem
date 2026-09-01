const OllamaClient = require('../src/services/OllamaClient');

function mockJsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status >= 200 && status < 300 ? 'OK' : 'ERROR',
        text: async () => JSON.stringify(payload),
    };
}

describe('OllamaClient', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
        jest.clearAllMocks();
    });

    test('chat() posts to /api/chat and returns content', async () => {
        global.fetch.mockResolvedValueOnce(
            mockJsonResponse(200, { message: { content: 'hello from ollama' } })
        );

        const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', timeoutMs: 5000 });
        const output = await client.chat('ping', { model: 'llama3.1:8b' });

        expect(output).toBe('hello from ollama');
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:11434/api/chat');
        expect(options.method).toBe('POST');
        expect(JSON.parse(options.body)).toMatchObject({
            model: 'llama3.1:8b',
            stream: false
        });
    });

    test('embedMany() reads vectors from /api/embed', async () => {
        global.fetch.mockResolvedValueOnce(
            mockJsonResponse(200, { embeddings: [[0.1, 0.2, 0.3], [0.3, 0.2, 0.1]] })
        );

        const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', timeoutMs: 5000 });
        const vectors = await client.embedMany(['a', 'b'], { model: 'nomic-embed-text' });

        expect(vectors).toHaveLength(2);
        expect(vectors[0]).toEqual([0.1, 0.2, 0.3]);
        expect(vectors[1]).toEqual([0.3, 0.2, 0.1]);
        expect(global.fetch).toHaveBeenCalledWith(
            'http://127.0.0.1:11434/api/embed',
            expect.any(Object)
        );
    });

    test('rerank() falls back to embedding cosine when /api/rerank is unavailable', async () => {
        global.fetch
            .mockResolvedValueOnce(mockJsonResponse(404, { error: 'endpoint not found' })) // /api/rerank
            .mockResolvedValueOnce(mockJsonResponse(200, { embeddings: [[1, 0]] })) // query embedding
            .mockResolvedValueOnce(mockJsonResponse(200, { embeddings: [[0.2, 0.8], [0.9, 0.1]] })); // doc embeddings

        const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', timeoutMs: 5000 });
        const ranked = await client.rerank('query', ['doc-0', 'doc-1'], {
            model: 'bge-reranker-v2-m3',
            embeddingFallbackModel: 'nomic-embed-text'
        });

        expect(Array.isArray(ranked)).toBe(true);
        expect(ranked[0].index).toBe(1);
        expect(ranked[1].index).toBe(0);
    });
});
