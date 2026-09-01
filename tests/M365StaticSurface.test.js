'use strict';

const express = require('express');
const ConfigManager = require('../src/config');
const registerStaticRoutes = require('../web-dashboard/server/registerStaticRoutes');

describe('M365-only static dashboard surface', () => {
    let httpServer;
    let baseUrl;
    let originalBackend;
    let originalDevMode;

    beforeAll(async () => {
        originalBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
        originalDevMode = process.env.DASHBOARD_DEV_MODE;
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        process.env.DASHBOARD_DEV_MODE = 'true';
        const server = {
            app: express(),
            port: 3001,
            requiresRemoteAuth: () => false,
            isAuthenticatedRequest: () => true,
        };
        registerStaticRoutes(server);
        [
            '/dashboard/chat',
            '/dashboard/skills',
            '/dashboard/mcp',
            '/dashboard/memory',
            '/dashboard/action-gate',
            '/dashboard/persona',
            '/dashboard/reference-files',
        ].forEach((route) => server.app.get(route, (req, res) => res.status(200).send('dashboard page')));
        server.app.get('/dashboard/chat.txt', (req, res) => res.status(200).send('chat payload'));
        server.app.get('/dashboard/skills.txt', (req, res) => res.status(200).send('skills payload'));
        server.app.get('/dashboard/__next._tree.txt', (req, res) => res.status(200).send('shared payload'));
        await new Promise((resolve) => {
            httpServer = server.app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    });

    afterAll(async () => {
        if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
        ConfigManager.CONFIG.GOLEM_BACKEND = originalBackend;
        if (originalDevMode === undefined) delete process.env.DASHBOARD_DEV_MODE;
        else process.env.DASHBOARD_DEV_MODE = originalDevMode;
    });

    test.each([
        '/dashboard/stocks',
        '/dashboard/rpg',
        '/dashboard/crypto',
        '/dashboard/diary',
    ])('redirects removed page %s to projects', async (route) => {
        const response = await fetch(`${baseUrl}${route}`, { redirect: 'manual' });
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/dashboard/projects');
    });

    test.each([
        '/dashboard/chat',
        '/dashboard/skills',
        '/dashboard/mcp',
        '/dashboard/memory',
        '/dashboard/action-gate',
        '/dashboard/persona',
        '/dashboard/reference-files',
        '/dashboard/chat.txt',
        '/dashboard/skills.txt',
        '/dashboard/__next._tree.txt',
    ])('allows retained dashboard page or Next payload %s', async (route) => {
        const response = await fetch(`${baseUrl}${route}`, { redirect: 'manual' });
        expect(response.status).toBe(200);
    });

    test('does not expose legacy upload files or RPG assets', async () => {
        const filesResponse = await fetch(`${baseUrl}/api/files/example.pdf`);
        expect(filesResponse.status).toBe(404);
        await expect(filesResponse.json()).resolves.toEqual(expect.objectContaining({
            error: 'M365_FEATURE_DISABLED',
        }));

        const rpgResponse = await fetch(`${baseUrl}/rpg/index.html`);
        expect(rpgResponse.status).toBe(404);
    });
});
