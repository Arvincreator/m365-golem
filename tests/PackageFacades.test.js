const security = require('../packages/security');
const memory = require('../packages/memory');
const protocol = require('../packages/protocol');

describe('Package Facades', () => {
    test('security facade exports expected modules', () => {
        expect(typeof security.SecurityManager).toBe('function');
        expect(typeof security.CommandSafeguard.validate).toBe('function');
    });

    test('memory facade exports expected modules', () => {
        expect(typeof memory.LanceDBProDriver).toBe('function');
        expect(typeof memory.SystemNativeDriver).toBe('function');
        expect(typeof memory.ExperienceMemory).toBe('function');
        expect(memory.embeddings).toBeDefined();
        expect(typeof memory.embeddings.EmbeddingFactory.create).toBe('function');
        expect(typeof memory.embeddings.LocalProvider).toBe('function');
        expect(typeof memory.embeddings.GeminiProvider).toBe('function');
        expect(typeof memory.embeddings.OllamaProvider).toBe('function');
    });

    test('protocol facade exports expected modules', () => {
        expect(typeof protocol.ProtocolFormatter.buildEnvelope).toBe('function');
        expect(typeof protocol.ResponseExtractor.cleanResponse).toBe('function');
        expect(typeof protocol.NeuroShunter.dispatch).toBe('function');
    });
});
