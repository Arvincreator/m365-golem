const ConversationManager = require('../src/core/ConversationManager');

describe('ConversationManager', () => {
    let cm;
    let mockBrain;
    let mockShunter;
    let mockController;
    let mockCtx;

    beforeEach(() => {
        jest.useFakeTimers();

        mockBrain = {
            recall: jest.fn().mockResolvedValue([]),
            sendMessage: jest.fn().mockResolvedValue({
                text: '[GOLEM_REPLY] AI Response',
                attachments: [],
                status: 'ENVELOPE_COMPLETE'
            }),
            _appendChatLog: jest.fn()
        };

        mockShunter = { dispatch: jest.fn().mockResolvedValue() };
        mockController = { pendingTasks: new Map() };

        mockCtx = {
            chatId: '123',
            platform: 'telegram',
            text: 'hello',
            sendTyping: jest.fn().mockResolvedValue(),
            reply: jest.fn().mockResolvedValue({ message_id: 1 }),
            isMentioned: jest.fn().mockReturnValue(false)
        };
    });

    afterEach(() => {
        if (cm && typeof cm.destroy === 'function') cm.destroy();
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('should debounce and merge multiple messages from same user', () => {
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        jest.spyOn(cm, '_processQueue').mockImplementation(() => {});

        cm.enqueue(mockCtx, 'msg1');
        cm.enqueue(mockCtx, 'msg2');

        expect(cm.userBuffers.has('123')).toBe(true);

        jest.advanceTimersByTime(1600);

        expect(cm.userBuffers.has('123')).toBe(false);
        expect(cm.queue.length).toBe(1);
        expect(cm.queue[0].text).toBe('msg1\nmsg2');
    });

    test('should bypass debounce for priority messages', () => {
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        jest.spyOn(cm, '_processQueue').mockImplementation(() => {});

        cm.enqueue(mockCtx, 'priority', { bypassDebounce: true, isPriority: true });

        expect(cm.queue.length).toBe(1);
        expect(cm.queue[0].text).toBe('priority');
    });

    test('exposes its internal queue to protocol repair through the task controller', () => {
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        expect(mockController.convoManager).toBe(cm);

        cm.destroy();
        expect(mockController.convoManager).toBeUndefined();
        cm = null;
    });

    test('can wait until an attachment task has finished before releasing its staging lifecycle', async () => {
        let releaseTransport;
        mockBrain.sendMessage.mockImplementation(() => new Promise((resolve) => {
            releaseTransport = () => resolve({
                text: '[GOLEM_REPLY] AI Response',
                attachments: [],
                status: 'ENVELOPE_COMPLETE'
            });
        }));
        cm = new ConversationManager(mockBrain, mockShunter, mockController);

        let settled = false;
        const completion = cm.enqueue(mockCtx, 'attachment request', {
            bypassDebounce: true,
            isPriority: true,
            attachment: { validatedByM365Harness: true, files: [{ name: 'brief.pdf' }] },
            waitForCompletion: true
        }).then(() => {
            settled = true;
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(mockBrain.sendMessage).toHaveBeenCalled();
        expect(settled).toBe(false);

        releaseTransport();
        await completion;
        expect(mockShunter.dispatch).toHaveBeenCalled();
        expect(settled).toBe(true);
    });

    test('should request queue approval when busy', () => {
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        jest.spyOn(cm, '_processQueue').mockImplementation(() => {});

        cm.queue.push({ ctx: mockCtx, text: 'existing', attachment: null, options: {} });
        cm.enqueue(mockCtx, 'new-msg', { bypassDebounce: true, isPriority: false });

        expect(mockCtx.reply).toHaveBeenCalledWith(
            expect.stringContaining('急件插隊'),
            expect.any(Object)
        );
        expect(mockController.pendingTasks.size).toBe(1);
    });

    test('should process queue and dispatch through shunter', async () => {
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        mockBrain.recall.mockResolvedValue([{ text: 'memory-hit' }]);

        cm.queue.push({ ctx: mockCtx, text: 'hello', attachment: null, options: {} });
        await cm._processQueue();

        expect(mockBrain.sendMessage).toHaveBeenCalledWith(
            expect.stringContaining('【相關記憶】'),
            false,
            expect.any(Object)
        );
        expect(mockShunter.dispatch).toHaveBeenCalled();
    });

    test('keeps the selected M365 response mode on the queued message snapshot', async () => {
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        cm.queue.push({
            ctx: mockCtx,
            text: 'queued prompt',
            attachment: null,
            options: { m365ResponseMode: 'thoughtful' },
        });

        await cm._processQueue();

        expect(mockBrain.sendMessage).toHaveBeenCalledWith(
            'queued prompt',
            false,
            expect.objectContaining({ m365ResponseMode: 'thoughtful' })
        );
    });

    test('should keep system feedback internal and skip user-visible input log', async () => {
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        const observation = '[System Observation]\n' + 'tool result '.repeat(500);

        cm.queue.push({
            ctx: mockCtx,
            text: observation,
            attachment: null,
            options: {
                isSystemFeedback: true,
                allowActions: false,
                bypassDebounce: true
            }
        });
        await cm._processQueue();

        expect(mockBrain._appendChatLog).not.toHaveBeenCalledWith(expect.objectContaining({
            sender: 'User',
            content: observation
        }));
        expect(mockBrain.recall).not.toHaveBeenCalled();
        expect(mockBrain.sendMessage).toHaveBeenCalledWith(
            observation,
            false,
            expect.objectContaining({
                isSystemFeedback: true,
                allowActions: false
            })
        );
        expect(mockShunter.dispatch).toHaveBeenCalledWith(
            mockCtx,
            expect.objectContaining({ text: '[GOLEM_REPLY] AI Response' }),
            mockBrain,
            mockController,
            expect.objectContaining({
                isSystemFeedback: true,
                allowActions: false
            })
        );
    });

    test('keeps response routing metadata bound to the same protocol callback', async () => {
        const toolRoute = { commandLane: { recommended: true, reason: 'local_project_artifact_authoring' } };
        mockBrain.sendMessage.mockResolvedValue({
            text: '[GOLEM_REPLY] AI Response',
            attachments: [],
            status: 'ENVELOPE_COMPLETE',
            m365ToolRoute: toolRoute,
        });
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        cm.queue.push({ ctx: mockCtx, text: '建立 Word', attachment: null, options: {} });

        await cm._processQueue();

        expect(mockShunter.dispatch).toHaveBeenCalledWith(
            mockCtx,
            expect.any(Object),
            mockBrain,
            mockController,
            expect.objectContaining({ m365ToolRoute: toolRoute })
        );
    });

    test('labels transport hooks for an internal Observation turn', async () => {
        const onTransportStart = jest.fn().mockResolvedValue();
        const onTransportAccepted = jest.fn().mockResolvedValue();
        const onTransportComplete = jest.fn().mockResolvedValue();
        mockCtx = {
            ...mockCtx,
            onTransportStart,
            onTransportAccepted,
            onTransportComplete,
        };
        mockBrain.sendMessage.mockImplementation(async (_text, _isSystem, options) => {
            await options.onSendAccepted({ acceptedAt: 123 });
            return {
                text: '[GOLEM_REPLY] Continued',
                attachments: [],
                status: 'ENVELOPE_COMPLETE',
            };
        });
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        cm.queue.push({
            ctx: mockCtx,
            text: '[System Observation]\nAction completed.',
            attachment: null,
            options: {
                isSystemFeedback: true,
                workspaceRunId: 'run-1',
                workspaceStepId: 'step-1',
                protocolRequestId: 'protocol-1',
            },
        });

        await cm._processQueue();

        const expectedMeta = expect.objectContaining({
            isSystemFeedback: true,
            workspaceRunId: 'run-1',
            workspaceStepId: 'step-1',
            protocolRequestId: 'protocol-1',
        });
        expect(onTransportStart).toHaveBeenCalledWith(expectedMeta);
        expect(onTransportAccepted).toHaveBeenCalledWith(expectedMeta, { acceptedAt: 123 });
        expect(onTransportComplete).toHaveBeenCalledWith(expect.objectContaining({
            text: '[GOLEM_REPLY] Continued',
        }), expectedMeta);
    });

    test('labels a normal user turn separately from internal Observation turns', async () => {
        const onTransportStart = jest.fn().mockResolvedValue();
        const onTransportComplete = jest.fn().mockResolvedValue();
        mockCtx = {
            ...mockCtx,
            onTransportStart,
            onTransportComplete,
        };
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        cm.queue.push({ ctx: mockCtx, text: 'normal turn', attachment: null, options: {} });

        await cm._processQueue();

        expect(onTransportStart).toHaveBeenCalledWith(expect.objectContaining({
            isSystemFeedback: false,
        }));
        expect(onTransportComplete).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
            isSystemFeedback: false,
        }));
    });

    test('preserves the internal Observation identity when transport start fails', async () => {
        const error = new Error('Conversation requires reconciliation.');
        error.code = 'M365_RECONCILIATION_REQUIRED';
        const onTransportStart = jest.fn().mockRejectedValue(error);
        const onTransportError = jest.fn().mockResolvedValue();
        mockCtx = {
            ...mockCtx,
            onTransportStart,
            onTransportError,
        };
        cm = new ConversationManager(mockBrain, mockShunter, mockController);
        cm.queue.push({
            ctx: mockCtx,
            text: '[System Observation]\nContinue the plan.',
            attachment: null,
            options: {
                isSystemFeedback: true,
                workspaceRunId: 'run-1',
                workspaceStepId: 'step-1',
            },
        });

        await cm._processQueue();

        expect(onTransportError).toHaveBeenCalledWith(error, expect.objectContaining({
            isSystemFeedback: true,
            workspaceRunId: 'run-1',
            workspaceStepId: 'step-1',
        }));
        expect(mockBrain.sendMessage).not.toHaveBeenCalled();
    });
});
