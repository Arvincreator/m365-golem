'use strict';

const express = require('express');

const mockStore = {
    getConversation: jest.fn(),
    getProject: jest.fn(),
    addMessage: jest.fn(),
    updateMessageDeliveryState: jest.fn(),
    acknowledgeConversationProjectContext: jest.fn(),
};
const mockActivate = jest.fn();
const mockCaptureBinding = jest.fn();
const mockMarkReconcile = jest.fn();
const mockHandleDashboardMessage = jest.fn();
const mockProjectWorkspaceService = {
    ensureProject: jest.fn(),
    getRelevantMemories: jest.fn(),
};
const mockBrain = {
    toolVectorIndex: null,
    _resolveToolVectorEmbedder: jest.fn(() => null),
};
const mockSkillPackageRegistry = {
    listSkillPackages: jest.fn(),
};
const mockReferenceFileService = {
    list: jest.fn(),
    read: jest.fn(),
};
const mockMcpManager = {
    _loaded: true,
    load: jest.fn(),
    getServers: jest.fn(),
};

jest.mock('../src/services/M365WorkspaceService', () => ({
    isM365WorkspaceEnabled: jest.fn(() => true),
    getM365WorkspaceStore: jest.fn(async () => mockStore),
    getM365ProjectWorkspaceService: jest.fn(() => mockProjectWorkspaceService),
    activateM365Conversation: (...args) => mockActivate(...args),
    captureM365ConversationBinding: (...args) => mockCaptureBinding(...args),
    markConversationReconcileRequired: (...args) => mockMarkReconcile(...args),
    acquireM365DispatchLease: jest.fn((server, input) => {
        if (server.m365DispatchLease) {
            const error = new Error('busy');
            error.code = 'M365_UI_BUSY';
            error.statusCode = 409;
            throw error;
        }
        const lease = { token: 'lease-token', ...input };
        server.m365DispatchLease = lease;
        return lease;
    }),
    releaseM365DispatchLease: jest.fn((server, token) => {
        if (server.m365DispatchLease?.token !== token) return false;
        server.m365DispatchLease = null;
        return true;
    }),
    resolveM365Brain: jest.fn(() => mockBrain),
}));

jest.mock('../index.js', () => ({
    handleDashboardMessage: (...args) => mockHandleDashboardMessage(...args),
}));

jest.mock('../src/services/ReferenceFileService', () => mockReferenceFileService);
jest.mock('../src/managers/SkillPackageRegistry', () => mockSkillPackageRegistry);
jest.mock('../src/mcp/MCPManager', () => ({
    getInstance: () => mockMcpManager,
}));

const ConfigManager = require('../src/config');
const registerChatRoutes = require('../web-dashboard/routes/api.chat');

