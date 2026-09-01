'use strict';

const { URLS } = require('../constants');

const DEFAULT_GEMINI_SELECTORS = Object.freeze({
    input: 'textarea, div[contenteditable="true"], rich-textarea > div, p[data-placeholder], .ql-editor',
    send: 'button[aria-label*="Send" i], button[aria-label*="傳送"], button[aria-label*="Submit" i], span[data-icon="send"], button.bg-primary',
    response: '.model-response-text, .message-content, .markdown, div[data-test-id="message-content"], .prose',
    upload: 'input[type="file"], button[aria-label*="Add image" i], button[aria-label*="上傳"], button[aria-label*="圖片"]',
});

const M365_COMPOSER_SELECTORS = Object.freeze([
    '[data-testid*="composer" i] textarea',
    '[data-testid*="composer" i] [contenteditable="true"]',
    'textarea[aria-label*="message" i]',
    'textarea[placeholder*="message" i]',
    'textarea[aria-label*="prompt" i]',
    'textarea[placeholder*="prompt" i]',
    'textarea[aria-label*="Ask" i]',
    'textarea[placeholder*="Ask" i]',
    'textarea[aria-label*="Copilot" i]',
    'textarea[placeholder*="Copilot" i]',
    'div[role="textbox"][aria-label*="message" i][contenteditable="true"]',
    'div[role="textbox"][aria-label*="prompt" i][contenteditable="true"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
]);

const M365_RESPONSE_SELECTORS = Object.freeze([
    // Live m365.cloud.microsoft UI (verified 2026-08-31): the newest Copilot
    // answer text is exposed as lastChatMessage inside a CopilotMessage article.
    // Keep the assistant-specific ancestor so a user's own article can never be
    // mistaken for the response.
    '[role="article"].fai-CopilotMessage [data-testid="lastChatMessage"]',
    '[data-content-role="assistant"]',
    '[data-author="assistant"]',
    '[data-message-author-role="assistant"]',
    'div[data-content="ai-message"] .group\\/ai-message-item',
    'div[data-content="ai-message"]',
    '[data-message-author="bot"]',
    '[data-content="response"]',
    '[data-testid*="assistant" i]',
    '[data-testid*="response" i]',
    '[data-testid="answer"]',
    '[data-testid="bot-message"]',
    '[data-content-role="assistant"] [data-testid*="message-content" i]',
    '[data-author="assistant"] [data-testid*="message-content" i]',
    '[data-message-author-role="assistant"] [data-testid*="message-content" i]',
    '[role="article"][aria-label*="Copilot" i]',
    'cib-response-container',
    '.response-text',
    '.text-response',
]);

// Diagnostics may inspect broader containers, but they are never used to return
// a reply. This prevents the user's own prompt from being mistaken for Copilot.
const M365_RESPONSE_DIAGNOSTIC_SELECTORS = Object.freeze([
    ...M365_RESPONSE_SELECTORS,
    '[data-content="chat-message"]',
    '.b_sydConvCont',
    'cib-message-group',
    '[role="article"]',
    '[data-testid*="message" i]',
]);

const M365_READY_COMPOSER_SELECTORS = Object.freeze([
    '[data-testid*="composer" i] textarea',
    '[data-testid*="composer" i] [contenteditable="true"]',
    'textarea[aria-label*="message" i]',
    'textarea[placeholder*="message" i]',
    'textarea[aria-label*="prompt" i]',
    'textarea[placeholder*="prompt" i]',
    'textarea[aria-label*="Ask" i]',
    'textarea[placeholder*="Ask" i]',
    'textarea[aria-label*="Copilot" i]',
    'textarea[placeholder*="Copilot" i]',
    'div[role="textbox"][aria-label*="message" i][contenteditable="true"]',
    'div[role="textbox"][aria-label*="prompt" i][contenteditable="true"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
]);

const M365_BLOCKED_PHRASES = Object.freeze([
    'copilot chat is unavailable because of organizational policy',
    'copilot chat has been turned off for your organization',
    'your organization has disabled copilot',
    'copilot chat 已由您的組織關閉',
    '您的組織已停用 copilot',
    '因組織原則而無法使用 copilot',
]);

