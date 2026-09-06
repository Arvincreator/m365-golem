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

describe('NeuroShunter M365 safety gates', () => {
    let previousAutoApprove;

    beforeEach(() => {
        jest.clearAllMocks();
        previousAutoApprove = process.env.GOLEM_AUTO_APPROVE_ALL;
        process.env.GOLEM_AUTO_APPROVE_ALL = 'false';
    });

    afterEach(() => {
        if (previousAutoApprove === undefined) delete process.env.GOLEM_AUTO_APPROVE_ALL;
        else process.env.GOLEM_AUTO_APPROVE_ALL = previousAutoApprove;
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
        expect(ctx.reply).toHaveBeenCalledWith('我已保留跨對話仍需沿用的規則。');
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
});
