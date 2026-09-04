'use strict';

const {
    isNearChatBottom,
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

    test('detects whether the reader is still following the latest message', () => {
        expect(isNearChatBottom({ scrollTop: 900, clientHeight: 400, scrollHeight: 1350 })).toBe(true);
        expect(isNearChatBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1350 })).toBe(false);
        expect(isNearChatBottom({ scrollTop: 0, clientHeight: 600, scrollHeight: 500 })).toBe(true);
    });
});
