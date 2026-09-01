const {
    classifyUrl,
    extractM365ConversationLocator,
    getWebBackendDefinition,
    inspectPageState,
} = require('../src/core/web_backends');

describe('m365-web backend definition', () => {
    const config = {
        M365_COPILOT_URLS: [],
        M365_POC_SAFE_MODE: true,
        M365_LOCAL_MEMORY_ENABLED: false,
        M365_ACTIONS_ENABLED: false,
        M365_AUTO_BOOT_PROMPT: false,
    };

    test('defaults to a text-only, human-authenticated Edge POC', () => {
        const definition = getWebBackendDefinition('m365-web', config);

        expect(definition.urls).toEqual(['https://m365.cloud.microsoft/chat']);
        expect(definition.safeMode).toBe(true);
        expect(definition.localHistoryEnabled).toBe(false);
        expect(definition.localContextEnabled).toBe(false);
        expect(definition.actionsEnabled).toBe(false);
        expect(definition.autoBootPromptEnabled).toBe(false);
        expect(definition.allowExternalSelectorHealing).toBe(false);
        expect(definition.browserPolicy).toEqual(expect.objectContaining({
            preferredChannel: 'msedge',
            stealthDefault: false,
            blockHeavyResourcesDefault: false,
            autoCleanProfileLocks: false,
            forceHeaded: true,
        }));
        expect(definition.responseContainerSelectors).not.toContain('article');
        expect(definition.responseContainerSelectors).not.toContain('[role="article"]');
        expect(definition.composerSelectors).not.toContain('textarea');
        expect(definition.composerSelectors).not.toContain('div[contenteditable="true"]');
        expect(definition.composerSelectors).toEqual(expect.arrayContaining([
            'textarea[placeholder*="Ask" i]',
            'textarea[placeholder*="Copilot" i]',
        ]));
        expect(definition.responseContainerSelectors).toEqual(expect.arrayContaining([
            '[role="article"].fai-CopilotMessage [data-testid="lastChatMessage"]',
            'div[data-content="ai-message"]',
            '[data-message-author="bot"]',
            '[data-testid="bot-message"]',
            'cib-response-container',
            '.response-text',
        ]));
        expect(definition.responseContainerSelectors).not.toContain('.b_sydConvCont');
        expect(definition.responseDiagnosticSelectors).toEqual(expect.arrayContaining([
            '.b_sydConvCont',
            'cib-message-group',
        ]));
        expect(definition.responseTimeoutMs).toBe(60000);
        expect(definition.unwrappedResponseStableThreshold).toBe(10);
        expect(definition.stopSelectors).toEqual(expect.arrayContaining([
            '[data-is-typing="true"]',
            '[data-activity="typing"]',
        ]));
    });

    test('bounds the configurable M365 response timeout', () => {
        expect(getWebBackendDefinition('m365-web', {
            ...config,
            M365_RESPONSE_TIMEOUT_MS: 1000,
        }).responseTimeoutMs).toBe(10000);
        expect(getWebBackendDefinition('m365-web', {
            ...config,
            M365_RESPONSE_TIMEOUT_MS: 999999,
        }).responseTimeoutMs).toBe(300000);
    });

    test('safe mode suppresses boot messages even if a stale setting enables them', () => {
        const definition = getWebBackendDefinition('m365-web', {
            ...config,
            M365_AUTO_BOOT_PROMPT: true,
        });

        expect(definition.safeMode).toBe(true);
        expect(definition.autoBootPromptEnabled).toBe(false);
    });

    test('keeps browser transport safety separate from explicitly enabled local actions', () => {
        const definition = getWebBackendDefinition('m365-web', {
            ...config,
            M365_ACTIONS_ENABLED: true,
        });

        expect(definition.safeMode).toBe(true);
        expect(definition.actionsEnabled).toBe(true);
        expect(definition.autoBootPromptEnabled).toBe(false);
        expect(definition.localContextEnabled).toBe(false);
    });

    test('classifies chat, login, and unknown hosts separately', () => {
        const definition = getWebBackendDefinition('m365-web', config);

        expect(classifyUrl(definition, 'https://m365.cloud.microsoft/chat').status).toBe('expected_host');
        expect(classifyUrl(definition, 'http://m365.cloud.microsoft/chat').status).toBe('insecure_url');
        expect(classifyUrl(definition, 'https://login.microsoftonline.com/common/oauth2/authorize').status).toBe('human_login_required');
        expect(classifyUrl(definition, 'https://example.com/chat').status).toBe('unexpected_host');
    });

    test('extracts only allowlisted M365 conversation locators', () => {
        const definition = getWebBackendDefinition('m365-web', config);

        expect(extractM365ConversationLocator(
            definition,
            'https://m365.cloud.microsoft/chat/conversation/abc-123'
        )).toEqual(expect.objectContaining({
            status: 'expected_host',
            isConversation: true,
            conversationId: 'abc-123',
        }));
        expect(extractM365ConversationLocator(
            definition,
            'https://m365.cloud.microsoft/chat'
        )).toEqual(expect.objectContaining({
            status: 'expected_host',
            isConversation: false,
            conversationId: null,
        }));
        expect(extractM365ConversationLocator(
            definition,
            'https://example.com/chat/conversation/abc-123'
        )).toEqual(expect.objectContaining({
            status: 'unexpected_host',
            isConversation: false,
        }));
    });

    test('reports login without reading page DOM', async () => {
        const definition = getWebBackendDefinition('m365-web', config);
        const page = {
            url: jest.fn(() => 'https://login.microsoftonline.com/common/login'),
            evaluate: jest.fn(),
        };

        await expect(inspectPageState(page, definition)).resolves.toEqual(expect.objectContaining({
            status: 'human_login_required',
        }));
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    test('requires a visible M365 composer before reporting ready', async () => {
        const definition = getWebBackendDefinition('m365-web', config);
        const page = {
            url: jest.fn(() => 'https://m365.cloud.microsoft/chat'),
            evaluate: jest.fn().mockResolvedValue({ blocked: false, composerCount: 1 }),
        };

        await expect(inspectPageState(page, definition)).resolves.toEqual(expect.objectContaining({
            status: 'ready',
            composerCount: 1,
        }));
    });
});
