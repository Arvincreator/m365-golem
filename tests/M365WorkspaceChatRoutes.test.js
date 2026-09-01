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
}));

jest.mock('../index.js', () => ({
    handleDashboardMessage: (...args) => mockHandleDashboardMessage(...args),
}));

jest.mock('../src/services/ReferenceFileService', () => mockReferenceFileService);
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
            expect(ctx.textOverride).toContain('[GOLEM_WORKSPACE_REQUEST:');
            expect(ctx.textOverride).toContain('[TURN_RESPONSE_MODE]');
            expect(ctx.textOverride).toContain('[/GOLEM_WORKSPACE_REQUEST]');
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
            deliveryState: 'dispatch_started',
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

    test('adds only explicitly selected file text, MCP servers, and response mode to the Golem workspace envelope', async () => {
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
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.textOverride).toContain('[TURN_RESPONSE_MODE]');
            expect(ctx.textOverride).toContain('Think through the request carefully');
            expect(ctx.textOverride).toContain('[USER_SELECTED_MCP_SERVERS]');
            expect(ctx.textOverride).toContain('demo-mcp: Read-only demo tools');
            expect(ctx.textOverride).toContain('[USER_SELECTED_REFERENCE_FILES]');
            expect(ctx.textOverride).toContain('Selected local reference facts.');
            expect(ctx.textOverride).toContain('[/GOLEM_WORKSPACE_REQUEST]');
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

    test('rejects a second dispatch while the visible Edge window is leased', async () => {
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

        expect(result.response.status).toBe(409);
        expect(result.body.error).toBe('M365_UI_BUSY');
        expect(mockActivate).not.toHaveBeenCalled();
        expect(mockStore.addMessage).not.toHaveBeenCalled();
    });
});
