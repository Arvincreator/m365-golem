'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    ensureM365WorkspaceEnv,
    isValidEncryptionKey,
    parseEnv,
} = require('../scripts/ensure-m365-workspace-env');

describe('M365 workspace environment setup', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-m365-env-'));
        fs.writeFileSync(path.join(tempDir, 'M365-POC.env.example'), [
            'GOLEM_BACKEND=m365-web',
            'M365_WORKSPACE_ENABLED=true',
            'M365_RUNNER_ENABLED=true',
            'M365_WORKSPACE_DB_PATH=data/m365-workspace.sqlite',
            'M365_DATA_ENCRYPTION_KEY=',
            '',
        ].join('\n'), 'utf8');
    });

    afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    test('creates and preserves one private key without returning it', () => {
        const first = ensureM365WorkspaceEnv({ rootDir: tempDir });
        const firstValues = parseEnv(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'));
        expect(first).toEqual(expect.objectContaining({
            workspaceEnabled: true,
            runnerEnabled: true,
            encryptionConfigured: true,
        }));
        expect(first).not.toHaveProperty('encryptionKey');
        expect(isValidEncryptionKey(firstValues.M365_DATA_ENCRYPTION_KEY)).toBe(true);

        ensureM365WorkspaceEnv({ rootDir: tempDir });
        const secondValues = parseEnv(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'));
        expect(secondValues.M365_DATA_ENCRYPTION_KEY).toBe(firstValues.M365_DATA_ENCRYPTION_KEY);
    });

    test('refuses to replace a missing key when an existing database is present', () => {
        fs.mkdirSync(path.join(tempDir, 'data'));
        fs.writeFileSync(path.join(tempDir, 'data', 'm365-workspace.sqlite'), 'existing', 'utf8');
        expect(() => ensureM365WorkspaceEnv({ rootDir: tempDir })).toThrow(
            'M365_ENCRYPTION_KEY_MISSING_FOR_EXISTING_DATABASE'
        );
    });

    test('rejects a non-M365 profile and an invalid configured key', () => {
        fs.writeFileSync(path.join(tempDir, '.env'), 'GOLEM_BACKEND=gemini\n', 'utf8');
        expect(() => ensureM365WorkspaceEnv({ rootDir: tempDir })).toThrow('M365_BACKEND_REQUIRED');

        fs.writeFileSync(path.join(tempDir, '.env'), [
            'GOLEM_BACKEND=m365-web',
            'M365_DATA_ENCRYPTION_KEY=not-a-valid-key',
            '',
        ].join('\n'), 'utf8');
        expect(() => ensureM365WorkspaceEnv({ rootDir: tempDir })).toThrow('M365_ENCRYPTION_KEY_INVALID');
    });
});