describe('workspace-aware M365 chat route', () => {
    let httpServer;
    let baseUrl;
    let serverContext;
    let previousBackend;
    let previousSafeMode;

    beforeAll(async () => {
        previousBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
        previousSafeMode = ConfigManager.CONFIG.M365_POC_SAFE_MODE;
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        ConfigManager.CONFIG.M365_POC_SAFE_MODE = true;

        serverContext = {
            broadcastLog: jest.fn(),
            chatHistory: new Map(),
            m365DispatchLease: null,
        };
        const app = express();
        app.use(express.json());
        app.use(registerChatRoutes(serverContext));
        await new Promise((resolve) => {
            httpServer = app.listen(0, '127.0.0.1', resolve);
        });
        const address = httpServer.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        ConfigManager.CONFIG.GOLEM_BACKEND = previousBackend;
        ConfigManager.CONFIG.M365_POC_SAFE_MODE = previousSafeMode;
        if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    });

    beforeEach(() => {
        jest.clearAllMocks();
        serverContext.m365DispatchLease = null;
        serverContext.m365PendingResponses?.clear();
        delete serverContext.m365AttachmentService;
        mockStore.getConversation.mockResolvedValue({
            id: 'conversation-1',
            projectId: 'project-1',
            status: 'active',
            bindingState: 'unbound',
            projectContextVersion: 1,
            remoteConversationId: null,
            remoteConversationUrl: null,
        });
        mockStore.getProject.mockResolvedValue({
            id: 'project-1',
            description: 'Project background',
            instructions: 'Keep this project isolated.',
            contextVersion: 1,
        });
        mockStore.addMessage
            .mockReset()
            .mockResolvedValueOnce({ id: 'user-message-1' })
            .mockResolvedValueOnce({ id: 'assistant-message-1' });
        mockStore.updateMessageDeliveryState.mockResolvedValue({ id: 'user-message-1' });
        mockStore.acknowledgeConversationProjectContext.mockResolvedValue({
            id: 'conversation-1',
            projectId: 'project-1',
            bindingState: 'bound',
            projectContextVersion: 1,
        });
        mockActivate.mockResolvedValue({ status: 'expected_host', isConversation: false });
        mockCaptureBinding.mockResolvedValue({
            id: 'conversation-1',
            projectId: 'project-1',
            status: 'active',
            bindingState: 'bound',
            remoteConversationId: 'remote-1',
            remoteConversationUrl: 'https://m365.cloud.microsoft/chat/conversation/remote-1',
        });
        mockMarkReconcile.mockResolvedValue();
        mockReferenceFileService.list.mockReturnValue([]);
        mockReferenceFileService.read.mockReturnValue(null);
        mockMcpManager.getServers.mockReturnValue([]);
        mockProjectWorkspaceService.ensureProject.mockReturnValue({
            projectId: 'project-1',
            rootPath: 'C:\\local\\m365-projects\\project-1',
            agentsPath: 'C:\\local\\m365-projects\\project-1\\AGENTS.md',
            agentsContent: '# AGENTS.md\n\n> Managed automatically by the resident Golem AI.',
            agentsTruncated: false,
            memoryEntries: [{
                id: 'pm_0123456789abcdef',
                kind: 'rule',
                importance: 'core',
                content: 'Keep a visible evidence trail.',
                tags: ['evidence'],
            }],
            memoryCount: 1,
            managedBy: 'golem',
            updatedAt: '2026-09-01T00:00:00.000Z',
        });
        mockProjectWorkspaceService.getRelevantMemories.mockResolvedValue([{
            id: 'pm_0123456789abcdef',
            kind: 'rule',
            importance: 'core',
            content: 'Keep a visible evidence trail.',
            tags: ['evidence'],
        }]);
        mockSkillPackageRegistry.listSkillPackages.mockReturnValue([]);
    });

    async function postChat(body) {
        const response = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { response, body: await response.json() };
    }

    async function waitFor(check, timeoutMs = 1000) {
        const startedAt = Date.now();
        while (!check()) {
            if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout');
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    test('persists the user before dispatch, binds the remote chat, and persists the response', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.textOverride).toContain('[PROJECT_CONTEXT version="1"]');
            expect(ctx.textOverride).toContain('[PROJECT_MEMORY]');
            expect(ctx.textOverride).toContain('Keep a visible evidence trail.');
            expect(ctx.textOverride).toContain('[GOLEM_WORKSPACE_REQUEST:');
            expect(ctx.textOverride).toContain('[TURN_RESPONSE_MODE]');
            expect(ctx.textOverride).toContain('[/GOLEM_WORKSPACE_REQUEST]');
            expect(ctx.workspaceRoot).toBe('C:\\local\\m365-projects\\project-1');
            expect(ctx.m365ProjectWorkspaceService).toBe(mockProjectWorkspaceService);
            expect(ctx.toolRoutingQuery).toBe('Prepare a memo.');
            await ctx.onTransportStart();
            await ctx.onTransportAccepted();
            await ctx.onTransportComplete({ text: 'M365 answer' });
            await ctx.reply('M365 answer');
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Prepare a memo.',
        });

        expect(result.response.status).toBe(200);
        expect(result.body).toEqual(expect.objectContaining({
            success: true,
            projectId: 'project-1',
            conversationId: 'conversation-1',
            messageId: 'user-message-1',
        }));
        await waitFor(() => serverContext.m365DispatchLease === null);

        expect(mockStore.addMessage).toHaveBeenNthCalledWith(1, 'conversation-1', expect.objectContaining({
            role: 'user',
            content: 'Prepare a memo.',
            deliveryState: 'local',
        }));
        expect(mockStore.updateMessageDeliveryState).toHaveBeenCalledWith('user-message-1', 'confirmed');
        expect(mockCaptureBinding).toHaveBeenCalled();
        expect(mockStore.acknowledgeConversationProjectContext).toHaveBeenCalledWith('conversation-1', 1);
        expect(mockStore.addMessage).toHaveBeenNthCalledWith(2, 'conversation-1', expect.objectContaining({
            role: 'assistant',
            source: 'm365',
            content: 'M365 answer',
            deliveryState: 'response_confirmed',
        }));
        expect(serverContext.broadcastLog).toHaveBeenCalledWith(expect.objectContaining({
            conversationId: 'conversation-1',
            transient: false,
        }));
    });

    test('loads relevant project memory on every turn even when encrypted project context is already current', async () => {
        mockStore.getConversation.mockResolvedValue({
            id: 'conversation-1',
            projectId: 'project-1',
            status: 'active',
            bindingState: 'bound',
            projectContextVersion: 1,
            remoteConversationId: 'remote-1',
            remoteConversationUrl: 'https://m365.cloud.microsoft/chat/conversation/remote-1',
        });
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.textOverride).not.toContain('[PROJECT_CONTEXT version="1"]');
            expect(ctx.textOverride).toContain('[PROJECT_MEMORY]');
            expect(ctx.textOverride).toContain('Keep a visible evidence trail.');
            expect(ctx.textOverride).toContain('[LOCAL_PROJECT_WORKSPACE]');
            await ctx.onTransportComplete({ text: 'M365 answer' });
            await ctx.reply('M365 answer');
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Continue this project.',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(mockStore.acknowledgeConversationProjectContext).not.toHaveBeenCalled();
        expect(mockProjectWorkspaceService.getRelevantMemories).toHaveBeenCalledWith(
            'project-1',
            'Continue this project.',
            expect.objectContaining({ limit: 8 })
        );
    });

    test('adds only explicitly selected file text, MCP servers, Skills, and response mode to the Golem workspace envelope', async () => {
        mockReferenceFileService.list.mockReturnValue([{
            id: 'ref-1',
            name: 'brief.md',
            path: 'C:\\safe\\brief.md',
            enabled: true,
            status: 'ready',
        }]);
        mockReferenceFileService.read.mockReturnValue({
            id: 'ref-1',
            name: 'brief.md',
            path: 'C:\\safe\\brief.md',
            text: 'Selected local reference facts.',
        });
        mockMcpManager.getServers.mockReturnValue([{
            name: 'demo-mcp',
            description: 'Read-only demo tools',
            enabled: true,
            connected: true,
        }]);
        mockSkillPackageRegistry.listSkillPackages.mockReturnValue([{
            id: 'reference-files',
            name: 'Reference files',
            description: 'Inspect selected project references',
            action: 'reference-files',
            enabled: true,
            indexPath: __filename,
        }]);
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.textOverride).toContain('[TURN_RESPONSE_MODE]');
            expect(ctx.textOverride).toContain('Think through the request carefully');
            expect(ctx.textOverride).toContain('[USER_SELECTED_MCP_SERVERS]');
            expect(ctx.textOverride).toContain('demo-mcp: Read-only demo tools');
            expect(ctx.textOverride).toContain('[USER_SELECTED_SKILLS]');
            expect(ctx.textOverride).toContain('reference-files (action: reference-files)');
            expect(ctx.textOverride).toContain('[USER_SELECTED_REFERENCE_FILES]');
            expect(ctx.textOverride).toContain('Selected local reference facts.');
            expect(ctx.textOverride).toContain('[/GOLEM_WORKSPACE_REQUEST]');
            expect(ctx.preferredMcpServers).toEqual(['demo-mcp']);
            expect(ctx.preferredSkillIds).toEqual(['reference-files']);
            expect(ctx.preferredSkillActions).toEqual(['reference-files']);
            await ctx.onTransportComplete({ text: 'M365 answer' });
            await ctx.reply('M365 answer');
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Use my selected context.',
            responseMode: 'thoughtful',
            selectedMcpServers: ['demo-mcp'],
            selectedSkillIds: ['reference-files'],
            referenceFileIds: ['ref-1'],
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(mockStore.addMessage).toHaveBeenNthCalledWith(1, 'conversation-1', expect.objectContaining({
            content: 'Use my selected context.',
        }));
        expect(mockReferenceFileService.read).toHaveBeenCalledWith('ref-1', expect.objectContaining({ maxChars: 6000 }));
    });

    test('refuses to send an indexed environment file into Microsoft 365 context', async () => {
        mockReferenceFileService.list.mockReturnValue([{
            id: 'ref-env',
            name: '.env',
            path: 'C:\\safe\\.env',
            enabled: true,
            status: 'ready',
        }]);

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Use this file.',
            referenceFileIds: ['ref-env'],
        });

        expect(result.response.status).toBe(400);
        expect(result.body.error).toBe('M365_REFERENCE_FILE_SENSITIVE');
        expect(mockReferenceFileService.read).not.toHaveBeenCalled();
        expect(mockStore.addMessage).not.toHaveBeenCalled();
        expect(mockActivate).not.toHaveBeenCalled();
    });

    test('marks an uncertain browser send ambiguous and blocks the conversation for reconciliation', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            const error = new Error('The message may have left the composer.');
            error.code = 'M365_SEND_UNCONFIRMED';
            await ctx.onTransportError(error);
            await ctx.reply(`⚠️ ${error.message}`);
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Potentially ambiguous turn.',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(mockStore.updateMessageDeliveryState).toHaveBeenCalledWith('user-message-1', 'ambiguous');
        expect(mockMarkReconcile).toHaveBeenCalledWith(mockStore, 'conversation-1');
        expect(mockStore.addMessage).toHaveBeenNthCalledWith(2, 'conversation-1', expect.objectContaining({
            role: 'system',
            source: 'system',
            deliveryState: 'failed',
        }));
    });

    test('keeps a confirmed slow response recoverable without locking the conversation', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            await ctx.onTransportStart();
            await ctx.onTransportAccepted();
            const error = new Error('response timeout');
            error.code = 'M365_RESPONSE_NOT_FOUND';
            await ctx.onTransportError(error);
            await ctx.reply(`⚠️ ${error.message}`);
        });

        const sent = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Create a slow workbook.',
        });
        expect(sent.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);

        const response = await fetch(`${baseUrl}/api/chat/pending-responses?conversationId=conversation-1`);
        const body = await response.json();
        expect(body.items).toEqual([
            expect.objectContaining({ requestId: sent.body.requestId, retryCount: 0, status: 'needs_recheck' }),
        ]);
        expect(mockStore.updateMessageDeliveryState).toHaveBeenLastCalledWith('user-message-1', 'confirmed');
        expect(mockMarkReconcile).not.toHaveBeenCalled();
        expect(mockStore.addMessage).toHaveBeenNthCalledWith(2, 'conversation-1', expect.objectContaining({
            role: 'system',
            deliveryState: 'local',
        }));
    });

    test('keeps a staged attachment available until the dashboard transport settles', async () => {
        let finishTransport;
        const cleanupBatch = jest.fn();
        serverContext.m365AttachmentService = {
            resolveBatch: jest.fn(() => ({
                isNative: true,
                validatedByM365Harness: true,
                batchId: 'attachment-batch-1',
                files: [{
                    name: 'brief.pdf',
                    path: 'C:\\staged\\brief.pdf',
                    mimeType: 'application/pdf',
                    size: 12,
                    sha256: 'a'.repeat(64),
                }],
                totalBytes: 12,
            })),
            cleanupBatch,
        };
        mockHandleDashboardMessage.mockImplementation(() => new Promise((resolve) => {
            finishTransport = resolve;
        }));

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Read the attached brief.',
            attachmentBatchId: 'attachment-batch-1',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => typeof finishTransport === 'function');
        expect(cleanupBatch).not.toHaveBeenCalled();

        finishTransport();
        await waitFor(() => cleanupBatch.mock.calls.length === 1);
        expect(cleanupBatch).toHaveBeenCalledWith('attachment-batch-1', {
            projectId: 'project-1',
            conversationId: 'conversation-1',
        });
    });

    test('accepts a second dispatch into the dialogue queue while Edge is leased', async () => {
        serverContext.m365DispatchLease = {
            token: 'existing',
            conversationId: 'another-conversation',
        };

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Do not send this.',
        });

        expect(result.response.status).toBe(200);
        expect(result.body.success).toBe(true);
        expect(mockActivate).not.toHaveBeenCalled();
        expect(mockStore.addMessage).toHaveBeenCalledWith('conversation-1', expect.objectContaining({
            role: 'user',
            deliveryState: 'local',
        }));
    });
});
