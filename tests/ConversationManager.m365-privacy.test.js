const ConversationManager = require('../src/core/ConversationManager');

describe('ConversationManager M365 safe-mode privacy', () => {
    let manager;

    afterEach(() => {
        if (manager) manager.destroy();
        jest.restoreAllMocks();
    });

    test('does not print priority prompt content when local context is disabled', async () => {
        const brain = {
            chatLogManager: null,
            isLocalContextEnabled: () => false,
        };
        const controller = { pendingTasks: new Map() };
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        manager = new ConversationManager(brain, {}, controller);
        jest.spyOn(manager, '_processQueue').mockImplementation(() => {});

        await manager.enqueue(
            { chatId: 'm365-poc' },
            'SECRET-PROMPT-SHOULD-NOT-BE-LOGGED',
            { bypassDebounce: true, isPriority: true, attachment: null }
        );

        const output = logSpy.mock.calls.flat().join(' ');
        expect(output).toContain('M365 POC');
        expect(output).not.toContain('SECRET-PROMPT-SHOULD-NOT-BE-LOGGED');
    });

    test('rejects a second prompt instead of retaining it while one is active', async () => {
        const brain = {
            chatLogManager: null,
            isLocalContextEnabled: () => false,
        };
        const controller = { pendingTasks: new Map() };
        const ctx = { chatId: 'm365-poc', reply: jest.fn().mockResolvedValue() };
        manager = new ConversationManager(brain, {}, controller);
        manager.isProcessing = true;

        await manager.enqueue(ctx, 'SECOND-SECRET-PROMPT', {
            bypassDebounce: true,
            isPriority: true,
            attachment: null,
        });

        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('不保存額外待處理內容'));
        expect(manager.queue).toHaveLength(0);
        expect(controller.pendingTasks.size).toBe(0);
    });

    test('does not expose last-turn retry content when local context is disabled', () => {
        const brain = {
            chatLogManager: null,
            isLocalContextEnabled: () => false,
        };
        manager = new ConversationManager(brain, {}, { pendingTasks: new Map() });
        manager.lastUserTurnByChat.set('m365-poc', { text: 'OLD-SECRET' });

        expect(manager.getLastUserTurn('m365-poc')).toBeNull();
    });
});
