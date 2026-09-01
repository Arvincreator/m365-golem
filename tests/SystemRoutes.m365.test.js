const express = require('express');
const ConfigManager = require('../src/config');
const SystemUpdater = require('../src/utils/SystemUpdater');
const registerSystemRoutes = require('../web-dashboard/routes/api.system');

describe('system routes in M365 safe mode', () => {
    const originalBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
    const originalSafeMode = ConfigManager.CONFIG.M365_POC_SAFE_MODE;
    let httpServer;
    let baseUrl;

    beforeAll(async () => {
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        ConfigManager.CONFIG.M365_POC_SAFE_MODE = true;

        const app = express();
        app.use(registerSystemRoutes({
            contexts: new Map(),
            allowRemote: false,
            isBooting: false,
        }));
        await new Promise((resolve) => {
            httpServer = app.listen(0, '127.0.0.1', resolve);
        });
        const address = httpServer.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        ConfigManager.CONFIG.GOLEM_BACKEND = originalBackend;
        ConfigManager.CONFIG.M365_POC_SAFE_MODE = originalSafeMode;
        if (httpServer) {
            await new Promise((resolve) => httpServer.close(resolve));
        }
    });

    test('returns a local disabled result without running the network updater', async () => {
        const updaterSpy = jest.spyOn(SystemUpdater, 'checkEnvironment');
        const response = await fetch(`${baseUrl}/api/system/update/check`);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(expect.objectContaining({
            isOutdated: false,
            installMode: 'disabled',
            remoteVersionError: 'disabled_in_m365_safe_mode',
        }));
        expect(updaterSpy).not.toHaveBeenCalled();
        updaterSpy.mockRestore();
    });
});
