jest.mock('../src/utils/ResponseParser');
jest.mock('../src/core/action_handlers/MultiAgentHandler');
jest.mock('../src/core/action_handlers/SkillHandler');
jest.mock('../src/core/action_handlers/CommandHandler');
jest.mock('../src/managers/SkillManager', () => ({
    getSkill: jest.fn(() => null),
    listSkills: jest.fn(() => []),
}));

const { NeuroShunter } = require('../packages/protocol');
const ResponseParser = require('../src/utils/ResponseParser');
const MultiAgentHandler = require('../src/core/action_handlers/MultiAgentHandler');
const SkillHandler = require('../src/core/action_handlers/SkillHandler');
const CommandHandler = require('../src/core/action_handlers/CommandHandler');
const { getAutomationModePreset } = require('../src/config/AutomationModes');

const AUTOMATION_ENV_KEYS = [
    'GOLEM_AUTO_APPROVE_ALL',
    'GOLEM_SILENT_AUTO_APPROVE',
    'GOLEM_TRUST_SYSTEM_COMMANDS',
    'GOLEM_STRICT_SAFEGUARD',
    'GOLEM_MAX_AUTO_TURNS',
    'GOLEM_INTERVENTION_LEVEL',
    'AUTONOMY_LEVEL',
];

describe('NeuroShunter M365 safety gates', () => {
    let previousAutomationEnv;

    beforeEach(() => {
        jest.clearAllMocks();
        previousAutomationEnv = Object.fromEntries(
            AUTOMATION_ENV_KEYS.map((key) => [key, process.env[key]])
        );
        Object.assign(process.env, getAutomationModePreset('guided'));
    });

    afterEach(() => {
        for (const key of AUTOMATION_ENV_KEYS) {
            if (previousAutomationEnv[key] === undefined) delete process.env[key];
            else process.env[key] = previousAutomationEnv[key];
        }
    });

    test('blocks model actions and memory writes when backend gates are closed', async () => {
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
        };
        const brain = {
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => false),
            isLocalContextEnabled: jest.fn(() => false),
        };
        ResponseParser.parse.mockReturnValue({
            memory: 'tenant secret',
            reply: 'Safe text reply',
            actions: [{ action: 'command', parameter: 'whoami' }],
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, {});

        expect(ctx.reply).toHaveBeenCalledWith('Safe text reply');
        expect(brain.memorize).not.toHaveBeenCalled();
        expect(MultiAgentHandler.execute).not.toHaveBeenCalled();
        expect(SkillHandler.execute).not.toHaveBeenCalled();
        expect(CommandHandler.execute).not.toHaveBeenCalled();
    });

    test('forwards hidden conversation-title metadata even when tool actions are disabled', async () => {
        const onGolemConversationTitle = jest.fn().mockResolvedValue({ changed: true });
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            onGolemConversationTitle,
        };
        const brain = {
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => false),
            isLocalContextEnabled: jest.fn(() => false),
        };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            conversationTitle: '整理 OneDrive 專案檔案',
            reply: '我來幫你確認。',
            actions: [],
        });

        await NeuroShunter.dispatch(ctx, 'raw-title-response', brain, {});

        expect(onGolemConversationTitle).toHaveBeenCalledWith({
            conversationTitle: '整理 OneDrive 專案檔案',
            isSystemFeedback: false,
        });
        expect(ctx.reply).toHaveBeenCalledWith('我來幫你確認。');
        expect(ctx.reply.mock.calls.flat().join('\n')).not.toContain('GOLEM_CONVERSATION_TITLE');
    });

    test('pauses enabled M365 actions in the original pending task gate', async () => {
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-1',
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '我準備使用工具，請核准。',
            actions: [{ action: 'mcp_call', server: 'demo', tool: 'read', parameters: {} }],
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, controller);

        expect(controller.pendingTasks.size).toBe(1);
        expect([...controller.pendingTasks.values()][0]).toEqual(expect.objectContaining({
            type: 'M365_ACTION_APPROVAL',
            ctx,
            proposedActions: expect.any(Array),
        }));
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining('待你在右側'),
            expect.objectContaining({ reply_markup: expect.any(Object) })
        );
        expect(SkillHandler.execute).not.toHaveBeenCalled();
        expect(CommandHandler.execute).not.toHaveBeenCalled();
    });

    test('balanced mode describes the actual action instead of the plan-step title', async () => {
        Object.assign(process.env, getAutomationModePreset('balanced'));
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-progress-1',
            onGolemProtocolResponse: jest.fn().mockResolvedValue({
                accepted: true,
                allowActions: true,
                planMode: true,
                runId: 'run-progress-1',
                stepId: 'host-step-progress-1',
                actionId: 'action-progress-1',
                planId: 'run-progress-1',
                planRevision: 1,
                planStepId: 'step_1',
                maxActionDepth: 12,
            }),
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '',
            plan: {
                steps: [{ id: 'step_1', title: '準備整份專案報告', status: 'in_progress' }],
            },
            actions: [{ action: 'command', parameter: 'cat README.md', progress: '讀取專案說明並核對內容' }],
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, controller);

        expect(controller.pendingTasks.size).toBe(0);
        expect(CommandHandler.execute).toHaveBeenCalledTimes(1);
        expect(SkillHandler.execute).not.toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledWith('讀取專案說明並核對內容，正在執行並確認中…');
        expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining('準備整份專案報告'));
    });

    test('dispatches a multi-command plan step as one ordered command sequence', async () => {
        Object.assign(process.env, getAutomationModePreset('autopilot'));
        const actions = [
            { action: 'command', parameter: 'echo first > weekly_report.py', progress: '寫入程式第一段內容' },
            { action: 'command', parameter: 'echo second >> weekly_report.py', progress: '接續寫入程式內容' },
            { action: 'command', parameter: 'python weekly_report.py', progress: '執行程式並核對結果' },
        ];
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-batch-1',
            onGolemProtocolResponse: jest.fn().mockResolvedValue({
                accepted: true,
                allowActions: true,
                planMode: true,
                runId: 'run-batch-1',
                stepId: 'host-step-batch-1',
                actionId: 'action-batch-1',
                planId: 'run-batch-1',
                planRevision: 1,
                planStepId: 'step_1',
                maxActionDepth: 12,
            }),
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '',
            plan: { steps: [{ id: 'step_1', title: '重建並驗證程式', status: 'in_progress' }] },
            actions,
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, controller);

        expect(ctx.onGolemProtocolResponse).toHaveBeenCalledWith(expect.objectContaining({
            actionCount: 3,
        }));
        expect(CommandHandler.execute).toHaveBeenCalledTimes(1);
        expect(CommandHandler.execute.mock.calls[0][1]).toEqual(actions);
        expect(ctx.reply).toHaveBeenCalledWith('執行本步驟的 3 個動作，正在執行並確認中…');
    });

    test('balanced mode still asks before MCP or Skill execution', async () => {
        Object.assign(process.env, getAutomationModePreset('balanced'));
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '',
            actions: [{ action: 'mcp_call', server: 'demo', tool: 'read', parameters: {} }],
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, controller);

        expect(controller.pendingTasks.size).toBe(1);
        expect(SkillHandler.execute).not.toHaveBeenCalled();
        expect(CommandHandler.execute).not.toHaveBeenCalled();
    });

    test('binds a Copilot-authored plan step to the pending Action Gate item', async () => {
        const onGolemProtocolResponse = jest.fn().mockResolvedValue({
            accepted: true,
            allowActions: true,
            planMode: true,
            runId: 'run-1',
            stepId: 'host-step-1',
            planId: 'run-1',
            planRevision: 1,
            planStepId: 'step_1',
            actionId: 'action-1',
            maxActionDepth: 6,
        });
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-plan-1',
            onGolemProtocolResponse,
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '正在執行第一步。',
            plan: {
                schemaVersion: 'golem_plan/1',
                planId: null,
                revision: 1,
                status: 'running',
                currentStepId: 'step_1',
                steps: [{ id: 'step_1', title: '檢查', status: 'in_progress', doneWhen: '取得 Observation' }],
            },
            actions: [{ action: 'command', parameter: 'dir' }],
        });

        await NeuroShunter.dispatch(ctx, 'raw-plan-response', brain, controller);

        expect(onGolemProtocolResponse).toHaveBeenCalledWith(expect.objectContaining({
            rawResponse: 'raw-plan-response',
            actionCount: 1,
            isSystemFeedback: false,
        }));
        const pending = [...controller.pendingTasks.values()][0];
        expect(pending).toEqual(expect.objectContaining({
            type: 'M365_ACTION_APPROVAL',
            proposedActions: [{ action: 'command', parameter: 'dir' }],
            dispatchOptions: expect.objectContaining({
                planMode: true,
                workspaceRunId: 'run-1',
                workspaceStepId: 'host-step-1',
                workspacePlanId: 'run-1',
                workspacePlanRevision: 1,
                workspacePlanStepId: 'step_1',
                workspaceActionId: 'action-1',
            }),
        }));
        expect(ctx.reply).toHaveBeenCalledTimes(1);
        expect(ctx.reply.mock.calls.flat().join('\n')).not.toContain('正在執行並確認中');
        expect(ctx.reply.mock.calls.flat().join('\n')).not.toContain('等待 Harness 核准與回傳結果');
        expect(CommandHandler.execute).not.toHaveBeenCalled();
    });

    test('turns a native Copilot plan checkpoint into a bound Observation without user approval', async () => {
        const onGolemProtocolResponse = jest.fn().mockResolvedValue({
            accepted: true,
            allowActions: true,
            planMode: true,
            runId: 'run-native-1',
            stepId: 'host-step-native-1',
            planId: 'run-native-1',
            planRevision: 1,
            planStepId: 'step_1',
            actionId: 'action-native-1',
            maxActionDepth: 6,
        });
        const onGolemObservation = jest.fn().mockResolvedValue({
            run: { status: 'RUNNING' },
            planId: 'run-native-1',
            planRevision: 1,
        });
        const convoManager = { enqueue: jest.fn().mockResolvedValue() };
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-native-1',
            onGolemProtocolResponse,
            onGolemObservation,
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map(), convoManager };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '我已用原生能力完成第一段分析。',
            plan: {
                schemaVersion: 'golem_plan/1',
                planId: null,
                revision: 1,
                status: 'running',
                currentStepId: 'step_1',
                steps: [{ id: 'step_1', title: '原生分析', status: 'in_progress', doneWhen: '輸出分析結果' }],
            },
            actions: [{
                action: 'plan_checkpoint',
                summary: '已完成第一段分析',
                evidence: ['本輪 GOLEM_REPLY 已呈現分析結果'],
            }],
        });

        await NeuroShunter.dispatch(ctx, 'raw-native-plan-response', brain, controller);

        expect(controller.pendingTasks.size).toBe(0);
        expect(onGolemObservation).toHaveBeenCalledWith(expect.objectContaining({
            runId: 'run-native-1',
            stepId: 'host-step-native-1',
            actionId: 'action-native-1',
            planStepId: 'step_1',
            lane: 'plan_checkpoint',
            status: 'succeeded',
        }));
        expect(convoManager.enqueue).toHaveBeenCalledWith(
            ctx,
            expect.stringContaining('[GOLEM_OBSERVATION]'),
            expect.objectContaining({
                isSystemFeedback: true,
                planMode: true,
                allowActions: true,
                workspacePlanId: 'run-native-1',
            })
        );
        expect(SkillHandler.execute).not.toHaveBeenCalled();
        expect(CommandHandler.execute).not.toHaveBeenCalled();
    });

    test('writes scoped project and user memory automatically without creating an approval task', async () => {
        const projectMemoryService = {
            applyMemoryBlock: jest.fn(() => ({ results: [{ changed: true }] })),
        };
        const userProfile = {
            applyM365MemoryBlock: jest.fn(() => [{ changed: true }]),
        };
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceProjectId: 'project-1',
            workspaceConversationId: 'conversation-1',
            workspaceRequestId: 'request-1',
            workspaceRoot: 'C:\\workspaces\\project-1',
            m365ProjectWorkspaceService: projectMemoryService,
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            userProfile,
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            projectMemory: '[{"operation":"upsert","kind":"rule","content":"Keep evidence visible."}]',
            userMemory: '[{"operation":"set","path":"communication.responseLength","value":"brief"}]',
            reply: '我已保留跨對話仍需沿用的規則。',
            actions: [],
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, controller);

        expect(controller.pendingTasks.size).toBe(0);
        expect(projectMemoryService.applyMemoryBlock).toHaveBeenCalledWith(
            'project-1',
            expect.any(String),
            {
                conversationId: 'conversation-1',
                requestId: 'request-1',
                workspacePath: 'C:\\workspaces\\project-1',
            }
        );
        expect(userProfile.applyM365MemoryBlock).toHaveBeenCalledTimes(1);
        expect(brain.memorize).not.toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('我已保留跨對話仍需沿用的規則。'));
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('已更新此專案的狀態紀錄（1 則）'));
    });

    test('repairs an explicit project-memory turn when Copilot only promises to remember it', async () => {
        const enqueue = jest.fn().mockResolvedValue();
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceProjectId: 'project-1',
            workspaceConversationId: 'conversation-1',
            workspaceProjectMemoryRequired: true,
            toolRoutingQuery: '記住這個專案不要再次踩坑。',
            m365ProjectWorkspaceService: { applyMemoryBlock: jest.fn() },
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            projectMemory: null,
            reply: '好的，我會記住。',
            actions: [],
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, { pendingTasks: new Map(), convoManager: { enqueue } });

        expect(ctx.reply).not.toHaveBeenCalledWith('好的，我會記住。');
        expect(enqueue).toHaveBeenCalledWith(
            ctx,
            expect.stringContaining('[GOLEM_PROJECT_MEMORY_REPAIR]'),
            expect.objectContaining({
                allowActions: false,
                m365ProjectMemoryRequired: true,
                projectMemoryRepairAttempt: 1,
                workspaceConversationId: 'conversation-1',
            })
        );
    });

    test('warns after one failed project-memory repair instead of looping', async () => {
        const enqueue = jest.fn().mockResolvedValue();
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceProjectId: 'project-1',
            workspaceConversationId: 'conversation-1',
            workspaceProjectMemoryRequired: true,
            m365ProjectWorkspaceService: { applyMemoryBlock: jest.fn() },
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            projectMemory: '[]',
            reply: '已處理。',
            actions: [],
        });

        await NeuroShunter.dispatch(
            ctx,
            'raw',
            brain,
            { pendingTasks: new Map(), convoManager: { enqueue } },
            { m365ProjectMemoryRequired: true, projectMemoryRepairAttempt: 1 }
        );

        expect(enqueue).not.toHaveBeenCalled();
        expect(ctx.m365ProjectWorkspaceService.applyMemoryBlock).not.toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('模型沒有提供可寫入的專案紀錄'));
    });

    test('repairs malformed project memory instead of accepting it as recorded', async () => {
        const enqueue = jest.fn().mockResolvedValue();
        const applyMemoryBlock = jest.fn(() => {
            const error = new Error('Project memory must be valid JSON.');
            error.code = 'M365_PROJECT_MEMORY_FORMAT_INVALID';
            throw error;
        });
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceProjectId: 'project-1',
            workspaceConversationId: 'conversation-1',
            workspaceProjectMemoryRequired: true,
            m365ProjectWorkspaceService: { applyMemoryBlock },
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            projectMemory: '[{"operation":"upsert"',
            reply: '已記住。',
            actions: [],
        });

        await NeuroShunter.dispatch(
            ctx,
            'raw',
            brain,
            { pendingTasks: new Map(), convoManager: { enqueue } }
        );

        expect(applyMemoryBlock).toHaveBeenCalledTimes(1);
        expect(ctx.reply).not.toHaveBeenCalledWith('已記住。');
        expect(enqueue).toHaveBeenCalledWith(
            ctx,
            expect.stringContaining('failed host validation'),
            expect.objectContaining({ projectMemoryRepairAttempt: 1 })
        );
    });

    test('does not delay a real action when the same turn still owes a project-memory update', async () => {
        Object.assign(process.env, getAutomationModePreset('balanced'));
        const enqueue = jest.fn().mockResolvedValue();
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceProjectId: 'project-1',
            workspaceConversationId: 'conversation-1',
            workspaceProjectMemoryRequired: true,
            m365ProjectWorkspaceService: { applyMemoryBlock: jest.fn() },
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            projectMemory: null,
            reply: '',
            actions: [{ action: 'command', parameter: 'cat README.md', progress: '讀取專案說明並核對內容' }],
        });

        await NeuroShunter.dispatch(
            ctx,
            'raw',
            brain,
            { pendingTasks: new Map(), convoManager: { enqueue } }
        );

        expect(CommandHandler.execute).toHaveBeenCalledTimes(1);
        expect(enqueue).not.toHaveBeenCalledWith(
            ctx,
            expect.stringContaining('[GOLEM_PROJECT_MEMORY_REPAIR]'),
            expect.any(Object)
        );
    });

    test('rejects scoped memory protocols outside an active M365 project conversation', async () => {
        const projectMemoryService = {
            applyMemoryBlock: jest.fn(() => ({ results: [{ changed: true }] })),
        };
        const userProfile = {
            applyM365MemoryBlock: jest.fn(() => [{ changed: true }]),
        };
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            m365ProjectWorkspaceService: projectMemoryService,
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            userProfile,
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            projectMemory: '[{"operation":"upsert","kind":"rule","content":"Do not cross projects."}]',
            userMemory: '[{"operation":"set","path":"communication.responseLength","value":"brief"}]',
            reply: '一般回覆。',
            actions: [],
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, { pendingTasks: new Map() });

        expect(projectMemoryService.applyMemoryBlock).not.toHaveBeenCalled();
        expect(userProfile.applyM365MemoryBlock).not.toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('專案記憶未寫入'));
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('使用者偏好記憶未寫入'));
    });

    test('routes M365 inline protocol transitions through the real parser into approval', async () => {
        const actualParser = jest.requireActual('../src/utils/ResponseParser');
        ResponseParser.parse.mockImplementation((raw) => actualParser.parse(raw));
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-inline-action',
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        const raw =
            '[[BEGIN:ptnn]]\n' +
            '[GOLEM_REPLY]\n等待 Harness 核准與回傳結果。\n' +
            '[/GOLEM_REPLY] [GOLEM_ACTION]\n' +
            '```json\n' +
            '[{"action":"command","parameter":"echo %CD%"}]\n' +
            '```\n' +
            '[/GOLEM_ACTION] [[END:ptnn]]';

        await NeuroShunter.dispatch(ctx, raw, brain, controller);

        expect(controller.pendingTasks.size).toBe(1);
        expect([...controller.pendingTasks.values()][0]).toEqual(expect.objectContaining({
            type: 'M365_ACTION_APPROVAL',
            ctx,
            proposedActions: [
                { action: 'command', parameter: 'echo %CD%' },
            ],
        }));
        expect(CommandHandler.execute).not.toHaveBeenCalled();
    });

    test('routes an M365 action with rendered code line numbers into approval', async () => {
        const actualParser = jest.requireActual('../src/utils/ResponseParser');
        ResponseParser.parse.mockImplementation((raw) => actualParser.parse(raw));
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-numbered-action',
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        const raw =
            '[[BEGIN:ik75]]\n' +
            '[GOLEM_REPLY]正在等待核准。[/GOLEM_REPLY] [GOLEM_ACTION]\n' +
            '1\n[\n2\n{\n3\n' +
            '  "action": "command",\n' +
            '4\n  "parameter": "echo %CD%"\n' +
            '5\n}\n6\n]\n' +
            '[/GOLEM_ACTION] [[END:ik75]]';

        await NeuroShunter.dispatch(ctx, raw, brain, controller);

        expect(controller.pendingTasks.size).toBe(1);
        expect([...controller.pendingTasks.values()][0]).toEqual(expect.objectContaining({
            type: 'M365_ACTION_APPROVAL',
            ctx,
            proposedActions: [
                { action: 'command', parameter: 'echo %CD%' },
            ],
        }));
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining('待你在右側'),
            expect.objectContaining({ reply_markup: expect.any(Object) })
        );
        expect(CommandHandler.execute).not.toHaveBeenCalled();
    });

    test('executes an action only after the scoped M365 approval flag is present', async () => {
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        SkillHandler.execute.mockResolvedValue(true);
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '',
            actions: [{ action: 'mcp_call', server: 'demo', tool: 'read', parameters: {} }],
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, controller, { m365ActionApproved: true });

        expect(controller.pendingTasks.size).toBe(0);
        expect(SkillHandler.execute).toHaveBeenCalledTimes(1);
    });

    test('lets an explicitly selected installed Skill pass the per-turn toolset gate after approval', async () => {
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        SkillHandler.execute.mockResolvedValue(true);
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '',
            actions: [{ action: 'reference-files', args: { operation: 'list' } }],
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, controller, {
            m365ActionApproved: true,
            preferredSkillIds: ['reference-files'],
            preferredSkillActions: ['reference-files'],
        });

        expect(SkillHandler.execute).toHaveBeenCalledWith(
            ctx,
            expect.objectContaining({ action: 'reference-files' }),
            brain,
            controller,
            expect.any(Object)
        );
        expect(CommandHandler.execute).not.toHaveBeenCalled();
    });

    test('lets an M365 action continue through the existing safety gate when the user enabled auto approval', async () => {
        process.env.GOLEM_AUTO_APPROVE_ALL = 'true';
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map() };
        SkillHandler.execute.mockResolvedValue(true);
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '',
            actions: [{ action: 'mcp_call', server: 'demo', tool: 'read', parameters: {} }],
        });

        await NeuroShunter.dispatch(ctx, 'raw', brain, controller);

        expect(controller.pendingTasks.size).toBe(0);
        expect(SkillHandler.execute).toHaveBeenCalledTimes(1);
        expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining('待你在右側'), expect.anything());
    });

    test('replaces a narrated refusal and queues a bounded execution repair', async () => {
        const onGolemProtocolResponse = jest.fn().mockResolvedValue({
            accepted: false,
            allowActions: false,
            planMode: true,
            runId: 'run-repair-1',
            planId: null,
            planRevision: 0,
            maxActionDepth: 12,
            resetAutoTurnBudget: true,
            protocolRepair: {
                status: 'retry',
                prompt: '[GOLEM_EXECUTION_REPAIR]use the real tool[/GOLEM_EXECUTION_REPAIR]',
                toolRoutingQuery: '在工作區建立 Word 報告',
                message: '正在確認可用資源並準備執行…',
            },
        });
        const enqueue = jest.fn().mockResolvedValue();
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-1',
            onGolemProtocolResponse,
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map(), convoManager: { enqueue } };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '我沒有可驗證的 Word 建檔能力；如果你希望我可以嘗試。',
            actions: [],
        });

        const toolRoute = { commandLane: { recommended: true, reason: 'local_project_artifact_authoring' } };
        await NeuroShunter.dispatch(ctx, {
            text: 'raw narrated refusal',
            attachments: [{
                kind: 'download',
                name: 'unverified-report.docx',
                url: 'https://m365.cloud.microsoft/generated/unverified-report.docx',
            }],
        }, brain, controller, { m365ToolRoute: toolRoute });

        expect(ctx.reply).toHaveBeenCalledWith('正在確認可用資源並準備執行…');
        expect(ctx.reply.mock.calls.flat().join('\n')).not.toContain('沒有可驗證');
        expect(ctx.reply.mock.calls.flat().join('\n')).not.toContain('unverified-report');
        expect(onGolemProtocolResponse).toHaveBeenCalledWith(expect.objectContaining({ toolRoute }));
        expect(enqueue).toHaveBeenCalledWith(
            ctx,
            expect.stringContaining('GOLEM_EXECUTION_REPAIR'),
            expect.objectContaining({
                isSystemFeedback: true,
                allowActions: true,
                planMode: true,
                workspaceRunId: 'run-repair-1',
                workspacePlanId: null,
                resetAutoTurnBudget: true,
                toolRoutingQuery: '在工作區建立 Word 報告',
            })
        );
    });

    test('shows a stable unwrapped M365 reply and repairs only its missing control envelope', async () => {
        const enqueue = jest.fn().mockResolvedValue();
        const attachment = {
            kind: 'download',
            name: '第006期_數位轉型週報摘要.docx',
            url: 'https://contoso.sharepoint.com/report.docx',
        };
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-unwrapped-1',
            onGolemProtocolResponse: jest.fn().mockResolvedValue({
                accepted: false,
                allowActions: false,
                planMode: true,
                runId: 'run-unwrapped-1',
                planId: 'run-unwrapped-1',
                planRevision: 8,
                protocolRepair: {
                    status: 'retry',
                    prompt: '[GOLEM_EXECUTION_REPAIR]restore envelope only[/GOLEM_EXECUTION_REPAIR]',
                    toolRoutingQuery: '建立 Word 報告',
                    message: '',
                },
            }),
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map(), convoManager: { enqueue } };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: 'Word 檔已生成，可直接下載。',
            actions: [],
        });

        await NeuroShunter.dispatch(ctx, {
            text: 'Word 檔已生成，可直接下載。',
            attachments: [attachment],
            status: 'FALLBACK_RECOVERED',
        }, brain, controller);

        expect(ctx.onGolemProtocolResponse).toHaveBeenCalledWith(expect.objectContaining({
            responseStatus: 'FALLBACK_RECOVERED',
            downloadAttachmentCount: 1,
        }));
        expect(ctx.reply).toHaveBeenCalledWith(
            'Word 檔已生成，可直接下載。',
            expect.objectContaining({ attachments: [attachment] })
        );
        expect(enqueue).toHaveBeenCalledWith(
            ctx,
            expect.stringContaining('restore envelope only'),
            expect.objectContaining({ isSystemFeedback: true, workspaceRunId: 'run-unwrapped-1' })
        );
    });

    test('keeps a normal enveloped file result visible while Copilot repairs its missing active plan state', async () => {
        const enqueue = jest.fn().mockResolvedValue();
        const attachment = {
            kind: 'download',
            name: '第006期_數位轉型週報摘要.docx',
            url: 'https://contoso.sharepoint.com/Doc.aspx?file=report.docx',
        };
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-visible-result-1',
            onGolemProtocolResponse: jest.fn().mockResolvedValue({
                accepted: false,
                allowActions: false,
                planMode: true,
                runId: 'run-visible-result-1',
                planId: 'run-visible-result-1',
                planRevision: 8,
                protocolRepair: {
                    status: 'retry',
                    prompt: '[GOLEM_EXECUTION_REPAIR]restore plan only[/GOLEM_EXECUTION_REPAIR]',
                    toolRoutingQuery: '建立 Word 報告',
                    preserveVisibleResult: true,
                    message: '',
                },
            }),
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map(), convoManager: { enqueue } };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: 'Word 檔已完成，可直接開啟。',
            actions: [],
        });

        await NeuroShunter.dispatch(ctx, {
            text: '[GOLEM_REPLY]Word 檔已完成，可直接開啟。[/GOLEM_REPLY]',
            attachments: [
                { kind: 'source', name: '參考資料', url: 'https://contoso.sharepoint.com/source' },
                attachment,
            ],
            status: 'ENVELOPE_COMPLETE',
        }, brain, controller);

        expect(ctx.onGolemProtocolResponse).toHaveBeenCalledWith(expect.objectContaining({
            responseStatus: 'ENVELOPE_COMPLETE',
            downloadAttachmentCount: 1,
        }));
        expect(ctx.reply).toHaveBeenCalledWith(
            'Word 檔已完成，可直接開啟。',
            expect.objectContaining({ attachments: expect.arrayContaining([attachment]) })
        );
        expect(enqueue).toHaveBeenCalledWith(
            ctx,
            expect.stringContaining('restore plan only'),
            expect.objectContaining({ isSystemFeedback: true, workspaceRunId: 'run-visible-result-1' })
        );
    });

    test('feeds a host plan rejection back to Copilot instead of showing the constraint to the user', async () => {
        const enqueue = jest.fn().mockResolvedValue();
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-constraint-1',
            toolRoutingQuery: '建立並驗證 Word 報告',
            onGolemProtocolResponse: jest.fn().mockResolvedValue({
                accepted: false,
                allowActions: false,
                planMode: true,
                code: 'M365_PLAN_ACTION_CARDINALITY_INVALID',
                warning: '⚠️ 自主計畫已暫停：執行中的計畫每輪至少需要提出一個工具動作。',
                runId: 'run-constraint-1',
                planId: 'run-constraint-1',
                planRevision: 2,
                maxActionDepth: 12,
            }),
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map(), convoManager: { enqueue } };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '改用新的方式繼續處理。',
            plan: { status: 'running' },
            actions: [],
        });

        await NeuroShunter.dispatch(ctx, 'raw rejected plan', brain, controller);

        expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining('自主計畫已暫停'));
        expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining('改用新的方式'));
        expect(enqueue).toHaveBeenCalledWith(
            ctx,
            expect.stringContaining('[GOLEM_HOST_CONSTRAINT]'),
            expect.objectContaining({
                isSystemFeedback: true,
                allowActions: true,
                planMode: true,
                workspaceRunId: 'run-constraint-1',
                workspacePlanId: 'run-constraint-1',
                toolRoutingQuery: '建立並驗證 Word 報告',
            })
        );
        const repairPrompt = enqueue.mock.calls[0][1];
        expect(repairPrompt).toContain('M365_PLAN_ACTION_CARDINALITY_INVALID');
        expect(repairPrompt).toContain('執行中的計畫每輪至少需要提出一個工具動作');
        expect(repairPrompt).toContain('No new tool action was dispatched');
    });

    test('asks Copilot to restore the matching plan revision instead of pausing the user', async () => {
        const enqueue = jest.fn().mockResolvedValue();
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-plan-revision-1',
            toolRoutingQuery: '建立並驗證 Word 報告',
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map(), convoManager: { enqueue } };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '繼續執行。',
            plan: null,
            actions: [{ action: 'command', parameter: 'Write-Output test' }],
        });

        await NeuroShunter.dispatch(ctx, 'raw action without plan', brain, controller, {
            planMode: true,
            allowActions: true,
            workspaceRunId: 'run-plan-revision-1',
            workspacePlanId: 'plan-revision-1',
            workspacePlanRevision: 3,
        });

        expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining('自主計畫已暫停'));
        expect(enqueue).toHaveBeenCalledWith(
            ctx,
            expect.stringContaining('M365_SAME_REVISION_PLAN_REQUIRED'),
            expect.objectContaining({
                isSystemFeedback: true,
                allowActions: true,
                planMode: true,
                workspaceRunId: 'run-plan-revision-1',
                workspacePlanId: 'plan-revision-1',
                workspacePlanRevision: 3,
                toolRoutingQuery: '建立並驗證 Word 報告',
            })
        );
    });

    test('silently discards delayed Copilot output after its host plan is terminal', async () => {
        const enqueue = jest.fn().mockResolvedValue();
        const ctx = {
            reply: jest.fn().mockResolvedValue(),
            shouldMentionSender: false,
            platform: 'web',
            workspaceConversationId: 'conversation-terminal-1',
            toolRoutingQuery: '建立並驗證 Word 報告',
            onGolemProtocolResponse: jest.fn().mockResolvedValue({
                accepted: false,
                allowActions: false,
                planMode: true,
                code: 'M365_PLAN_TERMINAL',
                warning: '⚠️ 自主計畫已終止，不能繼續執行。',
                runId: 'run-terminal-1',
                planId: 'run-terminal-1',
                planRevision: 3,
                stopRepair: true,
            }),
        };
        const brain = {
            webBackend: { id: 'm365-web', safeMode: true },
            memorize: jest.fn().mockResolvedValue(),
            _appendChatLog: jest.fn(),
            areActionsEnabled: jest.fn(() => true),
            isLocalContextEnabled: jest.fn(() => false),
        };
        const controller = { pendingTasks: new Map(), convoManager: { enqueue } };
        ResponseParser.parse.mockReturnValue({
            memory: null,
            reply: '舊計畫不能繼續。',
            plan: { status: 'blocked' },
            actions: [],
        });

        await NeuroShunter.dispatch(ctx, 'delayed terminal response', brain, controller);

        expect(ctx.reply).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
    });
});
