'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ConfigManager = require('../src/config');
const { M365RunCoordinator } = require('../src/services/M365RunCoordinator');

function plan(overrides = {}) {
    return {
        schemaVersion: 'golem_plan/1',
        planId: null,
        revision: 1,
        goal: 'Inspect the selected local evidence and report verified results.',
        completionCriteria: 'Every completed step has a successful host Observation.',
        status: 'running',
        currentStepId: 'inspect',
        steps: [
            { id: 'inspect', title: 'Inspect evidence', status: 'in_progress', doneWhen: 'Host Observation records the result.' },
        ],
        question: '',
        approvalRequest: '',
        completionSummary: '',
        ...overrides,
    };
}

describe('M365 Golem closed-loop information flow', () => {
    let tempDir;
    let coordinator;
    let store;
    let server;
    let conversation;
    let previousBackend;
    const previousEnv = {};

    beforeAll(() => {
        previousBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        for (const key of ['M365_WORKSPACE_ENABLED', 'M365_RUNNER_ENABLED', 'M365_DATA_ENCRYPTION_KEY', 'M365_WORKSPACE_DB_PATH']) {
            previousEnv[key] = process.env[key];
        }
    });

    afterAll(() => {
        ConfigManager.CONFIG.GOLEM_BACKEND = previousBackend;
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-closed-loop-'));
        process.env.M365_WORKSPACE_ENABLED = 'true';
        process.env.M365_RUNNER_ENABLED = 'true';
        process.env.M365_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
        process.env.M365_WORKSPACE_DB_PATH = path.join(tempDir, 'workspace.sqlite');
        server = { dispatchM365WorkspaceMessage: jest.fn(async () => ({ success: true })) };
        coordinator = new M365RunCoordinator(server);
        await coordinator.init();
        store = server.m365WorkspaceStore;
        const project = await store.createProject({ name: 'Closed-loop simulation' });
        conversation = await store.createConversation(project.id, { title: 'Information flow' });
    });

    afterEach(async () => {
        for (const timer of coordinator?.dispatchTimers?.values() || []) clearTimeout(timer);
        if (store) await store.close().catch(() => undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('user request -> plan -> ordered actions -> one Observation -> verified completion', async () => {
        const accepted = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan: plan(),
            actions: [
                { action: 'command', parameter: 'read metadata' },
                { action: 'command', parameter: 'verify content' },
            ],
            actionCount: 2,
        });
        expect(accepted).toEqual(expect.objectContaining({ accepted: true, allowActions: true }));

        const observation = await coordinator.recordAutonomousObservation({
            runId: accepted.runId,
            stepId: accepted.stepId,
            actionId: accepted.actionId,
            planStepId: 'inspect',
            status: 'succeeded',
            result: 'Both ordered actions completed; verified file contents returned.',
        });
        expect(observation.duplicate).toBe(false);

        const completed = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: accepted.runId,
            plan: plan({
                planId: accepted.runId,
                revision: 2,
                status: 'complete',
                currentStepId: null,
                steps: [{ id: 'inspect', title: 'Inspect evidence', status: 'completed', doneWhen: 'Host Observation records the result.' }],
                completionSummary: 'Verified evidence was inspected.',
            }),
            actions: [],
            actionCount: 0,
            isSystemFeedback: true,
        });

        expect(completed.accepted).toBe(true);
        expect((await store.getRun(accepted.runId)).status).toBe('COMPLETED');
        const events = await store.listRunEvents(accepted.runId);
        expect(events.filter((event) => event.eventType === 'autonomous_action_planned')).toHaveLength(1);
        expect(events.filter((event) => event.eventType === 'autonomous_observation_recorded')).toHaveLength(1);
    });

    test('missing input -> user supplement -> corrected action -> Observation -> completion', async () => {
        const waiting = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan: plan({
                status: 'wait_user',
                currentStepId: 'inspect',
                steps: [{ id: 'inspect', title: 'Inspect evidence', status: 'blocked', doneWhen: 'A file is selected.' }],
                question: 'Which file should be inspected?',
            }),
            actions: [],
            actionCount: 0,
        });
        expect((await store.getRun(waiting.runId)).status).toBe('WAITING_USER');

        await coordinator.resumeRun(waiting.runId, 'Inspect invoice-01.png');
        coordinator._clearDispatchTimer(waiting.runId);
        await coordinator._beginAutonomousContinuation(
            waiting.runId,
            plan({ planId: waiting.runId }),
            'Inspect invoice-01.png',
            'user_resume'
        );
        const message = server.dispatchM365WorkspaceMessage.mock.calls.at(-1)[0].message;
        expect(message).toContain('[USER_CONTINUATION_INPUT]\nInspect invoice-01.png\n[/USER_CONTINUATION_INPUT]');

        const next = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: waiting.runId,
            plan: plan({ planId: waiting.runId, revision: 2 }),
            actions: [{ action: 'attach_local_files', relative_paths: ['invoice-01.png'] }],
            actionCount: 1,
            isSystemFeedback: true,
        });
        await coordinator.recordAutonomousObservation({
            runId: next.runId,
            stepId: next.stepId,
            actionId: next.actionId,
            planStepId: 'inspect',
            status: 'succeeded',
            result: 'invoice-01.png was attached and read.',
        });
        await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: next.runId,
            plan: plan({
                planId: next.runId,
                revision: 3,
                status: 'complete',
                currentStepId: null,
                steps: [{ id: 'inspect', title: 'Inspect evidence', status: 'completed', doneWhen: 'A file is selected.' }],
                completionSummary: 'The selected image was inspected.',
            }),
            actions: [],
            actionCount: 0,
            isSystemFeedback: true,
        });
        expect((await store.getRun(next.runId)).status).toBe('COMPLETED');
    });

    test('approval gates execute only after approval and denial terminates without dispatch', async () => {
        const approvalPlan = plan({
            status: 'wait_approval',
            currentStepId: 'inspect',
            steps: [{ id: 'inspect', title: 'Inspect evidence', status: 'pending', doneWhen: 'Approved action completes.' }],
            approvalRequest: 'Approve uploading the selected original file.',
        });
        const waiting = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan: approvalPlan,
            actions: [],
            actionCount: 0,
        });
        const [approval] = await store.listApprovals(waiting.runId);
        expect((await store.getRun(waiting.runId)).status).toBe('WAITING_APPROVAL');
        expect(server.dispatchM365WorkspaceMessage).not.toHaveBeenCalled();

        await coordinator.decideApproval(approval.id, { status: 'approved', decision: 'Allowed by user.' });
        coordinator._clearDispatchTimer(waiting.runId);
        await coordinator._beginAutonomousContinuation(waiting.runId, { ...approvalPlan, planId: waiting.runId }, '', 'user_approval');
        expect(server.dispatchM365WorkspaceMessage.mock.calls.at(-1)[0].message).toContain('Resume reason: user_approval.');

        const otherConversation = await store.createConversation((await store.getConversation(conversation.id)).projectId, { title: 'Denied branch' });
        const deniedRun = await coordinator.handleAutonomousPlan({
            conversationId: otherConversation.id,
            plan: approvalPlan,
            actions: [],
            actionCount: 0,
        });
        const [deniedApproval] = await store.listApprovals(deniedRun.runId);
        const dispatchCount = server.dispatchM365WorkspaceMessage.mock.calls.length;
        await coordinator.decideApproval(deniedApproval.id, { status: 'denied', decision: 'Denied by user.' });
        expect((await store.getRun(deniedRun.runId)).status).toBe('CANCELED');
        expect(server.dispatchM365WorkspaceMessage).toHaveBeenCalledTimes(dispatchCount);
    });

    test('failed Observation can be replanned, while duplicate and stale feedback cannot fork work', async () => {
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan: plan(),
            actions: [{ action: 'command', parameter: 'primary reader' }],
            actionCount: 1,
        });
        await coordinator.recordAutonomousObservation({
            runId: first.runId,
            stepId: first.stepId,
            actionId: first.actionId,
            planStepId: 'inspect',
            status: 'failed',
            result: 'Primary reader returned incomplete content.',
        });

        const fallback = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            plan: plan({ planId: first.runId, revision: 2 }),
            actions: [{ action: 'attach_local_files', relative_paths: ['evidence.png'] }],
            actionCount: 1,
            isSystemFeedback: true,
        });
        const recorded = await coordinator.recordAutonomousObservation({
            runId: fallback.runId,
            stepId: fallback.stepId,
            actionId: fallback.actionId,
            planStepId: 'inspect',
            status: 'succeeded',
            result: 'Fallback attachment was read completely.',
        });
        const duplicate = await coordinator.recordAutonomousObservation({
            runId: fallback.runId,
            stepId: fallback.stepId,
            actionId: fallback.actionId,
            planStepId: 'inspect',
            status: 'succeeded',
            result: 'Delayed duplicate.',
        });
        expect(recorded.duplicate).toBe(false);
        expect(duplicate.duplicate).toBe(true);

        const stale = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            plan: plan({ planId: first.runId, revision: 2 }),
            actions: [{ action: 'command', parameter: 'duplicate action' }],
            actionCount: 1,
            isSystemFeedback: true,
        });
        expect(stale).toEqual(expect.objectContaining({ accepted: false, code: 'M365_PLAN_REVISION_MISMATCH' }));
        expect(await store.listRunSteps(first.runId)).toHaveLength(2);

        await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            plan: plan({
                planId: first.runId,
                revision: 3,
                status: 'complete',
                currentStepId: null,
                steps: [{ id: 'inspect', title: 'Inspect evidence', status: 'completed', doneWhen: 'Host Observation records the result.' }],
                completionSummary: 'Fallback evidence verified the result.',
            }),
            actions: [],
            actionCount: 0,
            isSystemFeedback: true,
        });
        expect((await store.getRun(first.runId)).status).toBe('COMPLETED');
    });
});
