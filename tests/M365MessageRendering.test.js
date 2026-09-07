'use strict';

const {
    buildM365ConversationTimeline,
    isNearChatBottom,
    isM365ExecutionTraceMessage,
    parseM365MessageContent,
} = require('../web-dashboard/src/lib/m365-message-rendering');

describe('M365 message rendering helpers', () => {
    test('turns an M365 rendered HTML gutter into one code artifact without losing prose', () => {
        const content = [
            '這是單一 HTML 檔案。',
            '',
            'HTML',
            '1', '<!DOCTYPE html>',
            '2', '<html lang="zh-Hant">',
            '3', '<body>Hello</body>',
            '4', '</html>',
            '顯示更多行',
            '',
            '存成 index.html 後即可開啟。',
        ].join('\n');

        expect(parseM365MessageContent(content)).toEqual([
            { kind: 'markdown', content: '這是單一 HTML 檔案。' },
            {
                kind: 'code',
                language: 'html',
                code: '<!DOCTYPE html>\n<html lang="zh-Hant">\n<body>Hello</body>\n</html>',
                sourceWasCollapsed: true,
            },
            { kind: 'markdown', content: '存成 index.html 後即可開啟。' },
        ]);
    });

    test('keeps ordinary prose and numbered instructions as markdown', () => {
        const content = 'HTML 是一種格式。\n1\n先建立檔案\n2\n再開啟檔案';
        expect(parseM365MessageContent(content)).toEqual([{ kind: 'markdown', content }]);
    });

    test('turns a normal fenced code block into the same code artifact shape', () => {
        const parsed = parseM365MessageContent('前言\n```json\n{"ok":true}\n```\n結語');
        expect(parsed).toEqual([
            { kind: 'markdown', content: '前言' },
            { kind: 'code', language: 'json', code: '{"ok":true}', sourceWasCollapsed: false },
            { kind: 'markdown', content: '結語' },
        ]);
    });

    test('recognizes the Plain Text label emitted by the M365 code viewer', () => {
        const content = [
            '流程',
            'Plain Text',
            '1', '使用者需求',
            '2', '↓',
            '3', '執行並核對結果',
            '4', '``',
            '下一節',
        ].join('\n');

        expect(parseM365MessageContent(content)).toEqual([
            { kind: 'markdown', content: '流程' },
            {
                kind: 'code',
                language: 'text',
                code: '使用者需求\n↓\n執行並核對結果',
                sourceWasCollapsed: false,
            },
            { kind: 'markdown', content: '下一節' },
        ]);
    });

    test('restores consecutive one-line Plain Text cards from a live M365 response', () => {
        const content = [
            '核心類',
            '',
            '1. Wiki Skill',
            'Plain Text',
            '1', 'skills/modules/wiki',
            '用途：',
            'Wiki 知識管理',
            '',
            '2. DuckDuckGo Search',
            'Plain Text',
            '1', 'skills/duckduckgo-search',
            '用途：',
            '公開網路搜尋',
        ].join('\n');

        expect(parseM365MessageContent(content)).toEqual([
            { kind: 'markdown', content: '核心類\n\n1. Wiki Skill' },
            {
                kind: 'code',
                language: 'text',
                code: 'skills/modules/wiki',
                sourceWasCollapsed: false,
            },
            { kind: 'markdown', content: '用途：\nWiki 知識管理\n\n2. DuckDuckGo Search' },
            {
                kind: 'code',
                language: 'text',
                code: 'skills/duckduckgo-search',
                sourceWasCollapsed: false,
            },
            { kind: 'markdown', content: '用途：\n公開網路搜尋' },
        ]);
    });

    test('groups one run execution trace at its latest position without hiding final answers', () => {
        const messages = [
            { id: 'u1', role: 'user', source: 'user', content: '開始研究', runId: null, stepId: null },
            { id: 'p1', role: 'assistant', source: 'm365', content: '讀取文件並確認內容，正在執行並確認中…', runId: 'run-1', stepId: 'step-1' },
            { id: 'p2', role: 'assistant', source: 'm365', content: '分析架構並核對結果，正在執行並確認中…', runId: 'run-1', stepId: 'step-2' },
            { id: 'a1', role: 'assistant', source: 'm365', content: '研究已完成，以下是結論。', runId: 'run-1', stepId: 'step-2' },
        ];

        expect(isM365ExecutionTraceMessage(messages[1])).toBe(true);
        expect(isM365ExecutionTraceMessage(messages[3])).toBe(false);
        expect(buildM365ConversationTimeline(messages)).toEqual([
            { kind: 'message', message: messages[0] },
            {
                kind: 'execution',
                runId: 'run-1',
                anchorId: 'p2',
                messages: [messages[1], messages[2]],
            },
            { kind: 'message', message: messages[3] },
        ]);
    });

    test('detects whether the reader is still following the latest message', () => {
        expect(isNearChatBottom({ scrollTop: 900, clientHeight: 400, scrollHeight: 1350 })).toBe(true);
        expect(isNearChatBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1350 })).toBe(false);
        expect(isNearChatBottom({ scrollTop: 0, clientHeight: 600, scrollHeight: 500 })).toBe(true);
    });
});
