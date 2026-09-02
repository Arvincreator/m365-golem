'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const UserProfileManager = require('../src/managers/UserProfileManager');

describe('M365 structured user memory', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-user-memory-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('lets Copilot add and change whitelisted stable preferences', () => {
        const manager = new UserProfileManager(tempDir);
        const results = manager.applyM365MemoryBlock(JSON.stringify([
            { operation: 'add', path: 'identity.knownNames', value: 'Arvin' },
            { operation: 'set', path: 'communication.responseLength', value: 'brief' },
            { operation: 'add', path: 'preferences.dislikes', value: 'Unnecessary restatement' },
        ]));

        expect(results.every((result) => result.changed)).toBe(true);
        const prompt = manager.buildInjectionPrompt();
        expect(prompt).toContain('Arvin');
        expect(prompt).toContain('偏好精簡');
        expect(prompt).toContain('Unnecessary restatement');
        expect(fs.existsSync(path.join(tempDir, 'user_profile.json'))).toBe(true);
    });

    test('rejects unsupported fields and secret values', () => {
        const manager = new UserProfileManager(tempDir);
        expect(() => manager.applyM365MemoryOperations([
            { operation: 'set', path: 'identity.password', value: 'secret' },
        ])).toThrow(expect.objectContaining({ code: 'M365_USER_MEMORY_PATH_INVALID' }));
        expect(() => manager.applyM365MemoryOperations([
            { operation: 'add', path: 'preferences.topics', value: 'api_key=abcdefghijklmnop' },
        ])).toThrow(expect.objectContaining({ code: 'M365_USER_MEMORY_SENSITIVE' }));
    });

    test('does not retain a partial user-memory update when a later operation is invalid', () => {
        const manager = new UserProfileManager(tempDir);

        expect(() => manager.applyM365MemoryOperations([
            { operation: 'add', path: 'identity.knownNames', value: 'Arvin' },
            { operation: 'set', path: 'identity.password', value: 'not-allowed' },
        ])).toThrow(expect.objectContaining({ code: 'M365_USER_MEMORY_PATH_INVALID' }));

        expect(manager.getProfile().identity.knownNames).toEqual([]);
        expect(fs.existsSync(path.join(tempDir, 'user_profile.json'))).toBe(false);
    });
});
