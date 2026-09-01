const { ResponseExtractor } = require('../packages/protocol');

describe('ResponseExtractor bounded M365 waits', () => {
    let originalDocument;

    beforeEach(() => {
        originalDocument = global.document;
        jest.useFakeTimers();
    });

    afterEach(() => {
        global.document = originalDocument;
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('times out even when no response selector ever matches', async () => {
        global.document = {
            querySelectorAll: jest.fn(() => []),
        };
        const page = {
            evaluate: jest.fn((callback, args) => callback(args)),
        };

        const pending = ResponseExtractor.waitForResponse(
            page,
            '[data-content="ai-message"]',
            '[[BEGIN:test]]',
            '[[END:test]]',
            '',
            { timeoutMs: 1000, diagnosticSelectors: ['[data-content="chat-message"]'] }
        );

        await jest.advanceTimersByTimeAsync(1000);
        await expect(pending).resolves.toEqual(expect.objectContaining({
            status: 'TIMEOUT',
            text: '',
            diagnostics: expect.objectContaining({
                iframeCount: 0,
                selectors: [expect.objectContaining({
                    selector: '[data-content="chat-message"]',
                    count: 0,
                })],
            }),
        }));
    });

    test('diagnostics expose only attributes and text length, never message content', async () => {
        const candidate = {
            tagName: 'DIV',
            innerText: 'tenant secret answer',
            textContent: 'tenant secret answer',
            getAttribute: jest.fn((name) => ({
                role: 'article',
                'aria-label': 'Copilot response',
                'data-testid': 'bot-message',
                class: 'response-text tenant-generated-class',
            }[name] || '')),
        };
        global.document = {
            querySelectorAll: jest.fn((selector) => selector === '.candidate' ? [candidate] : []),
        };
        const page = {
            evaluate: jest.fn((callback, args) => callback(args)),
        };

        const pending = ResponseExtractor.waitForResponse(
            page,
            '.no-match',
            '[[BEGIN:test]]',
            '[[END:test]]',
            '',
            { timeoutMs: 1000, diagnosticSelectors: ['.candidate'] }
        );

        await jest.advanceTimersByTimeAsync(1000);
        const result = await pending;
        const serialized = JSON.stringify(result.diagnostics);

        expect(result.diagnostics.selectors[0]).toEqual(expect.objectContaining({
            selector: '.candidate',
            count: 1,
            lastTag: 'div',
            lastTextLength: 'tenant secret answer'.length,
        }));
        expect(serialized).not.toContain('tenant secret answer');
    });

    test('captures the live M365 CopilotMessage response node without requiring an envelope', async () => {
        const selector = '[role="article"].fai-CopilotMessage [data-testid="lastChatMessage"]';
        const candidate = {
            tagName: 'DIV',
            innerText: 'POC-M365-READY',
            textContent: 'POC-M365-READY',
            isContentEditable: false,
            parentElement: null,
            getAttribute: jest.fn((name) => ({
                'data-testid': 'lastChatMessage',
                contenteditable: '',
            }[name] || '')),
            matches: jest.fn((value) => value === selector),
            closest: jest.fn((value) => value === selector ? candidate : null),
            querySelectorAll: jest.fn(() => []),
        };
        global.document = {
            querySelectorAll: jest.fn((value) => value === selector ? [candidate] : []),
        };
        const page = {
            evaluate: jest.fn((callback, args) => callback(args)),
        };

        const pending = ResponseExtractor.waitForResponse(
            page,
            selector,
            '[[BEGIN:test]]',
            '[[END:test]]',
            '',
            {
                timeoutMs: 60000,
                stableGraceMultiplier: 1,
                stableFallbackThreshold: 10,
                responseContainerSelectors: [selector],
                stopSelectors: ['.never-busy'],
                extractAttachments: false,
            }
        );

        await jest.advanceTimersByTimeAsync(6000);
        await expect(pending).resolves.toEqual(expect.objectContaining({
            status: 'FALLBACK_DIFF',
            text: 'POC-M365-READY',
            matchedSelector: selector,
        }));
    });
});
