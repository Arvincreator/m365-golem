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
        const expectedCommand = process.platform === 'win32'
            ? (process.env.ComSpec || 'cmd.exe')
            : 'ls';
        const expectedArgs = process.platform === 'win32'
            ? ['/d', '/u', '/s', '/c', 'chcp 65001>nul & ls']
            : [];
        expect(spawn).toHaveBeenCalledWith(expectedCommand, expectedArgs, expect.anything());
        if (process.platform === 'win32') {
            expect(spawn.mock.calls[0][2].env).toEqual(expect.objectContaining({
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1',
            }));
            expect(spawn.mock.calls[0][2].shell).toBe(false);
        }
    });

    test('should preserve UTF-8 characters split across output chunks', async () => {
        const promise = executor.run('dir /b');
        const output = Buffer.from('Golem_自主執行_UAT.docx\r\n', 'utf8');
        const splitAt = output.indexOf(Buffer.from('自', 'utf8')) + 1;

        mockProcess.stdout.emit('data', output.subarray(0, splitAt));
        mockProcess.stdout.emit('data', output.subarray(splitAt));
        mockProcess.emit('close', 0);

        await expect(promise).resolves.toBe('Golem_自主執行_UAT.docx\r\n');
    });

    test('should decode UTF-16LE output from Windows shell built-ins', async () => {
        const promise = executor.run('dir /b');
        const output = Buffer.from('Golem_自主執行_UAT.docx\r\n', 'utf16le');

        mockProcess.stdout.emit('data', output.subarray(0, 8));
        mockProcess.stdout.emit('data', output.subarray(8));
        mockProcess.emit('close', 0);

        await expect(promise).resolves.toBe('Golem_自主執行_UAT.docx\r\n');
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
