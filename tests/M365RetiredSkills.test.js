const ConfigManager = require('../src/config');
const SkillPackageRegistry = require('../src/managers/SkillPackageRegistry');
const COMMAND_DEFS = require('../src/config/commands');
const { toolsetManager } = require('../src/managers/ToolsetManager');

describe('M365 retired feature subtraction', () => {
    const originalBackend = ConfigManager.CONFIG.GOLEM_BACKEND;

    afterEach(() => {
        ConfigManager.CONFIG.GOLEM_BACKEND = originalBackend;
    });

    test('does not register stock or crypto skill packages in the M365 fork', () => {
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        const ids = SkillPackageRegistry.listSkillPackages().map((pkg) => pkg.id);

        expect(ids).not.toContain('stock-dashboard');
        expect(ids).not.toContain('crypto-dashboard');
        expect(toolsetManager.getActiveTools()).not.toContain('stock-dashboard');
        expect(toolsetManager.getActiveTools()).not.toContain('crypto-dashboard');
    });

    test('removes retired slash commands from the advertised command catalog', () => {
        const commands = COMMAND_DEFS.map((item) => item.command);

        expect(commands).not.toEqual(expect.arrayContaining([
            '/rpg',
            '/stocks',
            '/stock',
            '/stockboard',
            '/stock-dashboard',
            '/crypto',
            '/cryptos',
            '/cryptoboard',
        ]));
    });
});
