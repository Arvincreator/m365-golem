'use strict';

const {
    buildContextualToolRoutingQuery,
    shouldUsePriorRoutingContext,
} = require('../src/services/ToolRoutingContext');

describe('ToolRoutingContext', () => {
    test('carries the prior target into a short verification follow-up', () => {
        const messages = [
            { id: 'u1', role: 'user', source: 'user', content: '這是 SharePoint 資料夾：https://tenant.sharepoint.com/sites/demo/Shared%20Documents' },
            { id: 'a1', role: 'assistant', source: 'assistant', content: '可以協助。' },
            { id: 'u2', role: 'user', source: 'user', content: '那用 M365 Bridge 測試看看' },
        ];

        const result = buildContextualToolRoutingQuery('那用 M365 Bridge 測試看看', messages, { currentMessageId: 'u2' });
        expect(result).toContain('https://tenant.sharepoint.com/sites/demo/Shared%20Documents');
        expect(result).toContain('[Current request]\n那用 M365 Bridge 測試看看');
    });

    test('keeps a self-contained or ordinary message unchanged', () => {
        expect(shouldUsePriorRoutingContext('請解釋量子運算')).toBe(false);
        expect(buildContextualToolRoutingQuery('請解釋量子運算', [
            { id: 'u1', role: 'user', source: 'user', content: '刪除上一份檔案' },
        ])).toBe('請解釋量子運算');
    });
});
