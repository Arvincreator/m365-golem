const ActionQueue = require('../src/core/ActionQueue');

describe('ActionQueue', () => {
    let queue;

    beforeEach(() => {
        queue = new ActionQueue({ golemId: 'test-golem' });
        // Override the process delay for faster tests
        queue.PROCESS_DELAY = 10; 
    });

    test('should execute tasks in order', async () => {
        const results = [];
        const task1 = jest.fn().mockImplementation(async () => { 
            await new Promise(r => setTimeout(r, 20));
            results.push(1); 
        });
        const task2 = jest.fn().mockImplementation(async () => { results.push(2); });

        queue.enqueue(null, task1);
        queue.enqueue(null, task2);

        // Wait for both to finish
        for (let i = 0; i < 10; i++) {
            if (results.length === 2) break;
            await new Promise(r => setTimeout(r, 50));
        }

        expect(results).toEqual([1, 2]);
    });

    test('should handle priority tasks', async () => {
        const results = [];
        const task1 = jest.fn().mockImplementation(async () => { await new Promise(r => setTimeout(r, 50)); results.push('slow'); });
        const task2 = jest.fn().mockImplementation(async () => { results.push('normal'); });
        const task3 = jest.fn().mockImplementation(async () => { results.push('priority'); });

        queue.enqueue(null, task1);
        queue.enqueue(null, task2);
        queue.enqueue(null, task3, { isPriority: true });

        // task1 is running, task3 is next, then task2
        for (let i = 0; i < 10; i++) {
            if (results.length === 3) break;
            await new Promise(r => setTimeout(r, 50));
        }

        expect(results).toEqual(['slow', 'priority', 'normal']);
    });

    test('exposes running and queued action state for one conversation', async () => {
        let releaseFirst;
        const first = new Promise((resolve) => { releaseFirst = resolve; });

        await queue.enqueue(null, async () => first, {
            metadata: { conversationId: 'conversation-1', title: 'First action' },
        });
        await queue.enqueue(null, async () => undefined, {
            metadata: { conversationId: 'conversation-1', title: 'Second action', actionCount: 2 },
        });

        expect(queue.getSnapshot({ conversationId: 'conversation-1' })).toEqual([
            expect.objectContaining({ status: 'running', position: 0, title: 'First action' }),
            expect.objectContaining({ status: 'queued', position: 1, title: 'Second action', actionCount: 2 }),
        ]);
        expect(queue.getSnapshot({ conversationId: 'another-conversation' })).toEqual([]);
        releaseFirst();
        for (let index = 0; index < 20; index += 1) {
            if (!queue.isProcessing && queue.getSnapshot().length === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(queue.getSnapshot()).toEqual([]);
    });
});
