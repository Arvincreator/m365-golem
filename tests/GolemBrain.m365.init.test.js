jest.mock('dotenv', () => ({ config: jest.fn() }), { virtual: true });

jest.mock('../src/services/DOMDoctor', () => {
    return jest.fn().mockImplementation((definition = {}) => ({
        loadSelectors: () => ({ ...(definition.selectors || {}) }),
        saveSelectors: jest.fn(),
    }));
});

jest.mock('../src/core/BrowserLauncher', () => ({ launch: jest.fn() }));

jest.mock('../src/core/PageInteractor', () => {
    return jest.fn().mockImplementation(() => ({
        interact: jest.fn().mockResolvedValue({ text: 'ACK', attachments: [] }),
    }));
});

jest.mock('../src/core/NodeRouter', () => ({ handle: jest.fn().mockResolvedValue(null) }));

jest.mock('../src/managers/WikiManager', () => {
    return jest.fn().mockImplementation(() => ({
        init: jest.fn(),
        getInjectionContext: jest.fn(() => ''),
    }));
});

jest.mock('../src/managers/ChatLogManager', () => {
    return jest.fn().mockImplementation(() => ({
        _isInitialized: false,
        init: jest.fn().mockResolvedValue(),
        append: jest.fn(),
        readTierAsync: jest.fn().mockResolvedValue([]),
        readRecentHourlyAsync: jest.fn().mockResolvedValue(''),
    }));
});

jest.mock('../src/managers/SkillIndexManager', () => {
    return jest.fn().mockImplementation(() => ({ sync: jest.fn().mockResolvedValue() }));
});

jest.mock('../src/skills/core/persona', () => ({
    exists: jest.fn(() => false),
    get: jest.fn(() => ({ skills: [] })),
}));

jest.mock('../packages/memory', () => {
    const Driver = jest.fn().mockImplementation(() => ({
        init: jest.fn().mockResolvedValue(),
        recall: jest.fn().mockResolvedValue([]),
        memorize: jest.fn().mockResolvedValue(),
    }));
    return { LanceDBProDriver: Driver, SystemNativeDriver: Driver };
});

jest.mock('../packages/memory/embeddings', () => ({
    LocalProvider: jest.fn().mockImplementation(() => ({
        getEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    })),
}));

jest.mock('../packages/protocol', () => ({
    ProtocolFormatter: {
        _lastScanTime: 0,
        generateReqId: jest.fn(() => 'req-m365'),
        buildStartTag: jest.fn(() => '[[BEGIN:req-m365]]'),
        buildEndTag: jest.fn(() => '[[END:req-m365]]'),
        buildEnvelope: jest.fn((text) => text),
        buildSystemPrompt: jest.fn().mockResolvedValue({ systemPrompt: 'm365 boot', skillMemoryText: null }),
        compress: jest.fn((text) => text),
    },
}));

const ConfigManager = require('../src/config');
const BrowserLauncher = require('../src/core/BrowserLauncher');
const PageInteractor = require('../src/core/PageInteractor');
const { ProtocolFormatter } = require('../packages/protocol');
const { LocalProvider } = require('../packages/memory/embeddings');
const GolemBrain = require('../src/core/GolemBrain');

