'use strict';

const express = require('express');

const mockStore = {
    getConversation: jest.fn(),
    getDraft: jest.fn(),
    listProjectReferences: jest.fn(),
    getProject: jest.fn(),
    listMessages: jest.fn(),
    addMessage: jest.fn(),
    updateMessageDeliveryState: jest.fn(),
    updateConversationTitleIfPlaceholder: jest.fn(),
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
const mockLocalFolderService = {
    resolveSelectedReferences: jest.fn(),
    validateReferences: jest.fn(),
};
const mockMcpManager = {
    _loaded: true,
    load: jest.fn(),
    getServers: jest.fn(),
};
const mockUpdateEnv = jest.fn();
const mockExpandPromptShortcutInput = jest.fn((text) => ({
    changed: false,
    text,
    matched: null,
}));
const mockRecordM365PromptPoolUse = jest.fn();

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
jest.mock('../src/services/M365LocalFolderService', () => ({
    getM365LocalFolderService: jest.fn(() => mockLocalFolderService),
}));
jest.mock('../src/managers/SkillPackageRegistry', () => mockSkillPackageRegistry);
jest.mock('../src/mcp/MCPManager', () => ({
    getInstance: () => mockMcpManager,
}));
jest.mock('../src/utils/EnvManager', () => ({
    updateEnv: (...args) => mockUpdateEnv(...args),
}));
jest.mock('../src/managers/PromptShortcutManager', () => ({
    expandPromptShortcutInput: (...args) => mockExpandPromptShortcutInput(...args),
}));
jest.mock('../web-dashboard/routes/api.prompt-pool', () => ({
    recordM365PromptPoolUse: (...args) => mockRecordM365PromptPoolUse(...args),
}));

const ConfigManager = require('../src/config');
const { SecurityManager } = require('../packages/security');
const { getAutomationModePreset } = require('../src/config/AutomationModes');
const registerChatRoutes = require('../web-dashboard/routes/api.chat');

describe('workspace-aware M365 chat route', () => {
    let httpServer;
    let baseUrl;
    let serverContext;
    let previousBackend;
    let previousSafeMode;
    let previousAutomationEnv;
    let previousSecurityLevel;
    let reloadConfigSpy;

    beforeAll(async () => {
        previousBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
        previousSafeMode = ConfigManager.CONFIG.M365_POC_SAFE_MODE;
        previousSecurityLevel = SecurityManager.currentLevel;
        previousAutomationEnv = Object.fromEntries(
            Object.keys(getAutomationModePreset('guided')).map((key) => [key, process.env[key]])
        );
        reloadConfigSpy = jest.spyOn(ConfigManager, 'reloadConfig').mockImplementation(() => ConfigManager.CONFIG);
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
        SecurityManager.currentLevel = previousSecurityLevel;
        reloadConfigSpy.mockRestore();
        for (const [key, value] of Object.entries(previousAutomationEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    });

    beforeEach(() => {
        jest.clearAllMocks();
        serverContext.m365DispatchLease = null;
        delete serverContext.m365RunCoordinator;
        delete mockBrain.toolRouter;
        serverContext.m365PendingResponses?.clear();
        delete serverContext.m365AttachmentService;
        mockStore.getConversation.mockResolvedValue({
            id: 'conversation-1',
            projectId: 'project-1',
            title: '新對話',
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
        mockStore.getDraft.mockResolvedValue({ localFolders: [] });
        mockStore.listMessages.mockResolvedValue([]);
        mockLocalFolderService.resolveSelectedReferences.mockReturnValue([]);
        mockLocalFolderService.validateReferences.mockReturnValue([]);
        mockStore.addMessage
            .mockReset()
            .mockResolvedValueOnce({ id: 'user-message-1' })
            .mockResolvedValueOnce({ id: 'assistant-message-1' });
        mockStore.updateMessageDeliveryState.mockResolvedValue({ id: 'user-message-1' });
        mockStore.updateConversationTitleIfPlaceholder.mockResolvedValue({
            changed: true,
            reason: 'updated',
            conversation: {
                id: 'conversation-1',
                projectId: 'project-1',
                title: '整理 OneDrive 專案檔案',
                status: 'active',
                bindingState: 'bound',
                projectContextVersion: 1,
            },
        });
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
        mockStore.listProjectReferences.mockResolvedValue(["ref-1", "ref-env"]);
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

    test('renders real source links separately from generated file downloads', () => {
        const rendered = registerChatRoutes.appendVisibleDownloadLinks('完成。', [
            {
                kind: 'source',
                name: 'SharePoint 專案來源',
                url: 'https://ecovistw.sharepoint.com/sites/project',
            },
            {
                kind: 'download',
                name: '報表.xlsx',
                url: 'https://m365.cloud.microsoft/generated/report.xlsx',
            },
        ]);

        expect(rendered).toContain('M365 產生的檔案：');
        expect(rendered).toContain('[報表.xlsx](<https://m365.cloud.microsoft/generated/report.xlsx>)');
        expect(rendered).toContain('參考來源連結：');
        expect(rendered).toContain('[SharePoint 專案來源](<https://ecovistw.sharepoint.com/sites/project>)');
    });

    test('applies the complete original Golem automation preset from chat preferences', async () => {
        const response = await fetch(`${baseUrl}/api/chat/preferences`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ automationMode: 'balanced' }),
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual(expect.objectContaining({
            success: true,
            automationMode: 'balanced',
            approvalMode: 'manual',
        }));
        expect(mockUpdateEnv).toHaveBeenCalledWith(getAutomationModePreset('balanced'));
        expect(reloadConfigSpy).toHaveBeenCalled();
        expect(SecurityManager.currentLevel).toBe(1);
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
            expect(ctx.m365ResponseMode).toBe('auto');
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

    test('injects Goal-mode resource and safety rules into an opted-in user turn', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.workspaceGoalMode).toBe(true);
            expect(ctx.workspaceMaxActionDepth).toBeUndefined();
            expect(ctx.workspaceAutoTurnBudget).toBeUndefined();
            expect(ctx.textOverride).toContain('[GOAL_MODE]');
            expect(ctx.textOverride).toContain('golem-check tools <specific task>');
            expect(ctx.textOverride).toContain('replace unfinished plan steps');
            expect(ctx.textOverride).toContain('confined to the assigned project workspace');
            expect(ctx.textOverride).toContain('Do not mark the goal complete until successful host Observations');
            await ctx.onTransportStart();
            await ctx.onTransportAccepted();
            await ctx.onTransportComplete({ text: 'Goal work accepted.' });
            await ctx.reply('Goal work accepted.');
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: '持續處理此專案，直到驗證目標完成。',
            goalMode: true,
            maxActionDepth: 999,
            autoTurnBudget: { used: 99, limit: 999 },
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
    });

    test('accepts Copilot title metadata for a placeholder conversation and broadcasts the rename', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.workspaceConversationTitleRequested).toBe(true);
            expect(ctx.textOverride).toContain('[USER_REQUEST]\n幫我整理 OneDrive 的專案資料夾\n[/USER_REQUEST]');
            await ctx.onTransportComplete({ text: 'M365 answer' });
            await ctx.onGolemConversationTitle({
                conversationTitle: '整理 OneDrive 專案檔案',
                isSystemFeedback: false,
            });
            await ctx.reply('M365 answer');
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: '幫我整理 OneDrive 的專案資料夾',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(mockStore.updateConversationTitleIfPlaceholder).toHaveBeenCalledWith(
            'conversation-1',
            '整理 OneDrive 專案檔案'
        );
        expect(serverContext.broadcastLog).toHaveBeenCalledWith(expect.objectContaining({
            type: 'conversation_title',
            raw: '整理 OneDrive 專案檔案',
            conversationId: 'conversation-1',
            transient: true,
        }));
    });

    test('does not ask for or apply an AI title after the user has named the conversation', async () => {
        mockStore.getConversation.mockResolvedValue({
            id: 'conversation-1',
            projectId: 'project-1',
            title: '使用者手動名稱',
            status: 'active',
            bindingState: 'bound',
            projectContextVersion: 1,
            remoteConversationId: 'remote-1',
            remoteConversationUrl: 'https://m365.cloud.microsoft/chat/conversation/remote-1',
        });
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.workspaceConversationTitleRequested).toBe(false);
            await ctx.onGolemConversationTitle({
                conversationTitle: 'Copilot 想改的名稱',
                isSystemFeedback: false,
            });
            await ctx.onTransportComplete({ text: 'M365 answer' });
            await ctx.reply('M365 answer');
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: '繼續',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(mockStore.updateConversationTitleIfPlaceholder).not.toHaveBeenCalled();
    });

    test('expands an M365 prompt-pool shortcut for dispatch while preserving the user-visible text', async () => {
        mockExpandPromptShortcutInput.mockReturnValueOnce({
            changed: true,
            text: '請整理本週工作，列出完成事項與下週風險。\n補充客戶 A。',
            matched: { shortcut: '/weekly', shortcutKey: 'weekly' },
        });
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.toolRoutingQuery).toBe('請整理本週工作，列出完成事項與下週風險。\n補充客戶 A。');
            expect(ctx.textOverride).toContain('請整理本週工作，列出完成事項與下週風險。');
            expect(ctx.textOverride).toContain('補充客戶 A。');
            expect(ctx.m365PromptShortcutExpanded).toBe(true);
            await ctx.onTransportComplete({ text: 'M365 answer' });
            await ctx.reply('M365 answer');
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: '/weekly 補充客戶 A。',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(mockStore.addMessage).toHaveBeenNthCalledWith(1, 'conversation-1', expect.objectContaining({
            content: '/weekly 補充客戶 A。',
        }));
        expect(mockRecordM365PromptPoolUse).toHaveBeenCalledWith(expect.objectContaining({
            shortcut: '/weekly',
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

    test('requires a real project-memory write for explicit project rules and lessons', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.workspaceProjectMemoryRequired).toBe(true);
            expect(ctx.textOverride).toContain('[PROJECT_MEMORY_POLICY]');
            expect(ctx.textOverride).toContain('memory_write=required');
            expect(ctx.textOverride).toContain('lessons or pitfalls that should not be repeated');
            expect(ctx.textOverride).toContain('golem-memory <specific question>');
            await ctx.onTransportComplete({ text: 'M365 answer' });
            await ctx.reply('M365 answer');
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: '請記住這個專案之前踩過的坑，以後不要再次重複。',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
    });

    test('refreshes the project-memory card without adding a chat message', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            await ctx.onProjectMemoryUpdated({ updatedCount: 2 });
            await ctx.onTransportComplete({ text: '完整的 Copilot 回覆' });
            await ctx.reply('完整的 Copilot 回覆');
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: '列出資料夾內容。',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(serverContext.broadcastLog).toHaveBeenCalledWith(expect.objectContaining({
            type: 'project_memory_updated',
            raw: '',
            conversationId: 'conversation-1',
            transient: true,
        }));
        expect(mockStore.addMessage).toHaveBeenCalledTimes(2);
        expect(mockStore.addMessage).toHaveBeenLastCalledWith('conversation-1', expect.objectContaining({
            role: 'assistant',
            content: '完整的 Copilot 回覆',
        }));
    });

    test('rejects unassigned or cross-project references before reading content or dispatching', async () => {
        mockStore.listProjectReferences.mockResolvedValue([]);
        const result = await postChat({ golemId: 'golem_A', projectId: 'project-1', conversationId: 'conversation-1', message: 'synthetic', referenceFileIds: ['other-project-reference'] });
        expect(result.response.status).toBe(403);
        expect(mockReferenceFileService.read).not.toHaveBeenCalled();
        expect(mockHandleDashboardMessage).not.toHaveBeenCalled();
        expect(mockStore.addMessage).not.toHaveBeenCalled();
    });

    test('keeps host continuation controls out of the visible user history', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.m365InternalControl).toBe(true);
            expect(ctx.toolRoutingQuery).toBe('建立 Word 報告');
            expect(ctx.textOverride).toContain('[USER_REQUEST]');
            expect(ctx.textOverride).toContain('[GOLEM_PLAN_CONTROL]internal[/GOLEM_PLAN_CONTROL]');
            expect(ctx.textOverride).not.toContain('[USER_REQUEST]\n建立 Word 報告\n[/USER_REQUEST]');
            const meta = { isSystemFeedback: true, workspaceRunId: 'run-1' };
            await ctx.onTransportStart(meta);
            await ctx.onTransportAccepted(meta);
            await ctx.onTransportComplete({ text: 'corrected response' }, meta);
            await ctx.reply('corrected response');
        });

        await serverContext.dispatchM365WorkspaceMessage({
            golemId: 'golem_A', projectId: 'project-1', conversationId: 'conversation-1',
            message: '[GOLEM_PLAN_CONTROL]internal[/GOLEM_PLAN_CONTROL]',
            runId: 'run-1', planId: 'run-1', planRevision: 1,
            internalControl: true, toolRoutingQuery: '建立 Word 報告',
        });
        await waitFor(() => serverContext.m365DispatchLease === null);

        expect(mockStore.addMessage).toHaveBeenCalledTimes(1);
        expect(mockStore.addMessage).toHaveBeenCalledWith('conversation-1', expect.objectContaining({
            role: 'assistant', content: 'corrected response', runId: 'run-1',
        }));
        expect(serverContext.broadcastLog.mock.calls.some(([item]) => String(item.raw || '').startsWith('[User]'))).toBe(false);
    });

    test('preserves user clarification inside an internal autonomous-plan continuation', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.m365InternalControl).toBe(true);
            expect(ctx.toolRoutingQuery).toBe('確認資料夾內有哪些檔案');
            expect(ctx.textOverride).toContain('[GOLEM_PLAN_CONTROL]');
            expect(ctx.textOverride).toContain('[USER_CONTINUATION_INPUT]');
            expect(ctx.textOverride).toContain('請讀取第一張圖片內容');
            expect(ctx.textOverride).toContain('[/USER_CONTINUATION_INPUT]');
            await ctx.onTransportStart({ isSystemFeedback: true, workspaceRunId: 'run-1' });
            await ctx.onTransportAccepted({ isSystemFeedback: true, workspaceRunId: 'run-1' });
            await ctx.onTransportComplete({ text: 'continued response' }, { isSystemFeedback: true, workspaceRunId: 'run-1' });
            await ctx.reply('continued response');
        });

        await serverContext.dispatchM365WorkspaceMessage({
            golemId: 'golem_A', projectId: 'project-1', conversationId: 'conversation-1',
            message: [
                '[GOLEM_PLAN_CONTROL]',
                'Resume the active plan.',
                '[USER_CONTINUATION_INPUT]',
                '請讀取第一張圖片內容',
                '[/USER_CONTINUATION_INPUT]',
                '[/GOLEM_PLAN_CONTROL]',
            ].join('\n'),
            runId: 'run-1', planId: 'run-1', planRevision: 2,
            internalControl: true, toolRoutingQuery: '確認資料夾內有哪些檔案',
        });
        await waitFor(() => serverContext.m365DispatchLease === null);

        expect(mockStore.addMessage).toHaveBeenCalledTimes(1);
        expect(mockStore.addMessage).toHaveBeenCalledWith('conversation-1', expect.objectContaining({
            role: 'assistant', content: 'continued response', runId: 'run-1',
        }));
    });

    test('preserves a host Observation instead of replacing it with the routing objective', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.m365InternalControl).toBe(true);
            expect(ctx.toolRoutingQuery).toBe('讀取圖片內容');
            expect(ctx.textOverride).toContain('[GOLEM_OBSERVATION]');
            expect(ctx.textOverride).toContain('Attachment receipt: p4_invoice.png');
            expect(ctx.textOverride).toContain('[/GOLEM_OBSERVATION]');
            await ctx.onTransportStart({ isSystemFeedback: true, workspaceRunId: 'run-1' });
            await ctx.onTransportAccepted({ isSystemFeedback: true, workspaceRunId: 'run-1' });
            await ctx.onTransportComplete({ text: 'observation response' }, { isSystemFeedback: true, workspaceRunId: 'run-1' });
            await ctx.reply('observation response');
        });

        await serverContext.dispatchM365WorkspaceMessage({
            golemId: 'golem_A', projectId: 'project-1', conversationId: 'conversation-1',
            message: '[GOLEM_OBSERVATION]\nAttachment receipt: p4_invoice.png\n[/GOLEM_OBSERVATION]',
            runId: 'run-1', planId: 'run-1', planRevision: 3,
            internalControl: true, toolRoutingQuery: '讀取圖片內容',
        });
        await waitFor(() => serverContext.m365DispatchLease === null);

        expect(mockStore.addMessage).toHaveBeenCalledTimes(1);
        expect(mockStore.addMessage).toHaveBeenCalledWith('conversation-1', expect.objectContaining({
            role: 'assistant', content: 'observation response', runId: 'run-1',
        }));
    });

    test('does not honor an external request to hide a user message as internal control', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.m365InternalControl).toBe(false);
            expect(ctx.workspaceMaxActionDepth).toBeUndefined();
            expect(ctx.workspaceAutoTurnBudget).toBeUndefined();
            await ctx.onTransportStart({ isSystemFeedback: false });
            await ctx.onTransportAccepted({ isSystemFeedback: false });
            await ctx.onTransportComplete({ text: 'answer' }, { isSystemFeedback: false });
            await ctx.reply('answer');
        });
        const result = await postChat({
            golemId: 'golem_A', projectId: 'project-1', conversationId: 'conversation-1',
            message: 'normal visible request', internalControl: true,
            maxActionDepth: 999,
            autoTurnBudget: { used: 99, limit: 999 },
        });
        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(mockStore.addMessage).toHaveBeenNthCalledWith(1, 'conversation-1', expect.objectContaining({
            role: 'user', content: 'normal visible request',
        }));
    });

    test('keeps a prose-only Copilot answer visible and does not create a run without GOLEM_PLAN', async () => {
        const startExecutionContract = jest.fn();
        serverContext.m365RunCoordinator = {
            init: jest.fn().mockResolvedValue(),
            startExecutionContract,
            handleAutonomousPlan: jest.fn(),
            requestProtocolRepair: jest.fn(),
        };
        const copilotAnswer = 'SharePoint Request Files 與共用資料夾的差異如下；也可以先建立 metadata 欄位，再由人工確認辨識結果。';
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            const result = await ctx.onGolemProtocolResponse({
                rawResponse: copilotAnswer,
                parsed: { reply: copilotAnswer, actions: [] },
                actionCount: 0,
                isSystemFeedback: false,
            });
            expect(result).toBeNull();
            await ctx.reply(copilotAnswer);
        });

        const result = await postChat({
            golemId: 'golem_A', projectId: 'project-1', conversationId: 'conversation-1',
            message: '請說明 SharePoint Request Files 是否適合客戶上傳及 metadata 設計',
        });
        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(startExecutionContract).not.toHaveBeenCalled();
        expect(mockStore.addMessage).toHaveBeenNthCalledWith(2, 'conversation-1', expect.objectContaining({
            role: 'assistant',
            content: copilotAnswer,
            runId: null,
        }));
    });

    test('routes a visible M365 file result without a plan into same-run control repair', async () => {
        const requestProtocolRepair = jest.fn().mockResolvedValue({
            accepted: false,
            planMode: true,
            runId: 'run-reconcile-1',
            planId: 'run-reconcile-1',
            planRevision: 8,
            protocolRepair: {
                status: 'retry',
                prompt: 'restore plan only',
                preserveVisibleResult: true,
            },
        });
        serverContext.m365RunCoordinator = {
            init: jest.fn().mockResolvedValue(),
            requestProtocolRepair,
            handleAutonomousPlan: jest.fn(),
            startExecutionContract: jest.fn(),
            getRunLocalFolders: jest.fn(() => []),
        };
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            const result = await ctx.onGolemProtocolResponse({
                rawResponse: '[GOLEM_REPLY]Word 已完成[/GOLEM_REPLY]',
                parsed: { reply: 'Word 已完成', actions: [] },
                actionCount: 0,
                downloadAttachmentCount: 1,
                responseStatus: 'ENVELOPE_COMPLETE',
                isSystemFeedback: false,
            });
            expect(result).toEqual(expect.objectContaining({ runId: 'run-reconcile-1' }));
            await ctx.reply('Word 已完成', {
                attachments: [{ name: 'report.docx', url: 'https://contoso.sharepoint.com/Doc.aspx?file=report.docx' }],
            });
        });

        const result = await postChat({
            golemId: 'golem_A', projectId: 'project-1', conversationId: 'conversation-1',
            runId: 'run-reconcile-1',
            message: '請補回剛才產生的 Word 結果',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(requestProtocolRepair).toHaveBeenCalledWith({
            runId: 'run-reconcile-1',
            kind: 'visible_result_recovered',
        });
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
            entry: 'index.js',
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
            expect(ctx.m365ResponseMode).toBe('thoughtful');
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

    test('passes selected folders as scoped on-demand references without reading or uploading files', async () => {
        const selectedFolder = {
            id: 'folder_1',
            name: 'Reports',
            path: 'C:\\Selected\\Reports',
        };
        mockStore.getDraft.mockResolvedValue({ localFolders: [selectedFolder] });
        mockLocalFolderService.resolveSelectedReferences.mockReturnValue([selectedFolder]);
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.textOverride).toContain('[USER_SELECTED_LOCAL_FOLDERS]');
            expect(ctx.textOverride).toContain('C:\\\\Selected\\\\Reports');
            expect(ctx.textOverride).toContain('golem-folder list <id>');
            expect(ctx.textOverride).toContain('golem-folder list folder_1 .');
            expect(ctx.textOverride).toContain('"action":"command"');
            expect(ctx.textOverride).toContain('No files were uploaded, enumerated, indexed, or read');
            expect(ctx.textOverride).not.toContain('[本輪已附加檔案]');
            expect(ctx.workspaceLocalFolders).toEqual([selectedFolder]);
            expect(ctx.m365LocalFolderService).toBe(mockLocalFolderService);
            expect(ctx.toolRoutingQuery).toContain('bounded local command');
            await ctx.onTransportStart();
            await ctx.onTransportAccepted();
            await ctx.onTransportComplete({ text: 'Folder inspected on demand.' });
            await ctx.reply('Folder inspected on demand.');
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: '找出資料夾內的報告。',
            selectedLocalFolderIds: ['folder_1'],
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(mockStore.getDraft).toHaveBeenCalledWith('project-1', 'conversation-1');
        expect(mockLocalFolderService.resolveSelectedReferences).toHaveBeenCalledWith(
            ['folder_1'],
            [selectedFolder]
        );
        expect(mockStore.addMessage).toHaveBeenNthCalledWith(1, 'conversation-1', expect.objectContaining({
            content: expect.stringContaining('📁 Reports（按需讀取，未上傳檔案）'),
        }));
    });

    test('keeps the scoped folder reference available during an internal multi-step continuation', async () => {
        const selectedFolder = {
            id: 'folder_1',
            name: 'Reports',
            path: 'C:\\Selected\\Reports',
        };
        serverContext.m365RunCoordinator = {
            getRunLocalFolders: jest.fn(() => [selectedFolder]),
        };
        mockLocalFolderService.validateReferences.mockReturnValue([selectedFolder]);
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.m365InternalControl).toBe(true);
            expect(ctx.workspaceRunId).toBe('run-folder-1');
            expect(ctx.workspaceLocalFolders).toEqual([selectedFolder]);
            expect(ctx.textOverride).toContain('[USER_SELECTED_LOCAL_FOLDERS]');
            await ctx.onTransportStart({ isSystemFeedback: true });
            await ctx.onTransportAccepted({ isSystemFeedback: true });
            await ctx.onTransportComplete({ text: 'continued' }, { isSystemFeedback: true });
            await ctx.reply('continued');
        });

        const result = await serverContext.dispatchM365WorkspaceMessage({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Continue the saved plan.',
            runId: 'run-folder-1',
            internalControl: true,
            toolRoutingQuery: 'Inspect reports.',
        });

        expect(result).toEqual(expect.objectContaining({ success: true }));
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(serverContext.m365RunCoordinator.getRunLocalFolders).toHaveBeenCalledWith('run-folder-1');
        expect(mockLocalFolderService.validateReferences).toHaveBeenCalledWith([selectedFolder]);
        expect(mockStore.getDraft).not.toHaveBeenCalled();
    });

    test('preserves a fresh automatic-turn allowance reset during internal continuation', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            expect(ctx.m365InternalControl).toBe(true);
            expect(ctx.workspaceAutoTurnBudget).toEqual({ used: 0, limit: 6, reset: true });
            await ctx.onTransportStart({ isSystemFeedback: true });
            await ctx.onTransportAccepted({ isSystemFeedback: true });
            await ctx.onTransportComplete({ text: 'continued' }, { isSystemFeedback: true });
            await ctx.reply('continued');
        });

        const result = await serverContext.dispatchM365WorkspaceMessage({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Continue the saved automatic work.',
            runId: 'run-auto-1',
            internalControl: true,
            autoTurnBudget: { used: 0, limit: 6, reset: true },
        });

        expect(result).toEqual(expect.objectContaining({ success: true }));
        await waitFor(() => serverContext.m365DispatchLease === null);
    });

    test('marks a native response-mode failure as unsent without requiring reconciliation', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            const error = new Error('The native response mode was not confirmed.');
            error.code = 'M365_RESPONSE_MODE_UNAVAILABLE';
            await ctx.onTransportError(error);
            await ctx.reply(`⚠️ ${error.message}`);
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Use deep thinking.',
            responseMode: 'thoughtful',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(mockStore.updateMessageDeliveryState).toHaveBeenCalledWith('user-message-1', 'failed');
        expect(mockMarkReconcile).not.toHaveBeenCalled();
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

    test('does not overwrite the confirmed user turn when an internal Observation is blocked before dispatch', async () => {
        mockHandleDashboardMessage.mockImplementation(async (ctx) => {
            const primaryMeta = { isSystemFeedback: false };
            await ctx.onTransportStart(primaryMeta);
            await ctx.onTransportAccepted(primaryMeta);
            await ctx.onTransportComplete({ text: 'First M365 answer' }, primaryMeta);
            await ctx.reply('First M365 answer');

            const observationMeta = {
                isSystemFeedback: true,
                workspaceRunId: 'run-1',
                workspaceStepId: 'step-1',
            };
            await ctx.onTransportStart(observationMeta);
            const error = new Error('Conversation requires reconciliation.');
            error.code = 'M365_RECONCILIATION_REQUIRED';
            await ctx.onTransportError(error, observationMeta);
            await ctx.reply(`⚠️ ${error.message}`);
        });

        const result = await postChat({
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            message: 'Run a multi-step task.',
        });

        expect(result.response.status).toBe(200);
        await waitFor(() => serverContext.m365DispatchLease === null);
        expect(mockStore.updateMessageDeliveryState).toHaveBeenCalledWith('user-message-1', 'confirmed');
        expect(mockStore.updateMessageDeliveryState).not.toHaveBeenCalledWith('user-message-1', 'failed');
        expect(mockStore.updateMessageDeliveryState).not.toHaveBeenCalledWith('user-message-1', 'ambiguous');
        expect(mockMarkReconcile).not.toHaveBeenCalled();
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
        const dispatchedContext = mockHandleDashboardMessage.mock.calls.at(-1)[0];
        expect(dispatchedContext.textOverride).toContain('已直接附加到目前的 Microsoft 365 Copilot 草稿');
        expect(dispatchedContext.textOverride).toContain('不要為了取得 host Observation 而執行工作目錄、echo、dir');
        expect(dispatchedContext.textOverride).toContain('不要為這些檔名呼叫 reference-files');

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
