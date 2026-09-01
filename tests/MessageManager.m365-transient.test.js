jest.mock('../dashboard', () => ({
    webServer: {
        broadcastLog: jest.fn(),
    },
}));

const dashboard = require('../dashboard');
const ConfigManager = require('../src/config');
const MessageManager = require('../src/core/MessageManager');

describe('MessageManager M365 dashboard privacy', () => {
    const originalBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
    const originalSafeMode = ConfigManager.CONFIG.M365_POC_SAFE_MODE;

    beforeEach(() => {
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        ConfigManager.CONFIG.M365_POC_SAFE_MODE = true;
        dashboard.webServer.broadcastLog.mockClear();
    });

    afterAll(() => {
        ConfigManager.CONFIG.GOLEM_BACKEND = originalBackend;
        ConfigManager.CONFIG.M365_POC_SAFE_MODE = originalSafeMode;
    });

    test('marks the dashboard copy of a reply as transient', async () => {
        await MessageManager.send({ platform: 'web' }, 'M365 reply', {});

        expect(dashboard.webServer.broadcastLog).toHaveBeenCalledWith(expect.objectContaining({
            msg: expect.stringContaining('M365 reply'),
            transient: true,
        }));
    });
});
