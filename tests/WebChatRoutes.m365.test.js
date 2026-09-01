const express = require('express');
const ConfigManager = require('../src/config');
const registerChatRoutes = require('../web-dashboard/routes/api.chat');

describe('web chat routes in M365 safe mode', () => {
    const originalBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
    const originalSafeMode = ConfigManager.CONFIG.M365_POC_SAFE_MODE;
    let httpServer;
    let baseUrl;

    beforeAll(async () => {
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        ConfigManager.CONFIG.M365_POC_SAFE_MODE = true;

        const app = express();
        app.use(express.json());
        app.use(registerChatRoutes({
            broadcastLog: jest.fn(),
            chatHistory: new Map([
                ['golem_A', [{ msg: '[User] retained-before-safe-mode' }]],
            ]),
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

    test('blocks attachments before message dispatch', async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                golemId: 'golem_A',
                message: 'text',
                attachment: { url: 'https://example.com/file.pdf' },
            }),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual(expect.objectContaining({
            error: expect.stringContaining('text only'),
        }));
    });

    test('blocks stale approval callbacks', async () => {
        const response = await fetch(`${baseUrl}/api/chat/callback`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                golemId: 'golem_A',
                callback_data: 'APPROVE_old-task',
            }),
        });

        expect(response.status).toBe(409);
    });

    test('does not return retained dashboard history while safe mode is active', async () => {
        const response = await fetch(`${baseUrl}/api/chat/history?golemId=golem_A`);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ success: true, history: [] });
    });
});
