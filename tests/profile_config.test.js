const { execSync } = require('child_process');
const path = require('path');

function runTest(env) {
    const envStr = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
    const code = `
        const config = require('./src/config/index.js');
        console.log(JSON.stringify({
            profile: config.CONFIG.PLAYWRIGHT_PROFILE,
            userDataDir: config.CONFIG.USER_DATA_DIR,
            memoryBaseDir: config.MEMORY_BASE_DIR
        }));
    `;
    const output = execSync(`${envStr} node -e "${code.replace(/"/g, '\\"')}"`, { cwd: path.resolve(__dirname, '..') });
    return JSON.parse(output.toString());
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
