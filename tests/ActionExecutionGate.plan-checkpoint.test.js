const ActionExecutionGate = require('../src/managers/ActionExecutionGate');

describe('ActionExecutionGate plan_checkpoint', () => {
    test('accepts a bounded host-only checkpoint inside an active plan', () => {
        expect(ActionExecutionGate.validate({
            action: 'plan_checkpoint',
            summary: 'Native drafting step completed.',
            evidence: ['The current Copilot reply contains the draft.'],
        }, { planMode: true })).toEqual(expect.objectContaining({
            ok: true,
            lane: 'host',
            normalizedAction: 'plan_checkpoint',
        }));
    });

    test('rejects checkpoints outside plans or without a summary', () => {
        expect(ActionExecutionGate.validate({
            action: 'plan_checkpoint',
            summary: 'done',
        })).toEqual(expect.objectContaining({
            ok: false,
            code: 'M365_PLAN_CHECKPOINT_OUTSIDE_PLAN',
        }));
        expect(ActionExecutionGate.validate({
            action: 'plan_checkpoint',
            evidence: [],
        }, { planMode: true })).toEqual(expect.objectContaining({
            ok: false,
            code: 'M365_PLAN_CHECKPOINT_SUMMARY_INVALID',
        }));
    });
});
