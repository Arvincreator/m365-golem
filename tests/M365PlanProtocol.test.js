'use strict';

const {
    buildM365PlanObservation,
    parseM365PlanBlock,
} = require('../src/services/M365PlanProtocol');
const ResponseParser = require('../src/utils/ResponseParser');

function plan(overrides = {}) {
    return {
        schema_version: 'golem_plan/1',
        plan_id: null,
        revision: 1,
        goal: 'Inspect the workspace and summarize it.',
        completion_criteria: 'The host proves the listing and the answer summarizes it.',
        status: 'running',
        current_step_id: 'step_1',
        steps: [
            { id: 'step_1', title: 'List files', status: 'in_progress', done_when: 'Observation contains the directory listing.' },
            { id: 'step_2', title: 'Summarize', status: 'pending', done_when: 'A concise summary is returned.' },
        ],
        question: '',
        approval_request: '',
        completion_summary: '',
        ...overrides,
    };
}

describe('M365 GOLEM_PLAN protocol', () => {
    test('strictly parses one valid running plan and keeps it out of the visible reply', () => {
        const raw = `[[BEGIN:a1]]\n[GOLEM_REPLY]開始執行。[/GOLEM_REPLY]\n[GOLEM_PLAN]\n\`\`\`json\n${JSON.stringify(plan())}\n\`\`\`\n[/GOLEM_PLAN]\n[GOLEM_ACTION]\n[{"action":"command","parameter":"dir"}]\n[/GOLEM_ACTION]\n[[END:a1]]`;
        const parsed = ResponseParser.parse(raw);
        expect(parsed.reply).toBe('開始執行。');
        expect(parsed.plan).toEqual(expect.objectContaining({ revision: 1, status: 'running', currentStepId: 'step_1' }));
        expect(parsed.actions).toHaveLength(1);
    });

    test('rejects duplicate plan blocks', () => {
        const block = `[GOLEM_PLAN]${JSON.stringify(plan())}[/GOLEM_PLAN]`;
        const parsed = parseM365PlanBlock(`${block}\n${block}`);
        expect(parsed.ok).toBe(false);
        expect(parsed.errorCode).toBe('M365_PLAN_BOUNDARY_INVALID');
    });

    test('parses a plan when M365 renders one standalone code gutter before the JSON object', () => {
        const rendered = `[GOLEM_PLAN]\n1\n${JSON.stringify(plan(), null, 2)}\n[/GOLEM_PLAN]`;
        const parsed = parseM365PlanBlock(rendered);
        expect(parsed.ok).toBe(true);
        expect(parsed.plan).toEqual(expect.objectContaining({
            revision: 1,
            status: 'running',
            currentStepId: 'step_1',
        }));
    });

    test('parses the exact M365 virtualized code chrome around a one-line plan', () => {
        const rendered = `[GOLEM_PLAN]\nJSON\n1\n${JSON.stringify(plan())}\n顯示更多行\n[/GOLEM_PLAN]`;
        const parsed = parseM365PlanBlock(rendered);
        expect(parsed.ok).toBe(true);
        expect(parsed.plan).toEqual(expect.objectContaining({
            revision: 1,
            status: 'running',
            currentStepId: 'step_1',
        }));
    });

    test('parses a complete M365 response containing virtualized plan and action blocks', () => {
        const raw = `[[BEGIN:captured]]\n[GOLEM_REPLY]已啟動計畫。[/GOLEM_REPLY]\n` +
            `[GOLEM_PLAN]\nJSON\n1\n${JSON.stringify(plan())}\n顯示更多行\n[/GOLEM_PLAN]\n` +
            '[GOLEM_ACTION]\nJSON\n1\n[{"action":"command","parameter":"echo %CD%"}]\n' +
            '[/GOLEM_ACTION] [[END:captured]]';
        const parsed = ResponseParser.parse(raw);

        expect(parsed.reply).toBe('已啟動計畫。');
        expect(parsed.planError).toBeUndefined();
        expect(parsed.plan).toEqual(expect.objectContaining({ status: 'running', currentStepId: 'step_1' }));
        expect(parsed.actions).toEqual([{ action: 'command', parameter: 'echo %CD%' }]);
    });

    test('parses the observed M365 final-plan suffix with a stray fence line', () => {
        const completedPlan = plan({
            plan_id: 'run_1',
            revision: 6,
            status: 'complete',
            current_step_id: 'step_2',
            steps: plan().steps.map((step) => ({ ...step, status: 'completed' })),
            completion_summary: 'All work was verified and completed.',
        });
        const rendered = `[GOLEM_PLAN]\nJSON\n1\n${JSON.stringify(completedPlan)}\n2\n\`\`\n顯示更多行\n[/GOLEM_PLAN]`;
        const parsed = parseM365PlanBlock(rendered);

        expect(parsed.ok).toBe(true);
        expect(parsed.plan).toEqual(expect.objectContaining({
            revision: 6,
            status: 'complete',
            completionSummary: 'All work was verified and completed.',
        }));
    });

    test('parses a plan when the rendered gutter sequence starts after line one', () => {
        const jsonLines = JSON.stringify(plan(), null, 2).split('\n');
        const renderedLines = jsonLines.flatMap((line, index) => [String(index + 2), line]);
        const parsed = parseM365PlanBlock(`[GOLEM_PLAN]\n${renderedLines.join('\n')}\n[/GOLEM_PLAN]`);
        expect(parsed.ok).toBe(true);
        expect(parsed.plan).toEqual(expect.objectContaining({ revision: 1, status: 'running' }));
    });

    test('does not discard prose surrounding a JSON object', () => {
        const parsed = parseM365PlanBlock(`[GOLEM_PLAN]\nHere is the plan:\n${JSON.stringify(plan())}\n[/GOLEM_PLAN]`);
        expect(parsed.ok).toBe(false);
        expect(parsed.errorCode).toBe('M365_PLAN_JSON_INVALID');
    });

    test('does not treat an arbitrary suffix as M365 renderer chrome', () => {
        const parsed = parseM365PlanBlock(`[GOLEM_PLAN]\n1\n${JSON.stringify(plan())}\nPlease continue\n[/GOLEM_PLAN]`);
        expect(parsed.ok).toBe(false);
        expect(parsed.errorCode).toBe('M365_PLAN_JSON_INVALID');
    });

    test('rejects a running plan without exactly one matching in-progress step', () => {
        const invalid = plan({ current_step_id: 'step_2' });
        const parsed = parseM365PlanBlock(`[GOLEM_PLAN]${JSON.stringify(invalid)}[/GOLEM_PLAN]`);
        expect(parsed.ok).toBe(false);
        expect(parsed.errorCode).toBe('M365_PLAN_CURRENT_STEP_INVALID');
    });

    test('rejects premature completion', () => {
        const invalid = plan({
            status: 'complete',
            current_step_id: '',
            completion_summary: 'Done.',
        });
        const parsed = parseM365PlanBlock(`[GOLEM_PLAN]${JSON.stringify(invalid)}[/GOLEM_PLAN]`);
        expect(parsed.ok).toBe(false);
        expect(parsed.errorCode).toBe('M365_PLAN_NONRUNNING_STEP_INVALID');
    });

    test('builds a host-attributed observation with plan bindings', () => {
        const observation = buildM365PlanObservation({
            planId: 'run_1',
            planRevision: 2,
            stepId: 'host_step_1',
            planStepId: 'step_1',
            actionId: 'action_1',
            lane: 'command',
            status: 'succeeded',
            result: 'ok',
        });
        expect(observation).toContain('[GOLEM_OBSERVATION]');
        expect(observation).toContain('"source": "golem_host"');
        expect(observation).toContain('"plan_id": "run_1"');
        expect(observation).toContain('"status": "succeeded"');
        expect(observation).toContain('bound tool result or native plan checkpoint was recorded');
    });
});
