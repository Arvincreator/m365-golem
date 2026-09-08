const { ResponseExtractor } = require('../packages/protocol');

describe('ResponseExtractor bounded M365 waits', () => {
    let originalDocument;
    let originalWindow;
    let originalHTMLElement;

    beforeEach(() => {
        originalDocument = global.document;
        originalWindow = global.window;
        originalHTMLElement = global.HTMLElement;
        jest.useFakeTimers();
    });

    afterEach(() => {
        global.document = originalDocument;
        global.window = originalWindow;
        global.HTMLElement = originalHTMLElement;
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

    test('recheck recovers the newest stable unwrapped response and visible Word preview file', async () => {
        class FakeHTMLElement {}
        const selector = '[role="article"].fai-CopilotMessage';
        const fileButton = new FakeHTMLElement();
        Object.assign(fileButton, {
            id: 'https://contoso.sharepoint.com/report.docx?web=1',
            innerText: '第006期_數位轉型週報摘要.docx',
            textContent: '第006期_數位轉型週報摘要.docx',
            disabled: false,
            getBoundingClientRect: () => ({ width: 240, height: 32 }),
            getAttribute: jest.fn(() => null),
        });
        const candidate = new FakeHTMLElement();
        Object.assign(candidate, {
            innerText: 'Word 檔已生成，可直接下載。',
            textContent: 'Word 檔已生成，可直接下載。',
            parentElement: null,
            closest: jest.fn((value) => value === selector ? candidate : null),
            querySelectorAll: jest.fn(() => []),
        });
        global.HTMLElement = FakeHTMLElement;
        global.window = {
            location: { href: 'https://m365.cloud.microsoft/chat/conversation/test' },
            getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        };
        global.document = {
            querySelectorAll: jest.fn((value) => {
                if (value === selector) return [candidate];
                if (value === 'button[id^="https://"], [role="button"][id^="https://"]') return [fileButton];
                return [];
            }),
        };
        const page = { evaluate: jest.fn((callback, args) => callback(args)) };

        const result = await ResponseExtractor.inspectExistingResponse(
            page,
            selector,
            '[[BEGIN:test]]',
            '[[END:test]]',
            {
                responseContainerSelectors: [selector],
                stopSelectors: ['.never-busy'],
                allowUnwrapped: true,
                baselineText: '舊回覆',
            }
        );

        expect(result).toEqual(expect.objectContaining({
            found: true,
            busy: false,
            status: 'FALLBACK_RECOVERED',
            text: 'Word 檔已生成，可直接下載。',
        }));
        expect(result.attachments).toEqual([
            expect.objectContaining({
                kind: 'download',
                name: '第006期_數位轉型週報摘要.docx',
            }),
        ]);
    });

    test('captures an M365 Word link whose file extension is stored in the SharePoint file query parameter', async () => {
        const selector = '[role="article"].fai-CopilotMessage';
        const anchor = {
            href: 'https://contoso.sharepoint.com/_layouts/15/Doc.aspx?sourcedoc=%7B123%7D&file=%E7%AC%AC006%E6%9C%9F_%E6%95%B8%E4%BD%8D%E8%BD%89%E5%9E%8B%E9%80%B1%E5%A0%B1%E6%91%98%E8%A6%81.docx&action=default',
            innerText: '第006期_數位轉型週報摘要',
            textContent: '第006期_數位轉型週報摘要',
            hasAttribute: jest.fn(() => false),
            getAttribute: jest.fn(() => ''),
            matches: jest.fn(() => false),
            closest: jest.fn(() => null),
        };
        const candidate = {
            tagName: 'DIV',
            innerText: '[[BEGIN:test]][GOLEM_REPLY]完成[/GOLEM_REPLY][[END:test]]',
            textContent: '[[BEGIN:test]][GOLEM_REPLY]完成[/GOLEM_REPLY][[END:test]]',
            isContentEditable: false,
            parentElement: null,
            getAttribute: jest.fn(() => ''),
            matches: jest.fn((value) => value === selector),
            closest: jest.fn((value) => value === selector ? candidate : null),
            querySelectorAll: jest.fn((value) => value === 'a' ? [anchor] : []),
        };
        global.window = { location: { href: 'https://m365.cloud.microsoft/chat/conversation/test' } };
        global.document = {
            querySelectorAll: jest.fn((value) => value === selector ? [candidate] : []),
        };
        const page = { evaluate: jest.fn((callback, args) => callback(args)) };

        const result = await ResponseExtractor.waitForResponse(
            page,
            selector,
            '[[BEGIN:test]]',
            '[[END:test]]',
            '',
            {
                timeoutMs: 1000,
                responseContainerSelectors: [selector],
                stopSelectors: ['.never-busy'],
            }
        );

        expect(result.status).toBe('ENVELOPE_COMPLETE');
        expect(result.attachments).toEqual([
            expect.objectContaining({
                kind: 'download',
                name: '第006期_數位轉型週報摘要.docx',
                url: expect.stringContaining('Doc.aspx'),
            }),
        ]);
    });

    test('separates M365 citations from downloads and drops citation favicons', () => {
        const longTeamsSource = 'https://teams.microsoft.com/l/message/19:example@thread.tacv2/1788489296895?tenantId=tenant&groupId=group&parentMessageId=1788489296895&teamName=' + 'digital-transformation-'.repeat(12) + '&channelName=weekly-report';
        const artifacts = ResponseExtractor.normalizeVisibleArtifacts([
            {
                elementType: 'image',
                url: 'https://services.bingapis.com/favicon?url=ecovistw.sharepoint.com',
                width: 32,
                height: 32,
                alt: 'site icon',
            },
            {
                elementType: 'image',
                url: 'https://res.cdn.office.net/files/fabric-cdn-prod_20260623.001/assets/item-types/24/xlsx.svg',
                width: 150,
                height: 150,
                alt: 'xlsx',
            },
            {
                elementType: 'link',
                url: 'https://ecovistw.sharepoint.com/sites/AI-inside',
                name: 'AI-inside SharePoint',
                isCitation: true,
            },
            {
                elementType: 'link',
                url: 'https://contoso.example/reports/source.pdf',
                name: '原始研究報告',
                isCitation: true,
            },
            {
                elementType: 'link',
                url: longTeamsSource,
                name: '數位轉型週報 Teams 頻道',
                isCitation: true,
            },
            {
                elementType: 'link',
                url: 'https://m365.cloud.microsoft/generated/template.xlsx',
                name: '下載「收支明細表_空白範本.xlsx」',
                hasDownload: true,
            },
        ], { includeSources: true });

        expect(artifacts).toEqual([
            expect.objectContaining({
                kind: 'source',
                name: 'AI-inside SharePoint',
                url: 'https://ecovistw.sharepoint.com/sites/AI-inside',
            }),
            expect.objectContaining({
                kind: 'source',
                name: '原始研究報告',
                url: 'https://contoso.example/reports/source.pdf',
            }),
            expect.objectContaining({
                kind: 'source',
                name: '數位轉型週報 Teams 頻道',
                url: longTeamsSource,
            }),
            expect.objectContaining({
                kind: 'download',
                name: '下載「收支明細表_空白範本.xlsx」',
            }),
        ]);
        expect(artifacts[2].url).toBe(longTeamsSource);
        expect(artifacts.some((item) => item.url.includes('bingapis.com/favicon'))).toBe(false);
        expect(artifacts.some((item) => item.url.includes('/assets/item-types/'))).toBe(false);
    });
});
