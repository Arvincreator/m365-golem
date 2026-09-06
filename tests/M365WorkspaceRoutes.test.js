'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ConfigManager = require('../src/config');
const M365AttachmentService = require('../src/services/M365AttachmentService');
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

        serverContext = {
            m365DispatchLease: null,
            m365AttachmentService: new M365AttachmentService({
                rootDir: path.join(tempDir, 'attachments'),
                maxFileBytes: 1024,
                maxTotalBytes: 2048,
            }),
            localWorkspacePicker: {
                selectFolder: jest.fn(async () => ({
                    cancelled: false,
                    path: path.join(tempDir, 'picked-folder'),
                })),
            },
        };
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
                origin: 'http://localhost:3000',
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

    test('opens the local-only folder picker through a user-initiated endpoint', async () => {
        const result = await request('/api/m365/workspace/pick-folder', {
            method: 'POST',
            body: JSON.stringify({ description: 'Choose a workspace' }),
        });
        expect(result.response.status).toBe(200);
        expect(result.body).toEqual({
            success: true,
            cancelled: false,
            path: path.join(tempDir, 'picked-folder'),
        });
        expect(serverContext.localWorkspacePicker.selectFolder).toHaveBeenCalledWith({
            description: 'Choose a workspace',
            initialPath: undefined,
        });

        const denied = await fetch(`${baseUrl}/api/m365/workspace/pick-folder`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://example.com' },
            body: '{}',
        });
        expect(denied.status).toBe(403);
        await expect(denied.json()).resolves.toEqual(expect.objectContaining({
            error: 'M365_FOLDER_PICKER_LOCAL_ONLY',
        }));
    });

    test('stages and cancels attachments only for the bound local project conversation', async () => {
        const projectResult = await request('/api/projects', {
            method: 'POST',
            body: JSON.stringify({ name: 'Attachment Project' }),
        });
        const projectId = projectResult.body.project.id;
        const conversationResult = await request(`/api/projects/${encodeURIComponent(projectId)}/conversations`, {
            method: 'POST',
            body: JSON.stringify({ title: 'Attachment Conversation' }),
        });
        const conversationId = conversationResult.body.conversation.id;

        const created = await request('/api/m365/attachments/batches', {
            method: 'POST',
            body: JSON.stringify({ projectId, conversationId }),
        });
        expect(created.response.status).toBe(201);

        const staged = await request(`/api/m365/attachments/batches/${created.body.batchId}/files`, {
            method: 'POST',
            body: JSON.stringify({
                projectId,
                conversationId,
                fileName: 'source.txt',
                base64Data: Buffer.from('local source').toString('base64'),
            }),
        });
        expect(staged.response.status).toBe(201);
        expect(staged.body.file).toEqual(expect.objectContaining({ name: 'source.txt', size: 12 }));

        const mismatch = await request(`/api/m365/attachments/batches/${created.body.batchId}/files`, {
            method: 'POST',
            body: JSON.stringify({
                projectId: 'different-project',
                conversationId,
                fileName: 'other.txt',
                base64Data: Buffer.from('x').toString('base64'),
            }),
        });
        expect(mismatch.response.status).toBe(409);

        const cancelled = await request(`/api/m365/attachments/batches/${created.body.batchId}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ projectId, conversationId }),
        });
        expect(cancelled.response.status).toBe(200);
        expect(cancelled.body.removed).toBe(true);

        const denied = await fetch(`${baseUrl}/api/m365/attachments/batches`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://example.com' },
            body: JSON.stringify({ projectId, conversationId }),
        });
        expect(denied.status).toBe(403);
    });

    test('creates and links user-selected workspaces without overwriting existing instructions', async () => {
        const createParent = path.join(tempDir, 'user-selected');
        fs.mkdirSync(createParent);
        const created = await request('/api/projects', {
            method: 'POST',
            body: JSON.stringify({
                name: 'Selected Workspace Project',
                workspaceMode: 'create',
                workspacePath: createParent,
                workspaceFolderName: 'Customer A',
            }),
        });
        const createdRoot = path.join(createParent, 'Customer A');
        expect(created.response.status).toBe(201);
        expect(created.body.project).toEqual(expect.objectContaining({
            workspaceMode: 'create',
            workspacePath: createdRoot,
        }));
        expect(created.body.workspace.rootPath).toBe(createdRoot);
        expect(fs.existsSync(path.join(createdRoot, 'AGENTS.md'))).toBe(true);
        expect(fs.existsSync(path.join(createdRoot, 'references'))).toBe(true);
        expect(fs.existsSync(path.join(createdRoot, 'outputs'))).toBe(true);

        const linkedRoot = path.join(tempDir, 'linked-existing');
        fs.mkdirSync(linkedRoot);
        fs.writeFileSync(path.join(linkedRoot, 'source.txt'), 'original source', 'utf8');
        const linked = await request('/api/projects', {
            method: 'POST',
            body: JSON.stringify({
                name: 'Linked Workspace Project',
                workspaceMode: 'existing',
                workspacePath: linkedRoot,
            }),
        });
        expect(linked.response.status).toBe(201);
        expect(linked.body.project).toEqual(expect.objectContaining({
            workspaceMode: 'existing',
            workspacePath: linkedRoot,
        }));
        expect(fs.readFileSync(path.join(linkedRoot, 'source.txt'), 'utf8')).toBe('original source');

        const protectedRoot = path.join(tempDir, 'protected-existing');
        fs.mkdirSync(protectedRoot);
        const protectedAgents = '# User-owned instructions\n';
        fs.writeFileSync(path.join(protectedRoot, 'AGENTS.md'), protectedAgents, 'utf8');
        const rejected = await request('/api/projects', {
            method: 'POST',
            body: JSON.stringify({
                name: 'Must Not Exist',
                workspaceMode: 'existing',
                workspacePath: protectedRoot,
            }),
        });
        expect(rejected.response.status).toBe(409);
        expect(rejected.body.error).toBe('M365_PROJECT_AGENTS_CONFLICT');
        expect(fs.readFileSync(path.join(protectedRoot, 'AGENTS.md'), 'utf8')).toBe(protectedAgents);
        const projects = await request('/api/projects');
        expect(projects.body.projects).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Must Not Exist' }),
        ]));
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
            managedBy: 'golem',
            memoryCount: 0,
        }));
        expect(fs.existsSync(path.join(tempDir, 'projects', projectId, 'references'))).toBe(true);
        expect(fs.existsSync(path.join(tempDir, 'projects', projectId, 'outputs'))).toBe(true);

        const workspaceResult = await request(`/api/projects/${projectId}/workspace`);
        expect(workspaceResult.response.status).toBe(200);
        expect(workspaceResult.body.workspace.agentsContent).toContain('Managed automatically by the resident Golem AI');

        const agentsContent = '# 專案規則\n\n- 產出需標示依據與待人工確認事項。\n';
        const agentsResult = await request(`/api/projects/${projectId}/agents`, {
            method: 'PUT',
            body: JSON.stringify({ content: agentsContent }),
        });
        expect(agentsResult.response.status).toBe(409);
        expect(agentsResult.body.error).toBe('M365_PROJECT_AGENTS_MANAGED');
        expect(fs.readFileSync(path.join(tempDir, 'projects', projectId, 'AGENTS.md'), 'utf8')).toContain('Managed automatically');
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
