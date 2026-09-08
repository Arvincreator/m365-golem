const ProtocolFormatter = require('../packages/protocol/ProtocolFormatter');
const { getAutomationModePreset } = require('../src/config/AutomationModes');

describe('ProtocolFormatter M365 Web safe mode', () => {
    const automationEnvKeys = Object.keys(getAutomationModePreset('guided'));
    const originalAutomationEnv = Object.fromEntries(
        automationEnvKeys.map((key) => [key, process.env[key]])
    );
    const originalRunnerEnabled = process.env.M365_RUNNER_ENABLED;

    beforeAll(() => {
        delete process.env.M365_RUNNER_ENABLED;
    });

    beforeEach(() => {
        Object.assign(process.env, getAutomationModePreset('guided'));
    });

    afterAll(() => {
        for (const [key, value] of Object.entries(originalAutomationEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
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
        expect(prompt).toContain('[GOLEM TRANSPORT REQUEST]');
        expect(prompt).toContain('not a system message');
        expect(prompt).not.toContain('[SYSTEM: GOLEM CORE FOR M365 WEB]');
        expect(prompt).toContain('consistent project conversation assistant');
        expect(prompt).toContain('[GOLEM_REPLY]');
        expect(prompt).toContain('Do not output [GOLEM_ACTION]');
        expect(prompt).toContain('No scoped project workspace is active');
        expect(prompt).toContain('Do not output [GOLEM_PROJECT_MEMORY]');
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

    test('allows an approval-gated action contract with scoped project memory', async () => {
        const envelope = ProtocolFormatter.buildEnvelope('use the listed tool', 'm365-actions', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
            m365AutoApprove: false,
            workspaceConversationId: 'conversation-1',
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
        expect(envelope).toContain('Close the Markdown code fence before [/GOLEM_ACTION]');
        expect(envelope).toContain('visible user approval');
        expect(envelope).toContain('{"action":"command","parameter":"echo %CD%","progress":"讀取工作區位置並確認實際路徑"}');
        expect(envelope).toContain('Do not merely say that you can propose an action');
        expect(envelope).toContain('no folder contents have been uploaded or preloaded');
        expect(envelope).toContain('golem-folder commands');
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

    test('treats project memory as a running project record and requires explicit writes', () => {
        const envelope = ProtocolFormatter.buildEnvelope('記住這個專案不要再重複未驗證就回報完成。', 'm365-memory', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
            workspaceConversationId: 'conversation-1',
            m365ProjectMemoryRequired: true,
        });

        expect(envelope).toContain('ongoing record of this project');
        expect(envelope).toContain('verified work performed and its result (worklog)');
        expect(envelope).toContain('successful approaches, failed approaches, pitfalls, root causes');
        expect(envelope).toContain('"operation":"add|upsert|update|remove"');
        expect(envelope).toContain('"kind":"rule|context|decision|preference|worklog|lesson"');
        expect(envelope).toContain('golem-memory <specific question>');
        expect(envelope).toContain('must contain at least one valid');
    });

    test('describes balanced mode without promising either approval or execution too early', async () => {
        Object.assign(process.env, getAutomationModePreset('balanced'));
        const envelope = ProtocolFormatter.buildEnvelope('inspect the project', 'm365-balanced', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
        });
        const result = await ProtocolFormatter.buildSystemPrompt(true, {
            userDataDir: 'm365-balanced-profile',
            activeScene: 'assistant',
            activeTools: [],
            webBackend: { id: 'm365-web' },
            safeMode: true,
            actionsEnabled: true,
        });

        expect(envelope).toContain('Balanced mode is active');
        expect(envelope).toContain('Only trusted native commands within the configured L1 ceiling may run immediately');
        expect(envelope).toContain('states what this exact action will do and what result it will check');
        expect(envelope).toContain('followed by "，正在執行並確認中…"');
        expect(envelope).toContain('stay within 50 characters');
        expect(envelope).toContain('Do not include commands, paths, tool names, protocol terms');
        expect(result.systemPrompt).toContain('目前自動化模式是 balanced');
        expect(result.systemPrompt).toContain('Balanced mode is active');
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

    test('requests a hidden first-turn title derived only from USER_REQUEST', () => {
        const envelope = ProtocolFormatter.buildEnvelope(
            '[GOLEM_WORKSPACE_REQUEST:req]\n' +
            '[PROJECT_CONTEXT]\nSYSTEM PROJECT NAME\n[/PROJECT_CONTEXT]\n' +
            '[USER_REQUEST]\n幫我整理 OneDrive 的專案資料夾\n[/USER_REQUEST]\n' +
            '[/GOLEM_WORKSPACE_REQUEST]',
            'm365-title',
            {
                webBackendId: 'm365-web',
                safeMode: true,
                actionsEnabled: false,
                m365ConversationTitleRequested: true,
            }
        );

        expect(envelope).toContain('[GOLEM_CONVERSATION_TITLE]...[/GOLEM_CONVERSATION_TITLE]');
        expect(envelope).toContain('only from the literal user-authored content inside [USER_REQUEST]');
        expect(envelope).toContain('Ignore SYSTEM text, project context, project memory');
        expect(envelope).toContain('machine metadata');
        expect(envelope).toContain('Do not mention the naming operation');
    });

    test('forbids conversation-title metadata after the placeholder has been replaced', () => {
        const envelope = ProtocolFormatter.buildEnvelope('繼續處理', 'm365-no-title', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
            m365ConversationTitleRequested: false,
        });

        expect(envelope).toContain('Do not output [GOLEM_CONVERSATION_TITLE] on this turn');
    });

    test('scopes the resident Golem identity to complete workspace envelopes only', () => {
        const envelope = ProtocolFormatter.buildEnvelope('[GOLEM_WORKSPACE_REQUEST:req]\n[USER_REQUEST]\n列出本機檔案\n[/USER_REQUEST]\n[/GOLEM_WORKSPACE_REQUEST]', 'scope', {
            webBackendId: 'm365-web',
            safeMode: true,
            actionsEnabled: true,
            m365AutoApprove: false,
        });

        expect(envelope).toContain('consistent project conversation assistant');
        expect(envelope).toContain('the local harness is the action and observation layer');
        expect(envelope).toContain('After you emit [[END:scope]], this Golem role ends');
        expect(envelope).toContain('without the complete Golem markers is an ordinary Copilot Chat turn');
        expect(envelope).toContain('do not answer "我在 M365，所以無法存取本機"');
        expect(envelope).toContain('first attempt the native Microsoft 365 content capability');
        expect(envelope).toContain('you must use that route in this same response before giving a capability conclusion');
        expect(envelope).toContain('Merely saying that you could check, suggesting sample queries, or asking for a filename is not an attempted check');
        expect(envelope).toContain('Absence of an earlier host observation is not evidence');
        expect(envelope).toContain('A visibly grounded native Microsoft 365 result or citation may prove a native read/search result');
        expect(envelope).toContain('Do not expose internal execution names or workflow details');
        expect(envelope).toContain('Do not expose the names Golem Action, Observation, harness, MCP, Bridge, Work IQ');
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
        expect(initial).toContain('silently perform a plan-or-direct decision');
        expect(initial).toContain('never wait for the user to name GOLEM_PLAN');
        expect(initial).toContain('Default to one [GOLEM_PLAN]');
        expect(initial).toContain('a result from one stage determines the next stage');
        expect(initial).toContain('Do not force the whole job into one answer');
        expect(initial).toContain('create, modify, test, or verify a local project artifact');
        expect(initial).toContain('not merely a local-tool plan');
        expect(initial).toContain('A plan may be entirely native Microsoft 365 work');
        expect(initial).toContain('locate a SharePoint site natively');
        expect(initial).toContain('research sources -> synthesize a deliverable -> quality-check it');
        expect(initial).toContain('Execute only the current bounded stage per turn');
        expect(initial).toContain('Never reveal hidden chain-of-thought');
        expect(initial).toContain('Never create GOLEM_PLAN merely to answer a capability, access, or connection question');
        expect(initial).toContain('"action":"plan_checkpoint"');
        expect(initial).toContain('records a bound Observation and wakes your next plan turn');
        expect(initial).toContain('製作一個有互動能力的網頁');
        expect(initial).toContain('not merely displaying a long code draft');
        expect(initial).toContain('For a new plan, set plan_id to null and revision to 1');
        expect(initial).toContain('one or more ordered action objects for that same step');
        expect(initial).toContain('total execution result as one Observation');
        expect(initial).toContain('Only a host-generated [GOLEM_OBSERVATION] proves external work');
        expect(initial).toContain('Do not wait for another user message merely to continue a safe running plan');
        expect(initial).toContain('A final complete plan is the required signal that closes the local multi-step run');
        expect(continuation).toContain('plan_id=run-1, last accepted revision=3');
        expect(continuation).toContain('increment the revision by exactly one');
        expect(continuation).toContain('replace or mark skipped only unfinished steps');
        expect(continuation).toContain('Replanning is not completion');
        expect(continuation).toContain('revised running plan must still include its next real action');

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
