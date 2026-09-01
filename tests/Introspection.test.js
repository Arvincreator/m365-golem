const fs = require('fs');

// Mock fs.promises BEFORE requiring Introspection
jest.mock('fs', () => ({
    promises: {
        readFile: jest.fn(),
        readdir: jest.fn()
    },
    readFileSync: jest.fn(),
    existsSync: jest.fn()
}));

const Introspection = require('../src/services/Introspection');

describe('Introspection', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('readCore should redact sensitive keys', async () => {
        require('fs').promises.readFile.mockResolvedValue('const KEY = "secret-123";\nconst OTHER = "val";');
        
        const content = await Introspection.readCore();
        expect(content).toContain('KEY: "[REDACTED]"');
    });

    test('readCore should redact TOKEN values', async () => {
        require('fs').promises.readFile.mockResolvedValue('const TOKEN = "my-secret-token";');
        const content = await Introspection.readCore();
        expect(content).toContain('[REDACTED]');
    });

    test('readCore should handle file-not-found gracefully', async () => {
        require('fs').promises.readFile.mockRejectedValue(new Error('File not found'));
        const content = await Introspection.readCore();
        // Should return the partial combined source (empty in this case)
        expect(typeof content).toBe('string');
    });

    test('readCore returns error string on outer error', async () => {
        // Simulate a crash during iteration
        require('fs').promises.readFile.mockRejectedValue(new Error('ENOENT'));
        const result = await Introspection.readCore();
        expect(typeof result).toBe('string');
    });

    test('readFile should block path traversal with ..', async () => {
        await expect(Introspection.readFile('../etc/passwd')).rejects.toThrow('Access Denied');
    });

    test('readFile should block absolute paths', async () => {
        await expect(Introspection.readFile('/etc/passwd')).rejects.toThrow('Access Denied');
    });

    test('readFile should block files in ignore list', async () => {
        await expect(Introspection.readFile('node_modules/something.js')).rejects.toThrow('Access Denied');
    });

    test('readFile should read a valid file', async () => {
        require('fs').promises.readFile.mockResolvedValue('file content here');
        const result = await Introspection.readFile('src/core/Executor.js');
        expect(result).toBe('file content here');
    });

    test('readFile throws on file not found', async () => {
        require('fs').promises.readFile.mockRejectedValue(new Error('ENOENT'));
        await expect(Introspection.readFile('src/nonexistent.js')).rejects.toThrow('File not found');
    });

    test('getStructure should return file structure', async () => {
        require('fs').promises.readdir.mockResolvedValue([
            { name: 'index.js', isDirectory: () => false },
            { name: 'node_modules', isDirectory: () => true }  // should be ignored
        ]);
        const structure = await Introspection.getStructure('/tmp', 1);
        expect(structure['index.js']).toBe('file');
        expect(structure['node_modules']).toBeUndefined(); // excluded by ignoreList
    });

    test('getStructure handles readdir error', async () => {
        require('fs').promises.readdir.mockRejectedValue(new Error('Permission denied'));
        const structure = await Introspection.getStructure('/tmp', 1);
        expect(structure.error).toBe('Permission denied');
    });

    test('getStructure stops recursion at depth 0', async () => {
        const structure = await Introspection.getStructure('/tmp', -1);
        expect(structure).toEqual({ type: '...' });
    });

    test('readSelf should read NodeRouter.js', async () => {
        require('fs').promises.readFile.mockResolvedValue('router code');
        const result = await Introspection.readSelf();
        expect(result).toBe('router code');
    });

    test('readSelf returns empty string if NodeRouter not found', async () => {
        require('fs').promises.readFile.mockRejectedValue(new Error('ENOENT'));
        const result = await Introspection.readSelf();
        expect(result).toBe('');
    });
});
