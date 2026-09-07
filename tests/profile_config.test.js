const { execFileSync } = require('child_process');
const path = require('path');

function runTest(env) {
    const code = `
        const config = require('./src/config/index.js');
        console.log(JSON.stringify({
            profile: config.CONFIG.PLAYWRIGHT_PROFILE,
            userDataDir: config.CONFIG.USER_DATA_DIR,
            memoryBaseDir: config.MEMORY_BASE_DIR
        }));
    `;
    const output = execFileSync(process.execPath, ['-e', code], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
    return JSON.parse(output);
}

describe('Profile Configuration Verification (Clean Process)', () => {
    test('Should use golem_memory when no profile is set', () => {
        const result = runTest({ PLAYWRIGHT_PROFILE: '', USER_DATA_DIR: '' });
        expect(result.profile).toBe('');
        expect(result.memoryBaseDir.endsWith('golem_memory')).toBe(true);
    });

    test('Should use profiles/work when PLAYWRIGHT_PROFILE=work', () => {
        const result = runTest({ PLAYWRIGHT_PROFILE: 'work', USER_DATA_DIR: '' });
        expect(result.profile).toBe('work');
        expect(result.memoryBaseDir.includes(path.join('profiles', 'work'))).toBe(true);
    });

    test('Should prioritize profile name even if USER_DATA_DIR is explicitly set', () => {
        const result = runTest({ PLAYWRIGHT_PROFILE: 'work', USER_DATA_DIR: './custom_dir' });
        expect(result.profile).toBe('work');
        expect(result.memoryBaseDir.includes(path.join('profiles', 'work'))).toBe(true);
    });
});
