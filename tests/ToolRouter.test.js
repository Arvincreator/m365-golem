const ToolRouter = require('../src/managers/ToolRouter');

function makeChromeDevToolsServer() {
    return {
        name: 'chrome-devtools',
        enabled: true,
        description: 'Isolated browser inspection and automation',
        cachedTools: [{
            name: 'navigate_page',
            description: 'Navigate the browser to a URL.',
            inputSchema: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
            },
        }],
    };
}

function makeM365BridgeServer() {
    return {
        name: 'm365-session-bridge',
        enabled: true,
        description: 'SharePoint Online and OneDrive for Business exact URL operations',
        cachedTools: [
            {
                name: 'm365_bridge_status',
                description: 'Check whether the signed-in M365 session and file bridge are available.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'm365_list_folder',
                description: 'List files and sub-folders directly inside one SharePoint/OneDrive folder.',
                inputSchema: {
                    type: 'object',
                    properties: { folderUrl: { type: 'string' }, maxItems: { type: 'number' } },
                    required: ['folderUrl'],
                },
            },
            {
                name: 'm365_download_file',
                description: 'Download one SharePoint/OneDrive file from an exact URL to an allowed local path.',
                inputSchema: {
                    type: 'object',
                    properties: { fileUrl: { type: 'string' }, destinationPath: { type: 'string' } },
                    required: ['fileUrl', 'destinationPath'],
                },
            },
            {
                name: 'm365_upload_file',
                description: 'Upload one allowed local file to an exact SharePoint/OneDrive folder without overwriting by default.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        localPath: { type: 'string' },
                        destinationFolderUrl: { type: 'string' },
                        fileName: { type: 'string' },
                        overwrite: { type: 'boolean', default: false },
                    },
                    required: ['localPath', 'destinationFolderUrl', 'fileName'],
                },
            },
            {
                name: 'm365_create_folder',
                description: 'Create one or more nested folders under an exact SharePoint/OneDrive parent folder.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        parentFolderUrl: { type: 'string' },
                        folderName: { type: 'string' },
                    },
                    required: ['parentFolderUrl', 'folderName'],
                },
            },
            {
                name: 'm365_checkin_file',
                description: 'Check in one SharePoint/OneDrive file.',
                inputSchema: {
                    type: 'object',
                    properties: { fileUrl: { type: 'string' } },
                    required: ['fileUrl'],
                },
            },
            {
                name: 'm365_recycle_file',
                description: 'Move one SharePoint/OneDrive file to the recycle bin.',
                inputSchema: {
                    type: 'object',
                    properties: { fileUrl: { type: 'string' }, confirmation: { type: 'string' } },
                    required: ['fileUrl', 'confirmation'],
                },
            },
        ],
    };
}

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
            activeTools: [],
            mcpServers: [makeChromeDevToolsServer()],
        });

        const hint = router.buildRoutingHint('幫我打開網頁並點擊按鈕，順便看 console error');
        expect(hint).toContain('<tool-routing>');
        expect(hint).toContain('chrome-devtools');
        expect(hint).toContain('Relevant MCP tools');
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

    test('answers a natural-language Skill inventory question from the active package catalog', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: ['log-reader', 'reference-files']
        });

        const result = router.route('你有什麼 skill 可用？');
        const hint = router.buildRoutingHint('你有什麼 skill 可用？');

        expect(result.catalogRequest).toEqual(expect.objectContaining({ skills: true }));
        expect(result.skillCatalog.map((skill) => skill.id)).toEqual(['log-reader', 'reference-files']);
        expect(hint).toContain('<tool-routing>');
        expect(hint).toContain('Current available Skill catalog');
        expect(hint).toContain('log-reader');
        expect(hint).toContain('reference-files');
        expect(hint).toContain('Do not claim that no Skill list was provided');
        expect(hint).toContain('Do not emit a tool action merely to answer this inventory question');
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

    test('routes an autonomous interactive webpage build to the local artifact command lane', () => {
        const router = new ToolRouter({
            activeScene: 'coding',
            activeTools: ['chrome-devtools']
        });
        const query = '那你分步驟幫我製作有互動能力的網頁';

        const result = router.route(query);
        const hint = router.buildRoutingHint(query);

        expect(result.commandLane).toEqual(expect.objectContaining({
            recommended: true,
            reason: 'local_project_artifact_authoring',
        }));
        expect(hint).toContain('local project artifact creation or modification detected');
        expect(hint).toContain('maintain GOLEM_PLAN');
        expect(hint).not.toContain('Emit the smallest read-only command action now');
    });

    test('does not treat opening or explaining a webpage as local artifact authoring', () => {
        const router = new ToolRouter({
            activeScene: 'coding',
            activeTools: ['chrome-devtools']
        });

        expect(router.route('幫我開啟這個網頁').commandLane.recommended).toBe(false);
        expect(router.route('請解釋互動式網頁是什麼').commandLane.recommended).toBe(false);
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
        expect(hint).not.toContain('Current available Skill catalog');
    });

    test('makes explicitly selected Skills and MCP servers the top per-turn routes without approving execution', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: [],
        });

        const result = router.route('請查閱我指定的資料來源', {
            preferredSkillIds: ['reference-files'],
            preferredSkillActions: ['reference-files'],
            preferredMcpServers: ['chrome-devtools'],
        });

        expect(result.skills[0]).toEqual(expect.objectContaining({
            id: 'reference-files',
            preferred: true,
            allowed: true,
        }));
        expect(result.mcpTools.filter((tool) => tool.server === 'chrome-devtools').every((tool) => tool.preferred)).toBe(true);
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
            activeTools: [],
            mcpServers: [makeM365BridgeServer()],
        });

        const result = router.route('幫我把這個 SharePoint 檔案移到回收筒：https://contoso.sharepoint.com/sites/TestSite/Shared%20Documents/report.docx');
        const risky = result.mcpTools.find((item) => item.name === 'm365_recycle_file');
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

    test('routes a SharePoint folder listing request to m365-session-bridge list_folder', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: [],
            mcpServers: [makeM365BridgeServer()],
        });
        const query = '列出這個 SharePoint 資料夾有哪些檔案：https://contoso.sharepoint.com/sites/Example/Shared%20Documents';

        const result = router.route(query);
        const hint = router.buildRoutingHint(query);

        expect(result.commandLane.recommended).toBe(false);
        expect(result.mcpTools[0]).toEqual(expect.objectContaining({
            server: 'm365-session-bridge',
            name: 'm365_list_folder',
        }));
        expect(result.mcpTools.map((tool) => tool.name)).toEqual(['m365_list_folder']);
        expect(result.mcpTools[0].policy.risk).toBe('read');
        expect(result.skills).toEqual([]);
        expect(hint).toContain('mcp_call server="m365-session-bridge" tool="m365_list_folder"');
        expect(hint).toContain('"folderUrl"');
        expect(hint).not.toContain('m365_checkin_file');
    });

    test('routes native-M365-to-bridge folder retrieval as an executable multi-stage handoff', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: [],
            mcpServers: [makeM365BridgeServer()],
        });
        const query = '你可以自己規劃先用原生工具查站點，然後再用本機 m365 bridge MCP 工具去獲取 SharePoint 資料夾的檔案內容';

        const result = router.route(query);
        const hint = router.buildRoutingHint(query);

        expect(result.mcpTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
            'm365_list_folder',
            'm365_download_file',
        ]));
        expect(hint).toContain('M365 exact-target handoff rule');
        expect(hint).toContain('These tools are available in this Golem workspace');
        expect(hint).toContain('use a durable plan');
        expect(hint).toContain('record that native stage with plan_checkpoint');
        expect(hint).toContain('Do not stop after explaining this sequence');
    });

    test('routes a OneDrive access question to a native-first read-only capability probe', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: [],
            mcpServers: [makeM365BridgeServer()],
        });
        const query = '你可以看到我的 OneDrive 檔案嗎？';

        const result = router.route(query);
        const hint = router.buildRoutingHint(query);

        expect(result.mcpTools.map((tool) => tool.name)).toEqual(['m365_bridge_status']);
        expect(result.mcpTools[0].policy.risk).toBe('read');
        expect(hint).toContain('First try the native Microsoft 365 file/content grounding');
        expect(hint).toContain('you must emit the listed read-only status action in this same response');
        expect(hint).toContain('Do not replace the check with suggestions, example queries, or a request for a filename');
        expect(hint).toContain('Do not expose the names Work IQ, Bridge, MCP, Action, Observation');
    });

    test('routes an explicit OneDrive download request to m365-session-bridge download_file', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: [],
            mcpServers: [makeM365BridgeServer()],
        });
        const query = '下載這個 OneDrive 檔案：https://contoso-my.sharepoint.com/personal/test_user_example_com/Documents/file.docx';

        const result = router.route(query);

        expect(result.mcpTools[0]).toEqual(expect.objectContaining({
            server: 'm365-session-bridge',
            name: 'm365_download_file',
        }));
        expect(result.mcpTools.map((tool) => tool.name)).toEqual(['m365_download_file']);
        expect(result.mcpTools[0].policy.risk).toBe('action');
        expect(result.skills).toEqual([]);
    });

    test('routes an explicit SharePoint upload request to the non-destructive write tool', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: [],
            mcpServers: [makeM365BridgeServer()],
        });
        const query = '把 C:\\Work\\report.xlsx 上傳到這個 SharePoint 資料夾：https://contoso.sharepoint.com/sites/Example/Shared%20Documents';

        const result = router.route(query);
        const hint = router.buildRoutingHint(query);

        expect(result.mcpTools.map((tool) => tool.name)).toEqual(['m365_upload_file']);
        expect(result.mcpTools[0].policy).toEqual(expect.objectContaining({
            risk: 'action',
            requiresConfirmation: false,
        }));
        expect(hint).toContain('mcp_call server="m365-session-bridge" tool="m365_upload_file"');
        expect(hint).toContain('destinationFolderUrl');
        expect(hint).not.toContain('m365_recycle_file');
    });

    test('routes an explicit OneDrive nested-folder request to create_folder', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: [],
            mcpServers: [makeM365BridgeServer()],
        });
        const query = '在這個 OneDrive 資料夾建立 2026/Q1：https://contoso-my.sharepoint.com/personal/test_user_example_com/Documents';

        const result = router.route(query);

        expect(result.mcpTools.map((tool) => tool.name)).toEqual(['m365_create_folder']);
        expect(result.mcpTools[0].policy).toEqual(expect.objectContaining({
            risk: 'action',
            requiresConfirmation: false,
        }));
        expect(result.commandLane.recommended).toBe(false);
        expect(result.skills).toEqual([]);
    });

    test('does not misroute tenant-wide M365 search to public-web Skills or exact-URL bridge tools', () => {
        const router = new ToolRouter({
            activeScene: 'assistant',
            activeTools: ['chrome-devtools', 'duckduckgo-search'],
            mcpServers: [makeM365BridgeServer()],
        });
        const query = '搜尋整個 Microsoft 365 裡所有提到預算的文件';

        const result = router.route(query);
        const hint = router.buildRoutingHint(query);

        expect(result.skills).toEqual([]);
        expect(result.mcpTools).toEqual([]);
        expect(result.commandLane.recommended).toBe(false);
        expect(result.connectorBoundary).toEqual(expect.objectContaining({
            code: 'm365_exact_url_only',
        }));
        expect(hint).toContain('does not provide tenant-wide');
        expect(hint).toContain('First try the native Microsoft 365 file/content grounding');
        expect(hint).toContain('ask the user in plain language for the specific SharePoint/OneDrive file or folder link');
        expect(hint).not.toContain('duckduckgo-search');
    });
});
