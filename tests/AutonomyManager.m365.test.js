jest.mock('../packages/protocol', () => ({
    NeuroShunter: { dispatch: jest.fn() },
}));

const AutonomyManager = require('../src/managers/AutonomyManager');
const ConfigManager = require('../src/config');

describe('AutonomyManager M365 safe mode', () => {
    const originalConfig = {};

    beforeEach(() => {
        for (const key of ['TG_TOKEN', 'DC_TOKEN', 'AUTONOMY_ENABLED', 'REFLECTION_ENABLED']) {
            originalConfig[key] = ConfigManager.CONFIG[key];
        }
        Object.assign(ConfigManager.CONFIG, {
            TG_TOKEN: 'configured-token-for-test',
            DC_TOKEN: '',
            AUTONOMY_ENABLED: false,
            REFLECTION_ENABLED: false,
        });
    });

    afterEach(() => {
        Object.assign(ConfigManager.CONFIG, originalConfig);
        jest.restoreAllMocks();
    });

    test('starts no background timers and refuses reflection', async () => {
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            sendMessage: jest.fn(),
        };
        const manager = new AutonomyManager(brain, {}, {});
        const intervalSpy = jest.spyOn(global, 'setInterval');
        const timeoutSpy = jest.spyOn(global, 'setTimeout');

        manager.start();

        expect(intervalSpy).not.toHaveBeenCalled();
        expect(timeoutSpy).not.toHaveBeenCalled();
        await expect(manager.performSelfReflection({ reply: jest.fn() })).resolves.toBe(false);
        expect(brain.sendMessage).not.toHaveBeenCalled();
    });
});
