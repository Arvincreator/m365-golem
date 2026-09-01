const Executor = require('../src/core/Executor');
const { spawn } = require('child_process');
const EventEmitter = require('events');

jest.mock('child_process', () => ({
    spawn: jest.fn()
}));

describe('Executor', () => {
    let executor;
    let mockProcess;

    beforeEach(() => {
        executor = new Executor();
        mockProcess = new EventEmitter();
        mockProcess.stdout = new EventEmitter();
        mockProcess.stderr = new EventEmitter();
        mockProcess.kill = jest.fn();
        spawn.mockReturnValue(mockProcess);
    });

    test('should resolve with stdout on success', async () => {
        const promise = executor.run('ls');
        
        mockProcess.stdout.emit('data', Buffer.from('file1\nfile2'));
        mockProcess.emit('close', 0);

        const result = await promise;
        expect(result).toContain('file1');
        expect(spawn).toHaveBeenCalledWith('ls', [], expect.anything());
    });

    test('should reject on non-zero exit code', async () => {
        const promise = executor.run('invalid-cmd');
        
        mockProcess.stderr.emit('data', Buffer.from('Command not found'));
        mockProcess.emit('close', 1);

        await expect(promise).rejects.toThrow('Command failed (Exit Code 1)');
    });

    test('should reject on process error', async () => {
        const promise = executor.run('ls');
        mockProcess.emit('error', new Error('Spawn failed'));
        await expect(promise).rejects.toThrow('Spawn failed');
    });

    test('should handle timeout', async () => {
        jest.useFakeTimers();
        const promise = executor.run('sleep 10', { timeout: 1000 });

        jest.advanceTimersByTime(1100);
        
        await expect(promise).rejects.toThrow('Command timed out');
        expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
        jest.useRealTimers();
    });
});
