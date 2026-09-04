const ProtocolFormatter = require('../packages/protocol/ProtocolFormatter');

describe('ProtocolFormatter M365 Web safe mode', () => {
    const originalAutoApproveAll = process.env.GOLEM_AUTO_APPROVE_ALL;
    const originalRunnerEnabled = process.env.M365_RUNNER_ENABLED;

    beforeAll(() => {
        delete process.env.GOLEM_AUTO_APPROVE_ALL;
        delete process.env.M365_RUNNER_ENABLED;
    });

    afterAll(() => {
        if (originalAutoApproveAll === undefined) {
            delete process.env.GOLEM_AUTO_APPROVE_ALL;
        } else {
            process.env.GOLEM_AUTO_APPROVE_ALL = originalAutoApproveAll;
        }
        if (originalRunnerEnabled === undefined) {
            delete process.env.M365_RUNNER_ENABLED;
        } else {
            process.env.M365_RUNNER_ENABLED = originalRunnerEnabled;
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
        expect(envelope).toContain('Never output generic [GOLEM_MEMORY]');
        expect(envelope).toContain('[GOLEM_PROJECT_MEMORY]');
        expect(envelope).toContain('[GOLEM_USER_MEMORY]');
        expect(envelope).toContain('never enters Action Gate');
        expect(envelope).not.toContain('Do not output [GOLEM_ACTION]');
        expect(result.systemPrompt).toContain('local approval gate handles confirmation');
        expect(result.systemPrompt).toContain('Never output generic [GOLEM_MEMORY]');
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

    test('first project turn keeps the Golem identity even when the tool master switch is off', () => {
        const envelope = ProtocolFormatter.buildEnvelope('先討論，不使用工具', 'm365-no-tools-bootstrap', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: false,
            m365Bootstrap: true,
            userDataDir: 'm365-bootstrap-test-profile',
        });

        expect(envelope).toContain('INITIAL GOLEM OPERATING CONTEXT');
        expect(envelope).toContain('你就是住在 Golem 工作台中的 AI 推理核心');
        expect(envelope).toContain('目前工具總開關已關閉');
        expect(envelope).toContain('Do not output [GOLEM_ACTION]');
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

    test('lets Copilot author a durable plan only inside an enabled project conversation', () => {
        process.env.M365_RUNNER_ENABLED = 'true';
        const initial = ProtocolFormatter.buildEnvelope('完成一個需要多個工具步驟的任務', 'plan-initial', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
            workspaceConversationId: 'conversation-1',
        });
        const continuation = ProtocolFormatter.buildEnvelope('繼續', 'plan-next', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
            workspaceConversationId: 'conversation-1',
            workspacePlanId: 'run-1',
            workspacePlanRevision: 3,
        });

        expect(initial).toContain('[GOLEM_PLAN]');
        expect(initial).toContain('silently decide whether the requested outcome needs a durable multi-step run');
        expect(initial).toContain('never wait for the user to name GOLEM_PLAN');
        expect(initial).toContain('create, modify, test, or verify a local project artifact');
        expect(initial).toContain('not merely a local-tool plan');
        expect(initial).toContain('Native Microsoft 365 Copilot reasoning or generation');
        expect(initial).toContain('"action":"plan_checkpoint"');
        expect(initial).toContain('records a bound Observation and wakes your next plan turn');
        expect(initial).toContain('製作一個有互動能力的網頁');
        expect(initial).toContain('not merely displaying a long code draft');
        expect(initial).toContain('For a new plan, set plan_id to null and revision to 1');
        expect(initial).toContain('exactly one bounded [GOLEM_ACTION]');
        expect(initial).toContain('Only a host-generated [GOLEM_OBSERVATION] proves external work');
        expect(initial).toContain('Do not wait for another user message merely to continue a safe running plan');
        expect(initial).toContain('A final complete plan is the required signal that closes the local multi-step run');
        expect(continuation).toContain('plan_id=run-1, last accepted revision=3');
        expect(continuation).toContain('increment the revision by exactly one');

        delete process.env.M365_RUNNER_ENABLED;
        const disabled = ProtocolFormatter.buildEnvelope('完成任務', 'plan-disabled', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
            workspaceConversationId: 'conversation-1',
        });
        expect(disabled).toContain('Do not output [GOLEM_PLAN]');
    });
});
