'use strict';

const express = require('express');
const ConfigManager = require('../src/config');
const {
    buildM365OnlyApiGuard,
    isAllowedM365ApiRequest,
} = require('../web-dashboard/server/m365OnlyRoutes');

describe('M365-only API surface', () => {
    let httpServer;
    let baseUrl;
    let originalBackend;

    beforeAll(async () => {
        originalBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';

        const app = express();
        app.use(buildM365OnlyApiGuard());
        app.use((req, res) => res.json({ passed: true }));
        await new Promise((resolve) => {
            httpServer = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    });

    afterAll(async () => {
        ConfigManager.CONFIG.GOLEM_BACKEND = originalBackend;
        if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    });

    test.each([
        ['GET', '/api/m365/workspace/status'],
        ['POST', '/api/projects'],
        ['PATCH', '/api/projects/project-1'],
        ['GET', '/api/projects/project-1/conversations'],
        ['POST', '/api/conversations/conversation-1/activate'],
        ['GET', '/api/conversations/conversation-1/messages'],
        ['POST', '/api/conversations/conversation-1/runs'],
        ['POST', '/api/runs/run-1/resume'],
        ['POST', '/api/approvals/approval-1/decision'],
        ['POST', '/api/chat'],
        ['GET', '/api/skills'],
        ['GET', '/api/mcp/servers'],
        ['GET', '/api/persona'],
        ['GET', '/api/memory/search'],
        ['GET', '/api/reference-files'],
        ['GET', '/api/config'],
        ['POST', '/api/upload'],
        ['POST', '/api/system/update/execute'],
    ])('allows %s %s', async (method, route) => {
        expect(isAllowedM365ApiRequest(method, route)).toBe(true);
        const response = await fetch(`${baseUrl}${route}`, { method });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ passed: true });
    });

    test.each([
        ['GET', '/api/rpg'],
        ['POST', '/api/rpg/session/start'],
        ['GET', '/api/stocks/2330'],
        ['POST', '/api/crypto/refresh'],
        ['GET', '/api/diary/entries'],
    ])('blocks retired module %s %s', async (method, route) => {
        expect(isAllowedM365ApiRequest(method, route)).toBe(false);
        const response = await fetch(`${baseUrl}${route}`, { method });
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual(expect.objectContaining({
            success: false,
            error: 'M365_FEATURE_DISABLED',
        }));
    });

    test('does not restrict the original edition when another backend is selected', async () => {
        ConfigManager.CONFIG.GOLEM_BACKEND = 'gemini';
        const response = await fetch(`${baseUrl}/api/rpg`);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ passed: true });
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
    });
});
