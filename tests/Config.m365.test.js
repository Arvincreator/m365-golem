jest.mock('../src/utils/EnvManager', () => ({
    readEnv: jest.fn(() => ({})),
}));

const EnvManager = require('../src/utils/EnvManager');
const ConfigManager = require('../src/config');

describe('Config reload for M365 Web POC', () => {
    const trackedKeys = [
        'GOLEM_BACKEND',
        'M365_COPILOT_URLS',
        'M365_POC_SAFE_MODE',
        'M365_LOCAL_MEMORY_ENABLED',
        'M365_ACTIONS_ENABLED',
        'M365_AUTO_BOOT_PROMPT',
        'GOLEM_AUTONOMY_ENABLED',
        'GOLEM_REFLECTION_ENABLED',
    ];
    const envBackup = {};
    const configBackup = {};

    beforeEach(() => {
        for (const key of trackedKeys) {
            envBackup[key] = process.env[key];
            delete process.env[key];
        }
        for (const key of [
            'GOLEM_BACKEND',
            'M365_COPILOT_URLS',
            'M365_POC_SAFE_MODE',
            'M365_LOCAL_MEMORY_ENABLED',
            'M365_ACTIONS_ENABLED',
            'M365_AUTO_BOOT_PROMPT',
            'AUTONOMY_ENABLED',
            'REFLECTION_ENABLED',
        ]) {
            configBackup[key] = Array.isArray(ConfigManager.CONFIG[key])
                ? [...ConfigManager.CONFIG[key]]
                : ConfigManager.CONFIG[key];
        }
    });

    afterEach(() => {
        for (const key of trackedKeys) {
            if (envBackup[key] === undefined) delete process.env[key];
            else process.env[key] = envBackup[key];
        }
        Object.assign(ConfigManager.CONFIG, configBackup);
    });

    test('safe mode disables autonomous turns and local context by default', () => {
        EnvManager.readEnv.mockReturnValue({
            GOLEM_BACKEND: 'm365-web',
            M365_COPILOT_URLS: 'https://m365.cloud.microsoft/chat',
        });

        ConfigManager.reloadConfig();

        expect(ConfigManager.CONFIG.GOLEM_BACKEND).toBe('m365-web');
        expect(ConfigManager.CONFIG.M365_COPILOT_URLS).toEqual(['https://m365.cloud.microsoft/chat']);
        expect(ConfigManager.CONFIG.M365_POC_SAFE_MODE).toBe(true);
        expect(ConfigManager.CONFIG.M365_LOCAL_MEMORY_ENABLED).toBe(false);
        expect(ConfigManager.CONFIG.M365_ACTIONS_ENABLED).toBe(false);
        expect(ConfigManager.CONFIG.M365_AUTO_BOOT_PROMPT).toBe(false);
        expect(ConfigManager.CONFIG.AUTONOMY_ENABLED).toBe(false);
        expect(ConfigManager.CONFIG.REFLECTION_ENABLED).toBe(false);
    });

    test('normalizes copilot alias to m365-web', () => {
        expect(ConfigManager.normalizeBackend('copilot')).toBe('m365-web');
        expect(ConfigManager.normalizeBackend('m365')).toBe('m365-web');
    });
});

