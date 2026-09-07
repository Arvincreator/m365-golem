jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
const { execFileSync } = require('child_process');
const ToolScanner = require('../src/managers/ToolScanner');

beforeEach(() => execFileSync.mockReset());

test('looks up an executable without a shell and does not claim runtime health', () => {
    execFileSync.mockReturnValue('C:\\Python\\python.exe\r\n');
    expect(ToolScanner.check('python')).toContain('尚未驗證');
    expect(execFileSync.mock.calls[0][1]).toEqual(['python']);
    expect(execFileSync.mock.calls[0][2].timeout).toBe(3000);
});

test('a failed lookup does not assert the tool is uninstalled', () => {
    execFileSync.mockImplementation(() => { throw new Error('lookup failed'); });
    expect(ToolScanner.check('python')).toContain('不代表未安裝');
});

test.each(['python & whoami', 'python;id', '--help', '../python', 'python\nnode'])('rejects unsafe executable input %s', value => {
    expect(ToolScanner.check(value)).toContain('Invalid tool name');
    expect(execFileSync).not.toHaveBeenCalled();
});

test('no argument checks a bounded inventory', () => {
    execFileSync.mockReturnValue('/bin/tool');
    ToolScanner.check();
    expect(execFileSync.mock.calls.map(call => call[1][0])).toEqual(['python', 'py', 'node', 'git']);
});
