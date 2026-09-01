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
});
