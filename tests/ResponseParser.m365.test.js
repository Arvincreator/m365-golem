const ResponseParser = require('../src/utils/ResponseParser');

describe('ResponseParser M365 reply-only envelope', () => {
    test('returns only the visible reply from an inline closing tag', () => {
        const parsed = ResponseParser.parse(
            '[[BEGIN:m365]]\n[GOLEM_REPLY]POC-M365-READY[/GOLEM_REPLY]\n[[END:m365]]'
        );

        expect(parsed).toEqual({
            memory: null,
            projectMemory: null,
            userMemory: null,
            conversationTitle: null,
            avoidMemory: null,
            actions: [],
            reply: 'POC-M365-READY',
        });
    });

    test('strips a leaked closing marker from unstructured fallback text', () => {
        const parsed = ResponseParser.parse('Copilot reply[/GOLEM_REPLY]');

        expect(parsed.reply).toBe('Copilot reply');
    });

    test('parses an action tag that M365 places after the inline reply closing tag', () => {
        const parsed = ResponseParser.parse(
            '[[BEGIN:ptnn]]\n' +
            '[GOLEM_REPLY]\n' +
            '等待 Harness 核准與回傳結果。\n' +
            '[/GOLEM_REPLY] [GOLEM_ACTION]\n' +
            '```json\n' +
            '[{"action":"command","parameter":"echo %CD%"}]\n' +
            '```\n' +
            '[/GOLEM_ACTION] [[END:ptnn]]'
        );

        expect(parsed.reply).toBe('等待 Harness 核准與回傳結果。');
        expect(parsed.actions).toEqual([
            { action: 'command', parameter: 'echo %CD%' },
        ]);
    });

    test('parses an action when M365 innerText interleaves rendered code line numbers', () => {
        const parsed = ResponseParser.parse(
            '[[BEGIN:ik75]]\n' +
            '[GOLEM_REPLY]正在等待核准。[/GOLEM_REPLY] [GOLEM_ACTION]\n' +
            '1\n' +
            '[\n' +
            '2\n' +
            '{\n' +
            '3\n' +
            '  "action": "command",\n' +
            '4\n' +
            '  "parameter": "echo %CD%"\n' +
            '5\n' +
            '}\n' +
            '6\n' +
            ']\n' +
            '[/GOLEM_ACTION] [[END:ik75]]'
        );

        expect(parsed.reply).toBe('正在等待核准。');
        expect(parsed.actions).toEqual([
            { action: 'command', parameter: 'echo %CD%' },
        ]);
    });

    test('parses the exact M365 virtualized code chrome around a one-line action', () => {
        const parsed = ResponseParser.parse(
            '[[BEGIN:chrome]]\n' +
            '[GOLEM_REPLY]正在等待核准。[/GOLEM_REPLY]\n' +
            '[GOLEM_ACTION]\n' +
            'JSON\n' +
            '1\n' +
            '[{"action":"command","parameter":"echo %CD%"}]\n' +
            '[/GOLEM_ACTION] [[END:chrome]]'
        );

        expect(parsed.reply).toBe('正在等待核准。');
        expect(parsed.actions).toEqual([
            { action: 'command', parameter: 'echo %CD%' },
        ]);
    });

    test('does not remove standalone numbers unless they form an M365 gutter sequence', () => {
        const candidate = '1\n[\n3\n{"action":"command","parameter":"echo 7"}\n]';

        expect(ResponseParser._stripRenderedCodeLineNumbers(candidate)).toBe(candidate);
    });

    test('extracts a hidden conversation title separately from the visible reply', () => {
        const parsed = ResponseParser.parse(
            '[[BEGIN:title]]\n' +
            '[GOLEM_CONVERSATION_TITLE]整理 OneDrive 專案檔案[/GOLEM_CONVERSATION_TITLE]\n' +
            '[GOLEM_REPLY]我來幫你確認。[/GOLEM_REPLY]\n' +
            '[[END:title]]'
        );

        expect(parsed.conversationTitle).toBe('整理 OneDrive 專案檔案');
        expect(parsed.reply).toBe('我來幫你確認。');
        expect(parsed.reply).not.toContain('GOLEM_CONVERSATION_TITLE');
    });

    test('rejects multiline or protocol-like generated titles', () => {
        const multiline = ResponseParser.parse(
            '[GOLEM_CONVERSATION_TITLE]第一行\n第二行[/GOLEM_CONVERSATION_TITLE]\n' +
            '[GOLEM_REPLY]完成[/GOLEM_REPLY]'
        );
        const protocolLike = ResponseParser.parse(
            '[GOLEM_CONVERSATION_TITLE]GOLEM_ACTION 測試[/GOLEM_CONVERSATION_TITLE]\n' +
            '[GOLEM_REPLY]完成[/GOLEM_REPLY]'
        );

        expect(multiline.conversationTitle).toBeNull();
        expect(protocolLike.conversationTitle).toBeNull();
    });
});
