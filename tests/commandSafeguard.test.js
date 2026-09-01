const { CommandSafeguard: safeguard } = require('../packages/security');

describe('CommandSafeguard', () => {
    beforeEach(() => {
        delete process.env.COMMAND_WHITELIST;
        delete process.env.GOLEM_STRICT_SAFEGUARD;
    });

    test('should allow dangerous operations if skipWhitelist is true', () => {
        const result = safeguard.validate('ls ; rm -rf /', true);
        expect(result.safe).toBe(true);
    });

    test('should allow hard-coded whitelist commands', () => {
        const result = safeguard.validate('ls -la');
        expect(result.safe).toBe(true);
    });

    test('should allow dynamic whitelist via process.env', () => {
        process.env.COMMAND_WHITELIST = 'date,docker';
        const resultDate = safeguard.validate('date');
        const resultDocker = safeguard.validate('docker ps');
        
        expect(resultDate.safe).toBe(true);
        expect(resultDocker.safe).toBe(true);
    });

    test('should allow non-whitelisted command if skipWhitelist is true', () => {
        const result = safeguard.validate('unknown-cmd', true);
        expect(result.safe).toBe(true);
    });

    test('should allow pipe operator if skipWhitelist is true', () => {
        const result = safeguard.validate('pwd | grep a', true);
        expect(result.safe).toBe(true);
    });

    test('should allow dangerous keywords if skipWhitelist is true', () => {
        const result = safeguard.validate('date ; rm -rf /', true);
        expect(result.safe).toBe(true);
    });

    test('should block dangerous operations if skipWhitelist is false (default strict)', () => {
        process.env.GOLEM_STRICT_SAFEGUARD = 'true';
        const result = safeguard.validate('rm -rf /');
        expect(result.safe).toBe(false);
        expect(result.reason).toContain('偵測到高度危險操作');
    });

    test('should allow dangerous operations if GOLEM_STRICT_SAFEGUARD is false', () => {
        process.env.GOLEM_STRICT_SAFEGUARD = 'false';
        const result = safeguard.validate('rm -rf /');
        expect(result.safe).toBe(false);
        expect(result.reason).not.toContain('偵測到高度危險操作');
        expect(result.reason).toMatch(/指令風險等級|指令未列於白名單中/);

        // But it still blocks sensitive symbols because whitelist check is still there
        const resultWithSymbol = safeguard.validate('ls ; rm -rf /');
        expect(resultWithSymbol.safe).toBe(false);
        expect(resultWithSymbol.reason).toContain('偵測到敏感關鍵字');
    });
});
