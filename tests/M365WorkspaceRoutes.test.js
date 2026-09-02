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
            'M365_PROJECTS_ROOT',
        ]) {
            previousEnv[key] = process.env[key];
        }
        previousBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        process.env.M365_WORKSPACE_ENABLED = 'true';
        process.env.M365_RUNNER_ENABLED = 'true';
        process.env.M365_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
        process.env.M365_WORKSPACE_DB_PATH = path.join(tempDir, 'workspace.sqlite');
        process.env.M365_PROJECTS_ROOT = path.join(tempDir, 'projects');

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
        expect(projectResult.body.workspace).toEqual(expect.objectContaining({
            projectId,
            rootPath: path.join(tempDir, 'projects', projectId),
            agentsPath: path.join(tempDir, 'projects', projectId, 'AGENTS.md'),
            agentsTruncated: false,
        }));
        expect(fs.existsSync(path.join(tempDir, 'projects', projectId, 'references'))).toBe(true);
        expect(fs.existsSync(path.join(tempDir, 'projects', projectId, 'outputs'))).toBe(true);

        const workspaceResult = await request(`/api/projects/${projectId}/workspace`);
        expect(workspaceResult.response.status).toBe(200);
        expect(workspaceResult.body.workspace.agentsContent).toContain('cannot bypass Golem safety rules');

        const originalContextVersion = projectResult.body.project.contextVersion;
        const agentsContent = '# 專案規則\n\n- 產出需標示依據與待人工確認事項。\n';
        const agentsResult = await request(`/api/projects/${projectId}/agents`, {
            method: 'PUT',
            body: JSON.stringify({ content: agentsContent }),
        });
        expect(agentsResult.response.status).toBe(200);
        expect(agentsResult.body.workspace.agentsContent).toBe(agentsContent);
        expect(agentsResult.body.project.contextVersion).toBe(originalContextVersion + 1);
        expect(fs.readFileSync(path.join(tempDir, 'projects', projectId, 'AGENTS.md'), 'utf8')).toBe(agentsContent);
        expect(fs.readFileSync(process.env.M365_WORKSPACE_DB_PATH)).not.toContain(agentsContent);

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

        const secondConversationId = secondConversation.body.conversation.id;
        const renamedConversation = await request(`/api/conversations/${secondConversationId}`, {
            method: 'PATCH',
            body: JSON.stringify({ title: 'Payroll evidence review' }),
        });
        expect(renamedConversation.response.status).toBe(200);
        expect(renamedConversation.body.conversation).toEqual(expect.objectContaining({
            id: secondConversationId,
            title: 'Payroll evidence review',
            status: 'active',
        }));

        const archivedConversation = await request(`/api/conversations/${secondConversationId}/archive`, {
            method: 'POST',
        });
        expect(archivedConversation.response.status).toBe(200);
        expect(archivedConversation.body.conversation.status).toBe('archived');

        const activeConversations = await request(`/api/projects/${projectId}/conversations`);
        expect(activeConversations.body.conversations.map((item) => item.id)).toEqual([
            firstConversation.body.conversation.id,
        ]);
        const allConversations = await request(`/api/projects/${projectId}/conversations?includeArchived=true`);
        expect(allConversations.body.conversations).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: secondConversationId, title: 'Payroll evidence review', status: 'archived' }),
        ]));

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