describe('GolemBrain m365-web bootstrap', () => {
    const original = {};

    beforeEach(() => {
        for (const key of [
            'GOLEM_BACKEND',
            'M365_COPILOT_URLS',
            'M365_POC_SAFE_MODE',
            'M365_LOCAL_MEMORY_ENABLED',
            'M365_ACTIONS_ENABLED',
            'M365_AUTO_BOOT_PROMPT',
        ]) {
            original[key] = Array.isArray(ConfigManager.CONFIG[key])
                ? [...ConfigManager.CONFIG[key]]
                : ConfigManager.CONFIG[key];
        }
        Object.assign(ConfigManager.CONFIG, {
            GOLEM_BACKEND: 'm365-web',
            M365_COPILOT_URLS: ['https://m365.cloud.microsoft/chat'],
            M365_POC_SAFE_MODE: true,
            M365_LOCAL_MEMORY_ENABLED: false,
            M365_ACTIONS_ENABLED: false,
            M365_AUTO_BOOT_PROMPT: false,
        });
        jest.clearAllMocks();
    });

    afterEach(() => {
        Object.assign(ConfigManager.CONFIG, original);
    });

    function makeContext(pageUrl, evaluateResult = { blocked: false, composerCount: 1 }) {
        const page = {
            goto: jest.fn().mockResolvedValue(),
            url: jest.fn(() => pageUrl),
            evaluate: jest.fn().mockResolvedValue(evaluateResult),
            bringToFront: jest.fn().mockResolvedValue(),
            context: jest.fn(() => ({ newCDPSession: jest.fn().mockResolvedValue({ send: jest.fn() }) })),
        };
        const context = {
            pages: jest.fn(() => [page]),
            newPage: jest.fn().mockResolvedValue(page),
            browser: jest.fn(() => ({ isConnected: () => true })),
        };
        return { page, context };
    }

    test('opens canonical chat with the M365 browser policy and sends no boot message', async () => {
        const { page, context } = makeContext('https://m365.cloud.microsoft/chat');
        BrowserLauncher.launch.mockResolvedValue(context);
        const brain = new GolemBrain({ golemId: 'm365-ready-test' });
        brain.status = 'error';

        await brain.init();

        expect(brain.isInitialized).toBe(true);
        expect(brain.status).toBe('running');
        expect(page.goto).toHaveBeenCalledWith(
            'https://m365.cloud.microsoft/chat',
            expect.objectContaining({ waitUntil: 'domcontentloaded' })
        );
        expect(BrowserLauncher.launch).toHaveBeenCalledWith(expect.objectContaining({
            browserPolicy: expect.objectContaining({
                id: 'm365-web',
                autoCleanProfileLocks: false,
                stealthDefault: false,
            }),
        }));
        expect(PageInteractor).not.toHaveBeenCalled();
        expect(brain.memoryDriver.init).not.toHaveBeenCalled();
        expect(brain.wikiManager.init).not.toHaveBeenCalled();
    });

    test('stops at the human login boundary without reading DOM or sending text', async () => {
        const { page, context } = makeContext('https://login.microsoftonline.com/common/login');
        BrowserLauncher.launch.mockResolvedValue(context);
        const brain = new GolemBrain({ golemId: 'm365-login-test' });

        await expect(brain.init()).rejects.toMatchObject({ code: 'M365_HUMAN_LOGIN_REQUIRED' });

        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.evaluate).not.toHaveBeenCalled();
        expect(PageInteractor).not.toHaveBeenCalled();
        expect(brain.isInitialized).toBe(false);
        expect(brain.status).toBe('error');
    });

    test('rejects a configured target outside the Microsoft allowlist before navigation', async () => {
        ConfigManager.CONFIG.M365_COPILOT_URLS = ['https://example.com/chat'];
        const { page, context } = makeContext('about:blank');
        BrowserLauncher.launch.mockResolvedValue(context);
        const brain = new GolemBrain({ golemId: 'm365-host-test' });

        await expect(brain.init()).rejects.toMatchObject({ code: 'M365_UNEXPECTED_HOST' });
        expect(page.goto).not.toHaveBeenCalled();
    });

    test('rejects a non-HTTPS Microsoft target before navigation', async () => {
        ConfigManager.CONFIG.M365_COPILOT_URLS = ['http://m365.cloud.microsoft/chat'];
        const { page, context } = makeContext('about:blank');
        BrowserLauncher.launch.mockResolvedValue(context);
        const brain = new GolemBrain({ golemId: 'm365-https-test' });

        await expect(brain.init()).rejects.toMatchObject({ code: 'M365_INSECURE_URL' });
        expect(page.goto).not.toHaveBeenCalled();
    });

    test('blocks slash commands other than new before touching the browser', async () => {
        const brain = new GolemBrain({ golemId: 'm365-command-gate-test' });

        await expect(brain.sendMessage('/update')).resolves.toEqual({
            text: expect.stringContaining('斜線命令'),
            attachments: [],
        });
        expect(BrowserLauncher.launch).not.toHaveBeenCalled();
        expect(PageInteractor).not.toHaveBeenCalled();
    });

    test('passes the first project-turn bootstrap flag and local persona directory into the M365 envelope', async () => {
        ConfigManager.CONFIG.M365_ACTIONS_ENABLED = true;
        const { page, context } = makeContext('https://m365.cloud.microsoft/chat/conversation/test');
        const brain = new GolemBrain({ golemId: 'm365-bootstrap-envelope-test' });
        brain.page = page;
        brain.context = context;
        brain.isInitialized = true;
        brain._refreshWebBackendDefinition();
        brain._withToolRoutingHint = jest.fn().mockResolvedValue('<tool-routing>command</tool-routing>\n\n查看根目錄');

        await brain.sendMessage('查看根目錄', false, { m365Bootstrap: true });

        expect(ProtocolFormatter.buildEnvelope).toHaveBeenCalledWith(
            expect.stringContaining('<tool-routing>'),
            'req-m365',
            expect.objectContaining({
                webBackendId: 'm365-web',
                safeMode: true,
                actionsEnabled: true,
                m365Bootstrap: true,
                userDataDir: brain.userDataDir,
            })
        );
    });

    test('keeps tool-vector routing enabled with an isolated local embedder while long-term memory stays off', async () => {
        ConfigManager.CONFIG.M365_ACTIONS_ENABLED = true;
        const brain = new GolemBrain({ golemId: 'm365-tool-vector-test' });
        brain._refreshWebBackendDefinition();

        expect(brain.isLocalContextEnabled()).toBe(false);
        expect(brain.isToolVectorRoutingEnabled()).toBe(true);
        expect(brain.memoryDriver.init).not.toHaveBeenCalled();

        const embedder = brain._resolveToolVectorEmbedder();
        await expect(embedder.embedQuery('查看專案根目錄')).resolves.toEqual([0.1, 0.2, 0.3]);
        expect(LocalProvider).toHaveBeenCalledWith(ConfigManager.CONFIG.LOCAL_EMBEDDING_MODEL);
        expect(brain.memoryDriver.init).not.toHaveBeenCalled();
    });

    test('starts tool-vector synchronization during M365 initialization when actions are enabled', async () => {
        ConfigManager.CONFIG.M365_ACTIONS_ENABLED = true;
        const { context } = makeContext('https://m365.cloud.microsoft/chat');
        BrowserLauncher.launch.mockResolvedValue(context);
        const brain = new GolemBrain({ golemId: 'm365-tool-vector-init-test' });
        brain._syncToolVectorIndex = jest.fn().mockResolvedValue();

        await brain.init();

        expect(brain._syncToolVectorIndex).toHaveBeenCalledTimes(1);
        expect(brain.memoryDriver.init).not.toHaveBeenCalled();
    });

    test('blocks background worker creation in safe mode', async () => {
        const brain = new GolemBrain({ golemId: 'm365-worker-gate-test' });

        await expect(brain.createEphemeralWorker()).rejects.toMatchObject({
            code: 'M365_POC_FEATURE_DISABLED',
        });
        expect(BrowserLauncher.launch).not.toHaveBeenCalled();
    });

    test('clears M365-only gates when switching to an API backend', () => {
        const brain = new GolemBrain({ golemId: 'm365-switch-test' });
        expect(brain.areActionsEnabled()).toBe(false);
        expect(brain.isLocalContextEnabled()).toBe(false);

        brain.backend = 'ollama';
        brain._refreshWebBackendDefinition();

        expect(brain.webBackend).toBeNull();
        expect(brain.areActionsEnabled()).toBe(true);
        expect(brain.isLocalContextEnabled()).toBe(true);
    });
});
