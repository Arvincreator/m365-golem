'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ConfigManager = require('../src/config');
const registerM365WorkspaceRoutes = require('../web-dashboard/routes/api.m365-workspace');

describe('M365 workspace routes', () => {
    let tempDir;
    let serverContext;
    let httpServer;
    let baseUrl;
    const previousEnv = {};
    let previousBackend;

    beforeAll(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-m365-routes-'));
        for (const key of [
            'M365_WORKSPACE_ENABLED',
            'M365_RUNNER_ENABLED',
            'M365_DATA_ENCRYPTION_KEY',
            'M365_WORKSPACE_DB_PATH',
        ]) {
            previousEnv[key] = process.env[key];
        }
        previousBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        process.env.M365_WORKSPACE_ENABLED = 'true';
        process.env.M365_RUNNER_ENABLED = 'true';
        process.env.M365_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
        process.env.M365_WORKSPACE_DB_PATH = path.join(tempDir, 'workspace.sqlite');

        serverContext = { m365DispatchLease: null };
        const app = express();
        app.use(express.json());
        app.use(registerM365WorkspaceRoutes(serverContext));
        await new Promise((resolve) => {
            httpServer = app.listen(0, '127.0.0.1', resolve);
        });
        const address = httpServer.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        if (serverContext.m365WorkspaceStore) {
            await serverContext.m365WorkspaceStore.close().catch(() => undefined);
        }
        if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
        ConfigManager.CONFIG.GOLEM_BACKEND = previousBackend;
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    async function request(url, options = {}) {
        const response = await fetch(`${baseUrl}${url}`, {
            ...options,
            headers: {
                'content-type': 'application/json',
                ...(options.headers || {}),
            },
        });
        return { response, body: await response.json() };
    }

    test('reports encrypted workspace and runner readiness without exposing the key or path', async () => {
        const { response, body } = await request('/api/m365/workspace/status');
        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            workspace: {
                enabled: true,
                runnerEnabled: true,
                encryptionConfigured: true,
                activeDispatch: false,
            },
        });
        expect(JSON.stringify(body)).not.toContain(process.env.M365_DATA_ENCRYPTION_KEY);
        expect(JSON.stringify(body)).not.toContain(tempDir);
    });

    test('creates a project, multiple conversations, and a review-gated run', async () => {
        const projectResult = await request('/api/projects', {
            method: 'POST',
            body: JSON.stringify({
                name: 'Accounting POC',
                description: 'Isolated POC context',
                instructions: 'Do not mix with another project.',
            }),
        });
        expect(projectResult.response.status).toBe(201);
        const projectId = projectResult.body.project.id;

        const firstConversation = await request(`/api/projects/${projectId}/conversations`, {
            method: 'POST',
            body: JSON.stringify({ title: 'VAT review' }),
        });
        const secondConversation = await request(`/api/projects/${projectId}/conversations`, {
            method: 'POST',
            body: JSON.stringify({ title: 'Payroll review' }),
        });
        expect(firstConversation.response.status).toBe(201);
        expect(secondConversation.response.status).toBe(201);

        const conversations = await request(`/api/projects/${projectId}/conversations`);
        expect(conversations.body.conversations.map((item) => item.title).sort()).toEqual([
            'Payroll review',
            'VAT review',
        ]);

        const conversationId = firstConversation.body.conversation.id;
        const runResult = await request(`/api/conversations/${conversationId}/runs`, {
            method: 'POST',
            body: JSON.stringify({
                objective: 'Prepare a VAT review memo.',
                constraints: 'Text-only M365 Web.',
                verification: 'Memo includes evidence and open questions.',
                maxSteps: 3,
            }),
        });
        expect(runResult.response.status).toBe(201);
        expect(runResult.body).toEqual(expect.objectContaining({
            run: expect.objectContaining({ status: 'WAITING_START_APPROVAL', maxSteps: 3 }),
            approval: expect.objectContaining({ status: 'pending', approvalType: 'run_start' }),
        }));

        const runDetail = await request(`/api/runs/${runResult.body.run.id}`);
        expect(runDetail.response.status).toBe(200);
        expect(runDetail.body).toEqual(expect.objectContaining({
            steps: [],
            events: expect.any(Array),
            approvals: [expect.objectContaining({ status: 'pending' })],
            checkpoint: expect.objectContaining({
                state: expect.objectContaining({ status: 'WAITING_START_APPROVAL' }),
            }),
        }));

        const archiveResult = await request(`/api/projects/${projectId}/archive`, { method: 'POST' });
        expect(archiveResult.response.status).toBe(409);
        expect(archiveResult.body.error).toBe('M365_PROJECT_HAS_ACTIVE_RUN');
    });
});
