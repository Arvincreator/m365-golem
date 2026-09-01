const { CONFIG } = require('../config');

function parseNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) return 0;
    const len = Math.min(vecA.length, vecB.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < len; i += 1) {
        const a = Number(vecA[i]) || 0;
        const b = Number(vecB[i]) || 0;
        dot += a * b;
        normA += a * a;
        normB += b * b;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

class OllamaClient {
    constructor(options = {}) {
        this.baseUrl = String(options.baseUrl || CONFIG.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
        this.timeoutMs = parseNumber(options.timeoutMs || CONFIG.OLLAMA_TIMEOUT_MS, 60000);
    }

    async chat(prompt, options = {}) {
        const model = options.model || CONFIG.OLLAMA_BRAIN_MODEL;
        if (!model) throw new Error('Ollama brain model is not configured.');

        const messages = [];
        if (options.system) {
            messages.push({ role: 'system', content: String(options.system) });
        }
        messages.push({ role: 'user', content: String(prompt || '') });

        const data = await this._request('/api/chat', {
            model,
            stream: false,
            messages
        });

        const content = data?.message?.content || data?.response || '';
        if (!content) throw new Error('Ollama returned an empty chat response.');
        return content;
    }

    async embed(text, options = {}) {
        const vectors = await this.embedMany([text], options);
        if (!vectors[0]) throw new Error('Ollama embedding response is empty.');
        return vectors[0];
    }

    async embedMany(inputs, options = {}) {
        const model = options.model || CONFIG.OLLAMA_EMBEDDING_MODEL;
        if (!model) throw new Error('Ollama embedding model is not configured.');

        const normalizedInputs = (Array.isArray(inputs) ? inputs : [inputs]).map(item => String(item || ''));
        if (normalizedInputs.length === 0) return [];

        try {
            const payload = {
                model,
                input: normalizedInputs.length === 1 ? normalizedInputs[0] : normalizedInputs
            };
            const data = await this._request('/api/embed', payload);
            if (Array.isArray(data?.embeddings)) {
                return data.embeddings.map(vector => Array.from(vector || []));
            }
            if (Array.isArray(data?.embedding)) {
                return [Array.from(data.embedding)];
            }
        } catch (e) {
            if (!String(e.message || '').includes('/api/embed')) {
                throw e;
            }
        }

        // 兼容舊版 Ollama API (/api/embeddings)
        const fallbackResults = [];
        for (const input of normalizedInputs) {
            const data = await this._request('/api/embeddings', { model, prompt: input });
            if (!Array.isArray(data?.embedding)) {
                throw new Error('Ollama /api/embeddings returned invalid payload.');
            }
            fallbackResults.push(Array.from(data.embedding));
        }
        return fallbackResults;
    }

    async rerank(query, documents, options = {}) {
        const model = options.model || CONFIG.OLLAMA_RERANK_MODEL;
        if (!model) return null;
        if (!Array.isArray(documents) || documents.length === 0) return [];

        try {
            const data = await this._request('/api/rerank', {
                model,
                query: String(query || ''),
                documents,
                top_n: documents.length
            });

            if (Array.isArray(data?.results)) {
                const ranked = data.results
                    .map(item => ({
                        index: Number(item?.index),
                        score: Number(item?.relevance_score ?? item?.score ?? 0)
                    }))
                    .filter(item => Number.isInteger(item.index) && item.index >= 0 && item.index < documents.length);
                if (ranked.length > 0) {
                    ranked.sort((a, b) => b.score - a.score);
                    return ranked;
                }
            }
        } catch (e) {
            console.warn(`⚠️ [Ollama] /api/rerank unavailable, fallback to embedding cosine rerank: ${e.message}`);
        }

        const embeddingModel = options.embeddingFallbackModel || CONFIG.OLLAMA_EMBEDDING_MODEL;
        if (!embeddingModel) return null;

        const [queryEmbedding, docEmbeddings] = await Promise.all([
            this.embed(String(query || ''), { model: embeddingModel }),
            this.embedMany(documents, { model: embeddingModel })
        ]);

        return docEmbeddings
            .map((embedding, index) => ({
                index,
                score: cosineSimilarity(queryEmbedding, embedding)
            }))
            .sort((a, b) => b.score - a.score);
    }

    async _request(endpoint, payload) {
        const url = `${this.baseUrl}${endpoint}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            const bodyText = await response.text();
            let data = {};
            if (bodyText) {
                try {
                    data = JSON.parse(bodyText);
                } catch (e) {
                    throw new Error(`Invalid JSON response from ${endpoint}: ${bodyText.slice(0, 200)}`);
                }
            }

            if (!response.ok) {
                const message = data?.error || data?.message || response.statusText;
                throw new Error(`[Ollama:${endpoint}] ${response.status} ${message}`);
            }

            return data;
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error(`[Ollama:${endpoint}] request timeout after ${this.timeoutMs}ms`);
            }
            if (e instanceof Error) throw e;
            throw new Error(String(e));
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

module.exports = OllamaClient;
