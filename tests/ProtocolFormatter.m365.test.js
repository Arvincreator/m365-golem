const ProtocolFormatter = require('../packages/protocol/ProtocolFormatter');

describe('ProtocolFormatter M365 Web safe mode', () => {
    const originalAutoApproveAll = process.env.GOLEM_AUTO_APPROVE_ALL;

    beforeAll(() => {
        delete process.env.GOLEM_AUTO_APPROVE_ALL;
    });

    afterAll(() => {
        if (originalAutoApproveAll === undefined) {
            delete process.env.GOLEM_AUTO_APPROVE_ALL;
        } else {
            process.env.GOLEM_AUTO_APPROVE_ALL = originalAutoApproveAll;
        }
    });

    test('buildEnvelope requests reply-only output and forbids actions', () => {
        const prompt = ProtocolFormatter.buildEnvelope('hello', 'm365', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: false,
        });

        expect(prompt).toContain('[[BEGIN:m365]]');
        expect(prompt).toContain('[[END:m365]]');
        expect(prompt).toContain('You are Golem');
        expect(prompt).toContain('consistent project conversation assistant');
        expect(prompt).toContain('[GOLEM_REPLY]');
        expect(prompt).toContain('Do not output [GOLEM_ACTION]');
        expect(prompt).toContain('Do not expose or request local profile data');
        expect(prompt).not.toContain('Google Workspace');
        expect(prompt).not.toContain('mcp_call');
    });

    test('buildSystemPrompt does not scan or inject skills in safe mode', async () => {
        const result = await ProtocolFormatter.buildSystemPrompt(true, {
            userDataDir: 'm365-test-profile',
            activeScene: 'assistant',
            activeTools: [],
            webBackend: { id: 'm365-web' },
            safeMode: true,
            actionsEnabled: false,
        });

        expect(result.skillMemoryText).toBeNull();
        expect(result.systemPrompt).toContain('M365 WEB POC MODE');
        expect(result.systemPrompt).toContain('Do not output [GOLEM_ACTION]');
        expect(result.systemPrompt).not.toContain('CORE SKILL PROTOCOLS');
        expect(result.systemPrompt).not.toContain('GOOGLE WORKSPACE');
    });

    test('allows an approval-gated action contract without enabling memory', async () => {
        const envelope = ProtocolFormatter.buildEnvelope('use the listed tool', 'm365-actions', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
            m365AutoApprove: false,
        });
        const result = await ProtocolFormatter.buildSystemPrompt(true, {
            userDataDir: 'm365-actions-profile',
            activeScene: 'assistant',
            activeTools: [],
            webBackend: { id: 'm365-web' },
            safeMode: true,
            actionsEnabled: true,
        });

        expect(envelope).toContain('[GOLEM_ACTION]');
        expect(envelope).toContain('visible user approval');
        expect(envelope).toContain('{"action":"command","parameter":"echo %CD%"}');
        expect(envelope).toContain('Do not merely say that you can propose an action');
        expect(envelope).toContain('Never emit XML-style tags such as </GOLEM_REPLY>');
        expect(envelope).toContain('Never output [GOLEM_MEMORY]');
        expect(envelope).not.toContain('Do not output [GOLEM_ACTION]');
        expect(result.systemPrompt).toContain('local approval gate handles confirmation');
        expect(result.systemPrompt).toContain('Never output [GOLEM_MEMORY]');
        expect(result.skillMemoryText).toBeNull();
    });

    test('first project turn restores the original Golem role and harness education without disclosing a full local catalog', () => {
        const envelope = ProtocolFormatter.buildEnvelope('查看我啟動 Golem 的根目錄', 'm365-bootstrap', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
            m365Bootstrap: true,
            userDataDir: 'm365-bootstrap-test-profile',
        });

        expect(envelope).toContain('INITIAL GOLEM OPERATING CONTEXT');
        expect(envelope).toContain('當前人格設定 (Persona)');
        expect(envelope).toContain('本機代理定位');
        expect(envelope).toContain('你是 Golem 的推理與規劃層');
        expect(envelope).toContain('住在 Golem 工作台中的 AI 推理核心');
        expect(envelope).toContain('不要等使用者再次提醒「你可以用 Action」');
        expect(envelope).toContain('每輪 <tool-routing>');
        expect(envelope).toContain('command');
        expect(envelope).toContain('mcp_call');
        expect(envelope).not.toContain('已安裝的 MCP Server：');
        expect(envelope).not.toContain('C:\\Users\\');
    });

    test('scopes the resident Golem identity to complete workspace envelopes only', () => {
        const envelope = ProtocolFormatter.buildEnvelope('[GOLEM_WORKSPACE_REQUEST:req]\n[USER_REQUEST]\n列出本機檔案\n[/USER_REQUEST]\n[/GOLEM_WORKSPACE_REQUEST]', 'scope', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
            m365AutoApprove: false,
        });

        expect(envelope).toContain('resident AI reasoning core');
        expect(envelope).toContain('the local harness is your action and observation layer');
        expect(envelope).toContain('After you emit [[END:scope]], this Golem role ends');
        expect(envelope).toContain('without the complete Golem markers is an ordinary Copilot Chat turn');
        expect(envelope).toContain('do not answer "我在 M365，所以無法存取本機"');
    });
});
