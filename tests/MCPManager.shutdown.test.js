'use strict';

const MCPManager = require('../src/mcp/MCPManager');

describe('MCPManager shutdown', () => {
    test('disconnects every managed child process and resets lifecycle state', async () => {
        const manager = new MCPManager();
        const first = { disconnect: jest.fn().mockResolvedValue(undefined) };
        const second = { disconnect: jest.fn().mockRejectedValue(new Error('already stopped')) };
        manager._clients.set('first', first);
        manager._clients.set('second', second);
        manager._loaded = true;

        await expect(manager.shutdown()).resolves.toBeUndefined();

        expect(first.disconnect).toHaveBeenCalledTimes(1);
        expect(second.disconnect).toHaveBeenCalledTimes(1);
        expect(manager._clients.size).toBe(0);
        expect(manager._loaded).toBe(false);
        expect(manager._loadingPromise).toBeNull();
    });
});
