const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const PatchManager = require('../src/managers/PatchManager');

jest.mock('fs');
jest.mock('child_process');

describe('PatchManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('apply blocks modification of kernel protected zone', () => {
        const originalCode = '// === [KERNEL PROTECTED START] ===\nconst secret = "foo"; // target: replace me\n// === [KERNEL PROTECTED END] ===';
        const patch = { search: 'replace me', replace: 'hacked' };
        expect(() => PatchManager.apply(originalCode, patch)).toThrow('試圖修改系統核心禁區');
    });

    test('apply replaces code exactly', () => {
        const originalCode = 'const A = 1;\nconst B = 2; // target: change B\n';
        const patch = { search: 'B = 2;', replace: 'B = 3;' };
        const result = PatchManager.apply(originalCode, patch);
        expect(result).toContain('B = 3;');
    });

    test('apply uses fuzzy matching when exact fails', () => {
        const originalCode = 'const A=1;\n  const B  =  2;  \n';
        // The patch has different whitespace
        const patch = { search: 'const B = 2;', replace: 'const B=3;' };
        const result = PatchManager.apply(originalCode, patch);
        expect(result).toContain('const B=3;');
    });

    test('apply throws when pattern not found', () => {
        const originalCode = 'const A = 1;';
        const patch = { search: 'Z = 9;', replace: 'Z = 10;' };
        expect(() => PatchManager.apply(originalCode, patch)).toThrow('找不到匹配代碼段落');
    });

    test('createTestClone creates a patched test file', () => {
        fs.readFileSync.mockReturnValue('const val = 1;');
        fs.writeFileSync.mockReturnValue();
        
        const testFile = PatchManager.createTestClone('/path/to/script.js', { search: 'val = 1', replace: 'val = 2' });
        expect(testFile).toBe('script.test.js'); // path.basename
        expect(fs.writeFileSync).toHaveBeenCalledWith('script.test.js', 'const val = 2;', 'utf-8');
    });

    test('verify returns true for standard valid JS', () => {
        spawnSync.mockReturnValue({ status: 0 }); // Node -c passes
        fs.existsSync.mockReturnValue(false);

        const result = PatchManager.verify('valid.js');
        expect(result).toBe(true);
        expect(spawnSync).toHaveBeenCalledWith('node', ['-c', 'valid.js'], expect.any(Object));
    });

    test('verify copies non-JS files to .js to check syntax', () => {
        spawnSync.mockReturnValue({ status: 0 });
        fs.existsSync.mockReturnValue(true);
        fs.copyFileSync.mockReturnValue();
        fs.unlinkSync.mockReturnValue();

        const result = PatchManager.verify('valid.txt');
        expect(result).toBe(true);
        expect(fs.copyFileSync).toHaveBeenCalledWith('valid.txt', 'valid.txt.js');
        expect(spawnSync).toHaveBeenCalledWith('node', ['-c', 'valid.txt.js'], expect.any(Object));
        expect(fs.unlinkSync).toHaveBeenCalledWith('valid.txt.js'); // cleanup
    });

    test('verify fails if node -c string syntax checker fails', () => {
        spawnSync.mockReturnValue({ status: 1, stderr: Buffer.from('Syntax Error') });
        const result = PatchManager.verify('invalid.js');
        expect(result).toBe(false);
    });

    test('verify runs test file dynamically for index.test.js', () => {
        spawnSync.mockReturnValue({ status: 0 });
        const result = PatchManager.verify('index.test.js');
        expect(result).toBe(true);
        expect(spawnSync).toHaveBeenCalledTimes(2); // one for -c, one for normal run
    });

    test('verify cleans up original test file on exit', () => {
        spawnSync.mockReturnValue({ status: 0 });
        fs.unlinkSync.mockReturnValue();
        PatchManager.verify('my.test.js');
        expect(fs.unlinkSync).toHaveBeenCalledWith('my.test.js');
    });
});
