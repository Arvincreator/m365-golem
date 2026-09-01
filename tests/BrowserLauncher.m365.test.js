jest.mock('playwright', () => ({
    chromium: {
        launchPersistentContext: jest.fn(),
        connectOverCDP: jest.fn(),
    },
}));

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BrowserLauncher = require('../src/core/BrowserLauncher');
const { getWebBackendDefinition } = require('../src/core/web_backends');

describe('BrowserLauncher M365 work-profile policy', () => {
    const definition = getWebBackendDefinition('m365-web', {
        M365_POC_SAFE_MODE: true,
        M365_LOCAL_MEMORY_ENABLED: false,
        M365_ACTIONS_ENABLED: false,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.PLAYWRIGHT_M365_BROWSER_CHANNEL;
        delete process.env.PLAYWRIGHT_M365_STEALTH_ENABLED;
        delete process.env.PLAYWRIGHT_M365_BLOCK_HEAVY_RESOURCES;
    });

    test('uses Edge without stealth or heavy resource blocking', async () => {
        const context = {
            route: jest.fn(),
            addInitScript: jest.fn(),
        };
        chromium.launchPersistentContext.mockResolvedValue(context);

        await BrowserLauncher.launchLocal(
            'C:/nonexistent/m365-work-profile',
            'true',
            0,
            definition.browserPolicy
        );

        expect(chromium.launchPersistentContext).toHaveBeenCalledWith(
            'C:/nonexistent/m365-work-profile',
            expect.objectContaining({ channel: 'msedge' })
        );
        const options = chromium.launchPersistentContext.mock.calls[0][1];
        expect(options.headless).toBe(false);
        expect(options.args).not.toContain('--no-sandbox');
        expect(options.args).not.toContain('--disable-blink-features=AutomationControlled');
        expect(options.args).not.toContain('--disable-site-isolation-trials');
        expect(options.args).not.toContain('--disable-sync');
        expect(options.args).not.toContain('--disable-extensions');
        expect(options.args).not.toContain('--disable-background-networking');
        expect(options.args).not.toContain('--disable-default-apps');
        expect(options.ignoreDefaultArgs).toEqual(expect.arrayContaining([
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
        ]));
        expect(context.addInitScript).not.toHaveBeenCalled();
        expect(context.route).not.toHaveBeenCalled();
    });

    test('does not delete profile locks when Edge reports the profile is in use', async () => {
        const cleanSpy = jest.spyOn(BrowserLauncher, 'cleanLocks');
        chromium.launchPersistentContext.mockRejectedValue(new Error('profile appears to be in use'));

        await expect(BrowserLauncher.launchLocal(
            'C:/nonexistent/m365-work-profile',
            '',
            2,
            definition.browserPolicy
        )).rejects.toMatchObject({ code: 'BROWSER_PROFILE_IN_USE' });

        expect(cleanSpy).not.toHaveBeenCalled();
        cleanSpy.mockRestore();
    });

    test('recognizes the Edge lockfile before launch without deleting it', async () => {
        const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-m365-lock-'));
        const lockPath = path.join(profileDir, 'lockfile');
        fs.writeFileSync(lockPath, '');
        const cleanSpy = jest.spyOn(BrowserLauncher, 'cleanLocks');

        try {
            await expect(BrowserLauncher.launchLocal(
                profileDir,
                '',
                0,
                definition.browserPolicy
            )).rejects.toMatchObject({
                code: 'BROWSER_PROFILE_IN_USE',
                lockFiles: ['lockfile'],
            });

            expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
            expect(cleanSpy).not.toHaveBeenCalled();
            expect(fs.existsSync(lockPath)).toBe(true);
        } finally {
            cleanSpy.mockRestore();
            fs.rmSync(profileDir, { recursive: true, force: true });
        }
    });
});