function normalizeUrlList(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(',');
    return source.map((item) => String(item || '').trim()).filter(Boolean);
}

function hostMatches(hostname, candidates) {
    const host = String(hostname || '').toLowerCase();
    return candidates.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

function parseUrl(urlValue) {
    try {
        return new URL(String(urlValue || ''));
    } catch (_) {
        return null;
    }
}

function classifyUrl(definition, urlValue) {
    const parsed = parseUrl(urlValue);
    if (!parsed) return { status: 'invalid_url', url: String(urlValue || ''), host: '' };
    const host = parsed.hostname.toLowerCase();
    if (definition.requireHttps && parsed.protocol !== 'https:') {
        return { status: 'insecure_url', url: parsed.toString(), host };
    }
    if (hostMatches(host, definition.authHosts || [])) {
        return { status: 'human_login_required', url: parsed.toString(), host };
    }
    if (hostMatches(host, definition.expectedHosts || [])) {
        return { status: 'expected_host', url: parsed.toString(), host };
    }
    return { status: 'unexpected_host', url: parsed.toString(), host };
}

function extractM365ConversationLocator(definition, urlValue) {
    const classified = classifyUrl(definition, urlValue);
    if (classified.status !== 'expected_host') {
        return {
            ...classified,
            isConversation: false,
            conversationId: null,
        };
    }

    const parsed = parseUrl(classified.url);
    const match = parsed && parsed.pathname.match(/^\/chat\/conversation\/([^/?#]+)\/?$/i);
    return {
        ...classified,
        isConversation: !!match,
        conversationId: match ? decodeURIComponent(match[1]) : null,
    };
}

function makeGeminiDefinition(config) {
    const configuredUrls = normalizeUrlList(config && config.GEMINI_URLS);
    return {
        id: 'gemini',
        label: 'Gemini Web',
        urls: configuredUrls.length > 0
            ? configuredUrls
            : [URLS.GEMINI_APP, ...URLS.GEMINI_FALLBACKS],
        expectedHosts: ['gemini.google.com'],
        authHosts: ['accounts.google.com'],
        selectors: { ...DEFAULT_GEMINI_SELECTORS },
        composerSelectors: [
            '.ProseMirror',
            '.ql-editor',
            'rich-textarea .ProseMirror',
            'rich-textarea .ql-editor',
            'rich-textarea div[contenteditable="true"]',
            'div[role="textbox"][contenteditable="true"]',
            'div[contenteditable="true"]',
            'textarea',
        ],
        responseContainerSelectors: [
            'model-response',
            '.model-response-text',
            '.message-content',
            '[data-message-id]',
            '.conversation-turn',
            '.markdown',
        ],
        stopSelectors: [
            'button[aria-label*="Stop" i]',
            'button[aria-label*="停止" i]',
            '[data-testid*="stop" i]',
        ],
        sendLabelTerms: ['傳送訊息', '送出訊息', '發送訊息', 'send message', 'submit message'],
        safeMode: false,
        localHistoryEnabled: true,
        localContextEnabled: true,
        actionsEnabled: true,
        autoBootPromptEnabled: true,
        allowExternalSelectorHealing: true,
        browserPolicy: {
            id: 'gemini',
            label: 'Gemini Web',
            stealthEnvKey: 'PLAYWRIGHT_STEALTH_ENABLED',
            stealthDefault: true,
            blockHeavyResourcesDefault: true,
            autoCleanProfileLocks: true,
            channelEnvKey: 'PLAYWRIGHT_BROWSER_CHANNEL',
        },
    };
}

function makePerplexityDefinition() {
    return {
        ...makeGeminiDefinition({ GEMINI_URLS: [] }),
        id: 'perplexity',
        label: 'Perplexity Web',
        urls: [URLS.PERPLEXITY_APP],
        expectedHosts: ['perplexity.ai'],
        authHosts: [],
        browserPolicy: {
            ...makeGeminiDefinition({ GEMINI_URLS: [] }).browserPolicy,
            id: 'perplexity',
            label: 'Perplexity Web',
        },
    };
}

function makeM365Definition(config) {
    const configuredUrls = normalizeUrlList(config && config.M365_COPILOT_URLS);
    const safeMode = !config || config.M365_POC_SAFE_MODE !== false;
    const localMemoryEnabled = !!(config && config.M365_LOCAL_MEMORY_ENABLED);
    // Safe mode protects the visible M365 browser transport (no background send,
    // no boot prompt, no automatic retry). Local Golem tool routing is a separate
    // capability and remains subject to the Action Gate.
    const actionsEnabled = !!(config && config.M365_ACTIONS_ENABLED);
    const configuredResponseTimeoutMs = Number(config && config.M365_RESPONSE_TIMEOUT_MS);
    const responseTimeoutMs = Number.isFinite(configuredResponseTimeoutMs) && configuredResponseTimeoutMs > 0
        ? Math.min(300000, Math.max(10000, configuredResponseTimeoutMs))
        : 60000;
    return {
        id: 'm365-web',
        label: 'Microsoft 365 Copilot Chat',
        requireHttps: true,
        urls: configuredUrls.length > 0 ? configuredUrls : [URLS.M365_COPILOT_CHAT],
        expectedHosts: ['m365.cloud.microsoft', 'm365copilot.com', 'copilot.cloud.microsoft'],
        authHosts: [
            'login.microsoftonline.com',
            'login.microsoft.com',
            'login.live.com',
            'mysignins.microsoft.com',
            'account.activedirectory.windowsazure.com',
        ],
        selectors: {
            input: M365_COMPOSER_SELECTORS.join(', '),
            send: [
                'button[aria-label*="Send" i]',
                'button[aria-label*="Submit" i]',
                'button[title*="Send" i]',
                'button[data-testid*="send" i]',
                '[role="button"][aria-label*="Send" i]',
                'button[aria-label*="傳送"]',
                'button[aria-label*="送出"]',
            ].join(', '),
            response: M365_RESPONSE_SELECTORS.join(', '),
            upload: [
                'input[type="file"]',
                'button[aria-label*="Attach" i]',
                'button[aria-label*="Upload" i]',
                'button[aria-label*="附加"]',
                'button[aria-label*="上傳"]',
            ].join(', '),
        },
        composerSelectors: [...M365_COMPOSER_SELECTORS],
        readinessSelectors: [...M365_READY_COMPOSER_SELECTORS],
        responseContainerSelectors: [...M365_RESPONSE_SELECTORS],
        responseDiagnosticSelectors: [...M365_RESPONSE_DIAGNOSTIC_SELECTORS],
        responseTimeoutMs,
        // M365 often answers without the requested envelope. Once its visible
        // generating controls disappear, five seconds of unchanged assistant
        // text is enough to treat the reply as complete. Other backends retain
        // the original, longer Thinking-mode threshold.
        unwrappedResponseStableThreshold: 10,
        stopSelectors: [
            'button[aria-label*="Stop" i]',
            'button[aria-label*="停止" i]',
            'button[data-testid*="stop" i]',
            '[data-is-typing="true"]',
            '[data-activity="typing"]',
            '[data-state="typing"]',
            '[data-testid="typing-indicator"]',
            '.typing-indicator',
            '.is-typing',
        ],
        sendLabelTerms: [
            'send',
            'send message',
            'submit',
            'submit message',
            '傳送',
            '傳送訊息',
            '送出',
            '送出訊息',
            '發送',
            '發送訊息',
        ],
        blockedPhrases: [...M365_BLOCKED_PHRASES],
        safeMode,
        localHistoryEnabled: localMemoryEnabled && !safeMode,
        localContextEnabled: localMemoryEnabled && !safeMode,
        actionsEnabled,
        // Safe mode never sends a message on boot, even if a stale env value says otherwise.
        autoBootPromptEnabled: !!(config && config.M365_AUTO_BOOT_PROMPT) && !safeMode,
        allowExternalSelectorHealing: false,
        browserPolicy: {
            id: 'm365-web',
            label: 'Microsoft 365 Copilot Chat',
            stealthEnvKey: 'PLAYWRIGHT_M365_STEALTH_ENABLED',
            stealthDefault: false,
            blockHeavyResourcesEnvKey: 'PLAYWRIGHT_M365_BLOCK_HEAVY_RESOURCES',
            blockHeavyResourcesDefault: false,
            autoCleanProfileLocks: false,
            channelEnvKey: 'PLAYWRIGHT_M365_BROWSER_CHANNEL',
            fallbackChannelEnvKey: 'PLAYWRIGHT_BROWSER_CHANNEL',
            preferredChannel: process.platform === 'win32' ? 'msedge' : '',
            forceHeaded: true,
            ignoreDefaultArgs: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-background-networking',
                '--disable-component-update',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-sync',
            ],
            excludedArgs: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-gpu',
                '--disable-site-isolation-trials',
                '--disable-features=IsolateOrigins,site-per-process',
                '--renderer-process-limit=1',
                '--disable-sync',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-component-update',
                '--disable-default-apps',
            ],
        },
    };
}

function getWebBackendDefinition(backend, config = {}) {
    const normalized = String(backend || 'gemini').trim().toLowerCase();
    if (normalized === 'm365-web') return makeM365Definition(config);
    if (normalized === 'perplexity') return makePerplexityDefinition();
    return makeGeminiDefinition(config);
}

function isWebBackend(backend) {
    return ['gemini', 'perplexity', 'm365-web'].includes(String(backend || '').trim().toLowerCase());
}

async function inspectPageState(page, definition) {
    const currentUrl = page && typeof page.url === 'function' ? page.url() : '';
    const urlState = classifyUrl(definition, currentUrl);
    if (urlState.status !== 'expected_host') return urlState;
    if (definition.id !== 'm365-web') return { ...urlState, status: 'ready' };

    const result = await page.evaluate(({ composerSelectors, blockedPhrases }) => {
        const isVisible = (node) => {
            if (!node || !(node instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const matched = [];
        for (const selector of composerSelectors) {
            try {
                matched.push(...document.querySelectorAll(selector));
            } catch (_) { }
        }
        const visibleComposers = [...new Set(matched)].filter(isVisible);
        const policyNodes = Array.from(document.querySelectorAll([
            '[role="alert"]',
            '[role="dialog"]',
            '[aria-live="assertive"]',
            '[data-testid*="error" i]',
            '[data-testid*="blocked" i]',
            '[data-testid*="unsupported" i]',
        ].join(', '))).filter(isVisible);
        const policyText = policyNodes.map((node) => String(node.innerText || node.textContent || '')).join('\n').toLowerCase();
        const blocked = blockedPhrases.some((phrase) => policyText.includes(String(phrase).toLowerCase()));
        return {
            blocked,
            composerCount: visibleComposers.length,
        };
    }, {
        composerSelectors: definition.readinessSelectors || definition.composerSelectors || [],
        blockedPhrases: definition.blockedPhrases || [],
    }).catch(() => ({ blocked: false, composerCount: 0 }));

    if (result.blocked) return { ...urlState, status: 'tenant_blocked', composerCount: result.composerCount };
    if (result.composerCount > 0) return { ...urlState, status: 'ready', composerCount: result.composerCount };
    return { ...urlState, status: 'ui_not_ready', composerCount: 0 };
}

async function waitForPageState(page, definition, options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 20000));
    const pollMs = Math.max(200, Number(options.pollMs || 500));
    const startedAt = Date.now();
    let lastState = await inspectPageState(page, definition);

    while (Date.now() - startedAt < timeoutMs) {
        if (['ready', 'human_login_required', 'tenant_blocked', 'unexpected_host', 'insecure_url', 'invalid_url'].includes(lastState.status)) {
            return lastState;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        lastState = await inspectPageState(page, definition);
    }
    return lastState;
}

module.exports = {
    classifyUrl,
    extractM365ConversationLocator,
    getWebBackendDefinition,
    inspectPageState,
    isWebBackend,
    waitForPageState,
};
