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
});
