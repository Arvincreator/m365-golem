const ToolUsePolicy = require('../src/managers/ToolUsePolicy');

describe('ToolUsePolicy', () => {
    test('allows a strongly relevant read tool to support an explanation', () => {
        const policy = new ToolUsePolicy();
        const decision = policy.evaluateCandidate('請解釋 git commit 是什麼', {
            id: 'git',
            name: 'git',
            description: 'read repository history',
            score: 20,
        });

        expect(decision.include).toBe(true);
        expect(decision.risk).toBe('read');
        expect(decision.strength).toBe('consider');
        expect(decision.requiresConfirmation).toBe(false);
        expect(decision.reason).toBe('relevant_optional_read');
    });

    test('does not surface a weak tool merely because tools are allowed autonomously', () => {
        const policy = new ToolUsePolicy();
        const decision = policy.evaluateCandidate('聊聊你喜歡的顏色', {
            id: 'log-reader',
            name: 'log-reader',
            description: 'read application logs',
            score: 4,
        });

        expect(decision.include).toBe(false);
        expect(decision.reason).toBe('low_score');
    });

    test('allows read tools for explicit inspection requests', () => {
        const policy = new ToolUsePolicy();
        const decision = policy.evaluateCandidate('幫我檢查錯誤日誌', {
            id: 'log-reader',
            name: 'log-reader',
            description: 'read logs',
            score: 12,
        });

        expect(decision.include).toBe(true);
        expect(decision.risk).toBe('read');
        expect(decision.requiresConfirmation).toBe(false);
    });

    test('requires confirmation for high risk tools', () => {
        const policy = new ToolUsePolicy();
        const decision = policy.evaluateCandidate('幫我刪除頁面', {
            id: 'wiki-delete',
            name: 'delete',
            description: 'delete a page',
            score: 15,
        });

        expect(decision.include).toBe(true);
        expect(decision.risk).toBe('high');
        expect(decision.requiresConfirmation).toBe(true);
    });

    test('treats artifact authoring verbs as explicit operations', () => {
        const policy = new ToolUsePolicy();

        expect(policy.classifyRequest('製作一個有互動能力的網頁')).toEqual(expect.objectContaining({
            explicitAction: true,
            shouldRoute: true,
        }));
    });

    test('treats a OneDrive access question as a capability probe', () => {
        const policy = new ToolUsePolicy();

        expect(policy.classifyRequest('你可以看到我的 OneDrive 檔案嗎？')).toEqual(expect.objectContaining({
            capabilityProbe: true,
            shouldRoute: true,
        }));
    });

    test.each(['測試看看', '你是不是應該要用 action 測試看看？', 'verify it'])(
        'treats verification wording as an executable request: %s', query => {
            expect(policyFor(query)).toEqual(expect.objectContaining({
                explicitAction: true,
                verificationIntent: true,
                shouldRoute: true,
                passive: false,
            }));
        }
    );

    test('does not surface an unrequested external mutation as an executable route', () => {
        const policy = new ToolUsePolicy();
        const decision = policy.evaluateCandidate('這份內容有什麼改善建議？', {
            id: 'wiki-update',
            name: 'update page',
            description: 'write and update an external page',
            score: 12,
        });

        expect(decision.include).toBe(false);
        expect(decision.risk).toBe('action');
        expect(decision.requiresConfirmation).toBe(true);
        expect(decision.reason).toBe('mutation_not_requested');
    });

    test('allows an accepted GOLEM_PLAN to continue from its bound host Observation', () => {
        const rules = new ToolUsePolicy().buildRules().join('\n');

        expect(rules).toContain('宿主已接受 GOLEM_PLAN');
        expect(rules).toContain('host Observation');
        expect(rules).toContain('不必等待使用者再說「繼續」');
    });
});

function policyFor(query) {
    return new ToolUsePolicy().classifyRequest(query);
}
