const CommandHandler = require('../src/core/action_handlers/CommandHandler');

jest.mock('../index', () => ({
    getOrCreateGolem: jest.fn()
}), { virtual: true }); // Prevent actual resolution errors if index structure differs in test env

describe('CommandHandler', () => {
    let mockCtx;
    let mockController;
    let mockBrain;
    let mockDispatchFn;
    let mockActionQueue;
    let mockConvoManager;

    beforeEach(() => {
        jest.clearAllMocks();
        mockCtx = {
            reply: jest.fn().mockResolvedValue(),
            sendTyping: jest.fn().mockResolvedValue()
        };
        mockController = {
            runSequence: jest.fn(),
            golemId: 'test-golem'
        };
        mockBrain = {
            sendMessage: jest.fn().mockResolvedValue('brain reply')
        };
        mockDispatchFn = jest.fn().mockResolvedValue();
        mockActionQueue = {
            enqueue: jest.fn(async (ctx, fn) => await fn()) // immediately execute and await
        };
        mockConvoManager = {
            enqueue: jest.fn()
        };

        // Mock index.js
        try {
            require('../index').getOrCreateGolem.mockReturnValue({
                actionQueue: mockActionQueue,
                convoManager: mockConvoManager
            });
        } catch(e) {}
    });

    test('execute should do nothing if no normalActions', async () => {
        await CommandHandler.execute(mockCtx, [], mockController, mockBrain, mockDispatchFn);
        expect(mockController.runSequence).not.toHaveBeenCalled();
    });

    test('execute should handle runSequence error', async () => {
        mockController.runSequence.mockRejectedValue(new Error('Sequence failed'));
        await CommandHandler.execute(mockCtx, [{ action: 'cmd' }], mockController, mockBrain, mockDispatchFn);
        expect(mockCtx.reply).toHaveBeenCalledWith(expect.stringContaining('Sequence failed'), expect.anything());
    });

    test('hides command diagnostics from M365 workspace users', async () => {
        mockBrain.webBackend = { id: 'm365-web' };
        mockController.runSequence.mockRejectedValue(new Error('SECRET_COMMAND_DIAGNOSTIC'));

        await CommandHandler.execute(mockCtx, [{ action: 'cmd' }], mockController, mockBrain, mockDispatchFn);

        expect(mockCtx.reply).toHaveBeenCalledWith('❌ 這項操作未完成，請稍後再試。');
        expect(mockCtx.reply.mock.calls.flat().join('\n')).not.toContain('SECRET_COMMAND_DIAGNOSTIC');
    });

    test('execute should handle string observation result', async () => {
        mockController.runSequence.mockResolvedValue('Command output success');
        await CommandHandler.execute(mockCtx, [{ action: 'cmd' }], mockController, mockBrain, mockDispatchFn);
        
        // Should enqueue to convoManager
        expect(mockConvoManager.enqueue).toHaveBeenCalledWith(
            mockCtx,
            expect.stringContaining('Command output success'),
            expect.objectContaining({
                isPriority: true,
                bypassDebounce: true,
                isSystemFeedback: true,
                allowActions: false,
                actionDepth: 1,
            })
        );
        const observationPrompt = mockConvoManager.enqueue.mock.calls[0][1];
        expect(observationPrompt).toContain('[System Observation]');
        expect(observationPrompt).toContain('Command output success');
    });

    test('adds plain-language presentation rules to M365 command results', async () => {
        mockBrain.webBackend = { id: 'm365-web' };
        mockController.runSequence.mockResolvedValue('Command output success');

        await CommandHandler.execute(mockCtx, [{ action: 'cmd' }], mockController, mockBrain, mockDispatchFn);

        const observationPrompt = mockConvoManager.enqueue.mock.calls[0][1];
        const observationOptions = mockConvoManager.enqueue.mock.calls[0][2];
        expect(observationPrompt).toContain('只說明已確認的結果、限制與下一步');
        expect(observationPrompt).toContain('不得提及或照抄內部流程名稱');
        expect(observationPrompt).toContain('[GOLEM_PROJECT_MEMORY]');
        expect(observationPrompt).not.toContain('參考來源：本次操作無可公開連結來源');
        expect(observationOptions.m365ProjectMemoryRequired).toBe(true);
        expect(mockCtx.workspaceProjectMemoryRequired).toBe(true);
    });

    test('passes a scoped M365 approval to the command safety pipeline', async () => {
        mockController.runSequence.mockResolvedValue(null);
        const actions = [{ action: 'command', parameter: 'cat README.md' }];

        await CommandHandler.execute(
            mockCtx,
            actions,
            mockController,
            mockBrain,
            mockDispatchFn,
            { m365ActionApproved: true }
        );

        expect(mockController.runSequence).toHaveBeenCalledWith(
            mockCtx,
            actions,
            0,
            mockBrain,
            { approvalGranted: true }
        );
    });

    test('execute should handle error string observation result', async () => {
        const errorString = `[Step 1 Failed]\ncmd: ls bad\nError:\nNo such file or directory\n\n----------------\n\n`;
        mockController.runSequence.mockResolvedValue(errorString);
        await CommandHandler.execute(mockCtx, [{ action: 'cmd' }], mockController, mockBrain, mockDispatchFn);
        
        // Should reply with error summary
        expect(mockCtx.reply).toHaveBeenCalledWith(
            expect.stringContaining('指令執行失敗'),
            expect.anything()
        );
    });

    test('plan mode records a bound host Observation and queues the next revision', async () => {
        mockController.runSequence.mockResolvedValue('[Step 1 Success]\nResult:\nfile-a.txt');
        mockBrain.webBackend = { id: 'm365-web' };
        mockCtx.workspaceConversationId = 'conversation-1';
        mockCtx.onGolemObservation = jest.fn().mockResolvedValue({
            planId: 'run-1',
            planRevision: 1,
            run: { status: 'RUNNING' },
        });

        await CommandHandler.execute(
            mockCtx,
            [{ action: 'command', parameter: 'dir' }],
            mockController,
            mockBrain,
            mockDispatchFn,
            {
                planMode: true,
                workspaceRunId: 'run-1',
                workspaceStepId: 'host-step-1',
                workspacePlanId: 'run-1',
                workspacePlanRevision: 1,
                workspacePlanStepId: 'step_1',
                workspaceActionId: 'action-1',
                actionDepth: 0,
                maxActionDepth: 6,
            }
        );

        expect(mockCtx.onGolemObservation).toHaveBeenCalledWith(expect.objectContaining({
            runId: 'run-1',
            stepId: 'host-step-1',
            actionId: 'action-1',
            planStepId: 'step_1',
            lane: 'command',
            status: 'succeeded',
        }));
        expect(mockConvoManager.enqueue).toHaveBeenCalledWith(
            mockCtx,
            expect.stringContaining('[GOLEM_OBSERVATION]'),
            expect.objectContaining({
                isSystemFeedback: true,
                allowActions: true,
                planMode: true,
                workspacePlanRevision: 1,
                m365ProjectMemoryRequired: true,
            })
        );
    });

    test('plan mode fails closed when the command executor returns no Observation', async () => {
        mockController.runSequence.mockResolvedValue('');
        mockCtx.onGolemObservation = jest.fn().mockResolvedValue({
            planId: 'run-1',
            planRevision: 1,
            run: { status: 'RUNNING' },
        });

        await CommandHandler.execute(
            mockCtx,
            [{ action: 'command', parameter: 'dir' }],
            mockController,
            mockBrain,
            mockDispatchFn,
            {
                planMode: true,
                workspaceRunId: 'run-1',
                workspaceStepId: 'host-step-1',
                workspacePlanId: 'run-1',
                workspacePlanRevision: 1,
                workspacePlanStepId: 'step_1',
                workspaceActionId: 'action-1',
                maxActionDepth: 6,
            }
        );

        expect(mockCtx.onGolemObservation).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed',
            result: 'The command executor returned no Observation.',
        }));
        expect(mockCtx.reply).toHaveBeenCalledWith(expect.stringContaining('沒有回傳可驗證的 Observation'));
    });
});
