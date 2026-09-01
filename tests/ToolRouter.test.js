const ToolRouter = require('../src/managers/ToolRouter');

describe('ToolRouter', () => {
    test('recommends log skill for debugging/log requests', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: ['log-reader', 'log-archive']
        });

        const result = router.route('幫我看一下最近的錯誤日誌 debug');
        expect(result.skills.some(skill => skill.id === 'log-reader')).toBe(true);
    });

    test('recommends Chrome DevTools MCP tools for browser interaction', () => {
        const router = new ToolRouter({
            activeScene: 'coding',
            activeTools: ['chrome-devtools']
        });

        const hint = router.buildRoutingHint('幫我打開網頁並點擊按鈕，順便看 console error');
        expect(hint).toContain('<tool-routing>');
        expect(hint).toContain('chrome-devtools');
        expect(hint).toContain('Selected usage guide');
        expect(hint).toContain('"action": "mcp_call"');
        expect(hint).toContain('"parameters"');
    });

    test('returns empty hint for unrelated casual chat', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: []
        });

        const hint = router.buildRoutingHint('早安，今天心情不錯');
        expect(hint).toBe('');
    });

    test('tells the model to emit a read-only command action for the reported M365 root-directory request', () => {
        const router = new ToolRouter({
            activeScene: 'coding',
            activeTools: []
        });

        const hint = router.buildRoutingHint('你試看看查看我啟動 Golem 的根目錄');
        expect(hint).toContain('Relevant command lane');
        expect(hint).toContain('{"action":"command","parameter":"echo %CD%"}');
        expect(hint).toContain('Emit the smallest read-only command action now');
        expect(hint).toContain('do not merely say that you could propose it');
    });

    test('uses vector matches and includes the selected skill usage guide', async () => {
        const toolVectorIndex = {
            search: jest.fn().mockResolvedValue([{ id: 'reference-files', score: 0.9 }])
        };
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: ['reference-files'],
            toolVectorIndex
        });

        const hint = await router.buildRoutingHintAsync('請列出我提供的參考附件');
        expect(toolVectorIndex.search).toHaveBeenCalled();
        expect(hint).toContain('reference-files');
        expect(hint).toContain('Selected usage guide');
        expect(hint).toContain('"action": "reference-files"');
    });

    test('does not recommend tools for conceptual explanation requests', () => {
        const router = new ToolRouter({
            activeScene: 'coding',
            activeTools: ['chrome-devtools', 'log-reader']
        });

        const hint = router.buildRoutingHint('請解釋 Chrome DevTools 是什麼，以及 console error 的概念');
        expect(hint).toBe('');
    });

    test('marks destructive or sending tools as confirm-first', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: ['moltbot']
        });

        const result = router.route('幫我刪除 moltbot 上的貼文');
        const risky = [...result.skills, ...result.mcpTools].find(item =>
            item.id.includes('moltbot') || item.name.includes('delete')
        );
        expect(risky).toBeDefined();
        expect(risky.policy.risk).toBe('high');
        expect(risky.policy.requiresConfirmation).toBe(true);
    });

    test('does not recommend the retired stock dashboard in M365 mode', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: ['stock-dashboard']
        });

        const result = router.route('請分析台積電股市看板和 NVDA 今天的行情');
        expect(result.skills.some(skill => skill.id === 'stock-dashboard')).toBe(false);
    });
});
