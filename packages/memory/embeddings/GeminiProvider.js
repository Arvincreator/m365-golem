const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * ☁️ Gemini Embedding Provider (需 API Key)
 * 使用 Google Cloud API 進行運算，具備極高精確度。
 */
class GeminiProvider {
    constructor(keyChain, modelName = 'text-embedding-004') {
        this.keyChain = keyChain;
        this.modelName = modelName;
    }
    
    async getEmbedding(text) {
        const apiKey = await this.keyChain.getKey();
        if (!apiKey) throw new Error("No API key available for Gemini embedding");
        
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: this.modelName });
        const result = await model.embedContent(text);
        return Array.from(result.embedding.values);
    }
    
    getIdentifier() { 
        return `gemini_${this.modelName.replace(/[^a-z0-9]/gi, '_')}`; 
    }
}

module.exports = GeminiProvider;
