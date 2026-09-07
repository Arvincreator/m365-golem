'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ConfigManager = require('../src/config');
const M365WorkspaceStore = require('../src/managers/M365WorkspaceStore');
const { M365RunCoordinator } = require('../src/services/M365RunCoordinator');

describe('M365 durable run coordinator', () => {
    let tempDir;
    let server;
    let coordinator;
    let store;
    let project;
    let conversation;
    let originalBackend;
    const previousEnv = {};

    beforeAll(() => {
        originalBackend = ConfigManager.CONFIG.GOLEM_BACKEND;
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        for (const key of ['M365_WORKSPACE_ENABLED', 'M365_RUNNER_ENABLED', 'M365_DATA_ENCRYPTION_KEY', 'M365_WORKSPACE_DB_PATH']) {
            previousEnv[key] = process.env[key];
        }
    });

    afterAll(() => {
        ConfigManager.CONFIG.GOLEM_BACKEND = originalBackend;
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-m365-runner-'));
        process.env.M365_WORKSPACE_ENABLED = 'true';
        process.env.M365_RUNNER_ENABLED = 'true';
        process.env.M365_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
        process.env.M365_WORKSPACE_DB_PATH = path.join(tempDir, 'workspace.sqlite');
        server = {
            dispatchM365WorkspaceMessage: jest.fn(async () => ({ success: true })),
        };
        coordinator = new M365RunCoordinator(server);
        await coordinator.init();
        store = server.m365WorkspaceStore;
        project = await store.createProject({ name: 'Client A' });
        conversation = await store.createConversation(project.id, { title: 'Tax review' });
    });

    afterEach(async () => {
        for (const timer of coordinator?.dispatchTimers?.values() || []) clearTimeout(timer);
        if (store) await store.close().catch(() => undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test.each(['running', 'blocked'])('repairs a %s plan without action or blocker at most twice', async status => {
        const plan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'List workspace files', status, currentStepId: 'step_1',
            completionCriteria: 'Verified file listing returned.',
            steps: [{ id: 'step_1', title: 'List files', status: 'in_progress', doneWhen: 'Files listed' }],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const localFolders = [{ id: 'folder_test', name: 'Selected', path: 'C:\\Selected' }];
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan,
            actions: [],
            actionCount: 0,
            localFolders,
        });
        expect(first.accepted).toBe(true);
        expect((await store.getRun(first.runId)).status).toBe('QUEUED');
        expect(await store.listRunSteps(first.runId)).toHaveLength(0);
        coordinator._clearDispatchTimer(first.runId);
        await coordinator._beginAutonomousContinuation(first.runId, { ...plan, revision: 1 }, '', 'MISSING_ACTION_REPAIR');
        expect(server.dispatchM365WorkspaceMessage.mock.calls[0][0].message).toContain('No new tool was executed');
        expect(coordinator.getRunLocalFolders(first.runId)).toEqual(localFolders);
        for (const revision of [2, 3]) {
            await coordinator.handleAutonomousPlan({ conversationId: conversation.id, existingRunId: first.runId,
                plan: { ...plan, planId: first.runId, revision }, actions: [], actionCount: 0 });
            coordinator._clearDispatchTimer(first.runId);
        }
        expect((await store.getRun(first.runId)).status).toBe('BLOCKED');
        expect(await store.listRunSteps(first.runId)).toHaveLength(0);
    });

    test('does not replace scoped folder references when a run belongs to another conversation', async () => {
        const plan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Inspect selected files', status: 'running', currentStepId: 'step_1',
            completionCriteria: 'A host Observation verifies the result.',
            steps: [{ id: 'step_1', title: 'Inspect files', status: 'in_progress', doneWhen: 'Files inspected' }],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const originalFolders = [{ id: 'folder_original', name: 'Original', path: 'C:\\Original' }];
        const accepted = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan,
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
            localFolders: originalFolders,
        });
        const otherConversation = await store.createConversation(project.id, { title: 'Other conversation' });

        const rejected = await coordinator.handleAutonomousPlan({
            conversationId: otherConversation.id,
            existingRunId: accepted.runId,
            plan: { ...plan, planId: accepted.runId, revision: 2 },
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
            localFolders: [{ id: 'folder_other', name: 'Other', path: 'C:\\Other' }],
        });

        expect(rejected).toEqual(expect.objectContaining({
            accepted: false,
            code: 'M365_PLAN_CONVERSATION_MISMATCH',
        }));
        expect(coordinator.getRunLocalFolders(accepted.runId)).toEqual(originalFolders);
    });

    test('does not automatically repair an explicit blocker', async () => {
        const result = await coordinator.handleAutonomousPlan({ conversationId: conversation.id,
            plan: { schemaVersion: 'golem_plan/1', planId: null, revision: 1,
                goal: 'List files', completionCriteria: 'Verified listing', status: 'blocked', currentStepId: 'step_1',
                steps: [{ id: 'step_1', title: 'List files', status: 'blocked', doneWhen: 'Listed' }],
                question: 'Access denied; owner permission required.', approvalRequest: '', completionSummary: '' },
            actions: [], actionCount: 0 });
        expect((await store.getRun(result.runId)).status).toBe('BLOCKED');
        expect(coordinator.dispatchTimers.size).toBe(0);
    });

    test('does not accept an unverified capability guess as a real blocker', async () => {
        const result = await coordinator.handleAutonomousPlan({ conversationId: conversation.id,
            plan: { schemaVersion: 'golem_plan/1', planId: null, revision: 1,
                goal: '建立 Word 報告', completionCriteria: '有效的 docx 檔案存在', status: 'blocked', currentStepId: 'step_1',
                steps: [{ id: 'step_1', title: '建立文件', status: 'blocked', doneWhen: '檔案存在' }],
                question: '我尚未取得可建立 Word 的已驗證能力。', approvalRequest: '', completionSummary: '' },
            actions: [], actionCount: 0 });
        expect(result).toEqual(expect.objectContaining({
            accepted: false,
            protocolRepair: expect.objectContaining({ status: 'retry' }),
        }));
        expect((await store.getRun(result.runId)).status).toBe('RUNNING');
    });

    test('creates a durable execution contract when an explicit task was answered without action', async () => {
        const repair = await coordinator.startExecutionContract({
            conversationId: conversation.id,
            requestId: 'missing-action-request',
            objective: '在工作區建立一份 Word 報告',
            verification: 'A valid recent .docx exists in the workspace.',
        });
        expect(repair).toEqual(expect.objectContaining({
            accepted: false,
            planMode: true,
            protocolRepair: expect.objectContaining({ status: 'retry', attempt: 1 }),
        }));
        expect((await store.getRun(repair.runId)).status).toBe('RUNNING');
        expect(repair.protocolRepair.prompt).toContain('plan_id=null');
        expect(repair.protocolRepair.prompt).toContain('在工作區建立一份 Word 報告');
        expect(repair.protocolRepair.message).toBe('正在確認可用資源並準備執行…');

        const second = await coordinator.requestProtocolRepair({ runId: repair.runId, kind: 'missing_initial_execution' });
        expect(second.protocolRepair).toEqual(expect.objectContaining({ status: 'retry', attempt: 2 }));
        const exhausted = await coordinator.requestProtocolRepair({ runId: repair.runId, kind: 'missing_initial_execution' });
        expect(exhausted.protocolRepair.status).toBe('blocked');
        expect((await store.getRun(repair.runId)).status).toBe('BLOCKED');
    });

    test('rejects a completed plan step that has no matching host Observation', async () => {
        const completed = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            requestId: 'premature-completion',
            plan: {
                schemaVersion: 'golem_plan/1', planId: null, revision: 1,
                goal: 'Inspect project', completionCriteria: 'Two host checks complete', status: 'complete', currentStepId: null,
                steps: [
                    { id: 'step_1', title: 'First', status: 'completed', doneWhen: 'First observed' },
                    { id: 'step_2', title: 'Second', status: 'completed', doneWhen: 'Second observed' },
                ],
                question: '', approvalRequest: '', completionSummary: 'Done',
            },
            actions: [], actionCount: 0,
        });
        expect(completed).toEqual(expect.objectContaining({
            accepted: false,
            protocolRepair: expect.objectContaining({ status: 'retry' }),
        }));
        expect((await store.getRun(completed.runId)).status).toBe('RUNNING');
        expect(completed.protocolRepair.prompt).toContain('step_without_host_observation:step_1');
        expect(completed.protocolRepair.message).toBe('');
    });

    test('returns an active-plan conflict to Copilot with a safe same-run replanning route', async () => {
        const originalPlan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Inspect the current project.',
            completionCriteria: 'Host observations prove the inspection.',
            status: 'running', currentStepId: 'inspect',
            steps: [
                { id: 'inspect', title: 'Inspect', status: 'in_progress', doneWhen: 'Observed.' },
                { id: 'obsolete', title: 'Old approach', status: 'pending', doneWhen: 'Observed.' },
            ],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan: originalPlan,
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
        });
        const [firstStep] = await store.listRunSteps(first.runId);
        await coordinator.recordAutonomousObservation({
            runId: first.runId,
            stepId: firstStep.id,
            actionId: first.actionId,
            planStepId: 'inspect',
            status: 'succeeded',
            result: 'Project structure observed.',
        });

        const conflict = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan: {
                schemaVersion: 'golem_plan/1', planId: null, revision: 1,
                goal: 'Use a better inspection approach.',
                completionCriteria: 'A verified inspection is returned.',
                status: 'running', currentStepId: 'new_step',
                steps: [{ id: 'new_step', title: 'Inspect another way', status: 'in_progress', doneWhen: 'Observed.' }],
                question: '', approvalRequest: '', completionSummary: '',
            },
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
        });

        expect(conflict).toEqual(expect.objectContaining({
            accepted: false,
            allowActions: false,
            runId: first.runId,
            planId: first.runId,
            planRevision: 1,
            protocolRepair: expect.objectContaining({ status: 'retry' }),
        }));
        expect(conflict.protocolRepair.prompt).toContain(`plan_id=${first.runId}`);
        expect(conflict.protocolRepair.prompt).toContain('next revision must be 2');
        expect(conflict.protocolRepair.prompt).toContain('replace unfinished steps');
        expect(conflict.protocolRepair.prompt).toContain('mark obsolete steps skipped');
        expect(conflict.protocolRepair.prompt).toContain('Never fake completion');

        const replanned = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            isSystemFeedback: true,
            plan: {
                ...originalPlan,
                planId: first.runId,
                revision: 2,
                currentStepId: 'better_route',
                steps: [
                    { ...originalPlan.steps[0], status: 'completed' },
                    { ...originalPlan.steps[1], status: 'skipped' },
                    { id: 'better_route', title: 'Use better route', status: 'in_progress', doneWhen: 'Observed.' },
                ],
            },
            actions: [{ action: 'command', parameter: 'dir /b' }],
            actionCount: 1,
        });
        expect(replanned).toEqual(expect.objectContaining({
            accepted: true,
            allowActions: true,
            runId: first.runId,
            planRevision: 2,
            planStepId: 'better_route',
        }));
        expect((await store.getRun(first.runId)).status).toBe('RUNNING');
    });

    test('rejects a replan that drops a completed step backed by host evidence', async () => {
        const firstPlan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Inspect the current project.',
            completionCriteria: 'Host observations prove the inspection.',
            status: 'running', currentStepId: 'inspect',
            steps: [
                { id: 'inspect', title: 'Inspect', status: 'in_progress', doneWhen: 'Observed.' },
                { id: 'next', title: 'Continue', status: 'pending', doneWhen: 'Observed.' },
            ],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan: firstPlan,
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
        });
        await coordinator.recordAutonomousObservation({
            runId: first.runId,
            stepId: first.stepId,
            actionId: first.actionId,
            planStepId: 'inspect',
            status: 'succeeded',
            result: 'Inspection observed.',
        });

        const rejected = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            isSystemFeedback: true,
            plan: {
                ...firstPlan,
                planId: first.runId,
                revision: 2,
                currentStepId: 'replacement',
                steps: [{ id: 'replacement', title: 'Replacement', status: 'in_progress', doneWhen: 'Observed.' }],
            },
            actions: [{ action: 'command', parameter: 'dir /b' }],
            actionCount: 1,
        });

        expect(rejected).toEqual(expect.objectContaining({
            accepted: false,
            allowActions: false,
            runId: first.runId,
            protocolRepair: expect.objectContaining({ status: 'retry' }),
        }));
        expect(rejected.protocolRepair.prompt).toContain('completed_step_not_preserved:inspect');
        expect(await store.listRunSteps(first.runId)).toHaveLength(1);
    });

    test('keeps revision 1 semantics when an active run has no accepted plan yet', async () => {
        const reserved = await coordinator.startExecutionContract({
            conversationId: conversation.id,
            requestId: 'reserved-without-plan',
            objective: 'Inspect the assigned workspace.',
            verification: 'A host observation proves the workspace was inspected.',
        });

        const proseConflict = await coordinator.startExecutionContract({
            conversationId: conversation.id,
            requestId: 'second-prose-request',
            objective: 'Try a better approach.',
            verification: 'A host observation proves the result.',
        });
        expect(proseConflict).toEqual(expect.objectContaining({
            accepted: false,
            runId: reserved.runId,
            planId: null,
            planRevision: 0,
            protocolRepair: expect.objectContaining({ status: 'retry' }),
        }));
        expect(proseConflict.protocolRepair.prompt).toContain('plan_id=null and revision=1');

        const conflict = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan: {
                schemaVersion: 'golem_plan/1', planId: null, revision: 1,
                goal: 'Inspect the assigned workspace.',
                completionCriteria: 'A host observation proves the workspace was inspected.',
                status: 'running', currentStepId: 'inspect',
                steps: [{ id: 'inspect', title: 'Inspect', status: 'in_progress', doneWhen: 'Observed.' }],
                question: '', approvalRequest: '', completionSummary: '',
            },
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
        });

        expect(conflict).toEqual(expect.objectContaining({
            accepted: false,
            runId: reserved.runId,
            planId: null,
            planRevision: 0,
            protocolRepair: expect.objectContaining({ status: 'retry' }),
        }));
        expect(conflict.protocolRepair.prompt).toContain('plan_id=null and revision=1');

        const accepted = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: reserved.runId,
            isSystemFeedback: true,
            plan: {
                schemaVersion: 'golem_plan/1', planId: null, revision: 1,
                goal: 'Inspect the assigned workspace.',
                completionCriteria: 'A host observation proves the workspace was inspected.',
                status: 'running', currentStepId: 'inspect',
                steps: [{ id: 'inspect', title: 'Inspect', status: 'in_progress', doneWhen: 'Observed.' }],
                question: '', approvalRequest: '', completionSummary: '',
            },
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
        });
        expect(accepted).toEqual(expect.objectContaining({
            accepted: true,
            runId: reserved.runId,
            planRevision: 1,
        }));
    });

    test('a new user message can resume an auto-turn pause and replan the same run', async () => {
        const firstPlan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Inspect the project.',
            completionCriteria: 'The host verifies the requested inspection.',
            status: 'running', currentStepId: 'first',
            steps: [
                { id: 'first', title: 'First inspection', status: 'in_progress', doneWhen: 'Observed.' },
                { id: 'next', title: 'Finish inspection', status: 'pending', doneWhen: 'Observed.' },
            ],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan: firstPlan,
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
        });
        await coordinator.recordAutonomousObservation({
            runId: first.runId,
            stepId: first.stepId,
            actionId: first.actionId,
            planStepId: 'first',
            status: 'succeeded',
            result: 'First inspection observed.',
        });
        await coordinator.pauseForAutoTurnLimit({
            runId: first.runId,
            pendingPrompt: 'saved continuation',
            used: 5,
            limit: 5,
        });
        expect((await store.getRun(first.runId)).status).toBe('WAITING_USER');

        const conflict = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            isSystemFeedback: false,
            plan: {
                schemaVersion: 'golem_plan/1', planId: null, revision: 1,
                goal: 'Use the user requested better route.',
                completionCriteria: 'The host verifies the requested inspection.',
                status: 'running', currentStepId: 'replacement',
                steps: [{ id: 'replacement', title: 'Replacement route', status: 'in_progress', doneWhen: 'Observed.' }],
                question: '', approvalRequest: '', completionSummary: '',
            },
            actions: [{ action: 'command', parameter: 'dir /b' }],
            actionCount: 1,
        });
        expect(conflict).toEqual(expect.objectContaining({
            accepted: false,
            runId: first.runId,
            planId: first.runId,
            planRevision: 1,
            resetAutoTurnBudget: true,
        }));
        expect(conflict.protocolRepair.prompt).toContain('newest user message is an allowed intervention');
        expect(conflict.protocolRepair.prompt).toContain('redesign its unfinished steps');
        expect((await store.getRun(first.runId)).status).toBe('RUNNING');

        const replanned = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            isSystemFeedback: true,
            plan: {
                ...firstPlan,
                planId: first.runId,
                revision: 2,
                currentStepId: 'replacement',
                steps: [
                    { ...firstPlan.steps[0], status: 'completed' },
                    { ...firstPlan.steps[1], status: 'skipped' },
                    { id: 'replacement', title: 'Replacement route', status: 'in_progress', doneWhen: 'Observed.' },
                ],
            },
            actions: [{ action: 'command', parameter: 'dir /b' }],
            actionCount: 1,
        });
        expect(replanned).toEqual(expect.objectContaining({
            accepted: true,
            runId: first.runId,
            planRevision: 2,
            planStepId: 'replacement',
        }));
    });

    test('saves the deferred turn at the soft cap and dispatches it after one-turn approval', async () => {
        const active = await store.createRun(conversation.id, {
            objective: 'Prepare a project inventory.',
            verification: 'The inventory is verified.',
            maxSteps: 4,
            startImmediately: true,
            origin: 'copilot',
        });
        const pendingPrompt = '[GOLEM_OBSERVATION]\nContinue from this exact result.\n[/GOLEM_OBSERVATION]';

        const paused = await coordinator.pauseForAutoTurnLimit({
            runId: active.id,
            pendingPrompt,
            used: 5,
            limit: 5,
        });
        expect(paused).toEqual(expect.objectContaining({
            status: 'WAITING_USER',
            errorCode: 'M365_AUTO_TURN_LIMIT',
        }));
        const gate = (await store.listRunEvents(active.id)).find(
            (event) => event.eventType === 'auto_turn_limit_reached'
        );
        expect(gate.payload).toEqual(expect.objectContaining({
            pendingPrompt,
            used: 5,
            limit: 5,
            nextLimit: 6,
        }));

        const schedule = jest.spyOn(coordinator, '_scheduleDeferredAutoTurn').mockImplementation(() => {});
        const resumed = await coordinator.resumeRun(active.id, '', { grantAutoTurns: 1 });
        expect(resumed.status).toBe('QUEUED');
        expect(schedule).toHaveBeenCalledWith(active.id, pendingPrompt, { used: 5, limit: 6 });

        schedule.mockRestore();
        await coordinator._beginDeferredAutoTurn(active.id, pendingPrompt, { used: 5, limit: 6 });
        expect(server.dispatchM365WorkspaceMessage).toHaveBeenCalledWith(expect.objectContaining({
            conversationId: conversation.id,
            message: pendingPrompt,
            runId: active.id,
            planId: active.id,
            internalControl: true,
            autoTurnBudget: { used: 5, limit: 6 },
        }));
        expect((await store.getRun(active.id)).status).toBe('RUNNING');
    });

    test('pauses Goal mode after three consecutive failed tool observations', async () => {
        let runId = null;
        for (let revision = 1; revision <= 3; revision += 1) {
            const currentStepId = `attempt_${revision}`;
            const steps = Array.from({ length: revision }, (_, index) => ({
                id: `attempt_${index + 1}`,
                title: `Attempt ${index + 1}`,
                status: index + 1 === revision ? 'in_progress' : 'skipped',
                doneWhen: 'A host Observation proves useful progress.',
            }));
            const accepted = await coordinator.handleAutonomousPlan({
                conversationId: conversation.id,
                existingRunId: runId,
                goalMode: true,
                isSystemFeedback: revision > 1,
                plan: {
                    schemaVersion: 'golem_plan/1',
                    planId: runId,
                    revision,
                    goal: 'Find a working project-only approach.',
                    completionCriteria: 'A successful host Observation proves progress.',
                    status: 'running',
                    currentStepId,
                    steps,
                    question: '', approvalRequest: '', completionSummary: '',
                },
                actions: [{ action: 'command', parameter: `attempt-${revision}` }],
                actionCount: 1,
            });
            expect(accepted.accepted).toBe(true);
            runId = accepted.runId;
            const runSteps = await store.listRunSteps(runId);
            const currentStep = runSteps[runSteps.length - 1];
            const recorded = await coordinator.recordAutonomousObservation({
                runId,
                stepId: currentStep.id,
                actionId: accepted.actionId,
                planStepId: currentStepId,
                status: 'failed',
                result: `Attempt ${revision} produced no progress.`,
            });
            if (revision < 3) expect(recorded.run.status).toBe('RUNNING');
        }

        expect(await store.getRun(runId)).toEqual(expect.objectContaining({
            status: 'BLOCKED',
            errorCode: 'M365_GOAL_NO_PROGRESS',
            goalMode: true,
        }));
        const events = await store.listRunEvents(runId);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                eventType: 'goal_no_progress_paused',
                payload: expect.objectContaining({ consecutiveFailures: 3 }),
            }),
        ]));
    });

    async function createRun(maxSteps = 4) {
        const run = await store.createRun(conversation.id, {
            objective: 'Prepare a risk review.',
            constraints: 'Text only.',
            verification: 'List evidence and open items.',
            maxSteps,
        });
        await store.createApproval(run.id, {
            approvalType: 'run_start',
            request: 'Start?',
        });
        return run;
    }

    async function waitFor(check, timeoutMs = 1500) {
        const startedAt = Date.now();
        while (!await check()) {
            if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout');
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }

    test('requires explicit start, dispatches bounded steps, and continues to completion', async () => {
        const created = await createRun(3);
        expect(server.dispatchM365WorkspaceMessage).not.toHaveBeenCalled();

        await coordinator.startRun(created.id);
        await waitFor(() => server.dispatchM365WorkspaceMessage.mock.calls.length === 1);
        let run = await store.getRun(created.id);
        let steps = await store.listRunSteps(created.id);
        expect(run.status).toBe('RUNNING');
        expect(run.currentStep).toBe(1);
        expect(steps).toHaveLength(1);
        expect(server.dispatchM365WorkspaceMessage).toHaveBeenCalledWith(expect.objectContaining({
            runId: created.id,
            stepId: steps[0].id,
            requestId: steps[0].requestId,
        }));

        await coordinator.handleStepResponse({
            runId: created.id,
            stepId: steps[0].id,
            responseText: `Step one done.\n[GOLEM_RUN]${JSON.stringify({
                status: 'continue',
                step_summary: 'Evidence inventory completed.',
                next_prompt: 'Assess the two highest risks.',
                evidence: ['Inventory A'],
            })}[/GOLEM_RUN]`,
        });
        await waitFor(() => server.dispatchM365WorkspaceMessage.mock.calls.length === 2);
        run = await store.getRun(created.id);
        steps = await store.listRunSteps(created.id);
        expect(run.status).toBe('RUNNING');
        expect(run.currentStep).toBe(2);
        expect(steps[0]).toEqual(expect.objectContaining({ status: 'completed', summary: 'Evidence inventory completed.' }));

        await coordinator.handleStepResponse({
            runId: created.id,
            stepId: steps[1].id,
            responseText: `Finished.\n[GOLEM_RUN]${JSON.stringify({
                status: 'complete',
                step_summary: 'Risk review completed and checked.',
                evidence: ['Risk table'],
            })}[/GOLEM_RUN]`,
        });
        run = await store.getRun(created.id);
        expect(run.status).toBe('COMPLETED');
        expect(server.dispatchM365WorkspaceMessage).toHaveBeenCalledTimes(2);
    });

    test('stops for user input when the control block is missing', async () => {
        const created = await createRun();
        await coordinator.startRun(created.id);
        await waitFor(() => server.dispatchM365WorkspaceMessage.mock.calls.length === 1);
        const [step] = await store.listRunSteps(created.id);

        await coordinator.handleStepResponse({
            runId: created.id,
            stepId: step.id,
            responseText: 'A normal answer without run control.',
        });
        const run = await store.getRun(created.id);
        const [updatedStep] = await store.listRunSteps(created.id);
        expect(run.status).toBe('WAITING_USER');
        expect(run.errorCode).toBe('M365_RUN_CONTROL_MISSING');
        expect(updatedStep.status).toBe('waiting');
        expect(server.dispatchM365WorkspaceMessage).toHaveBeenCalledTimes(1);
    });

    test('marks an ambiguous browser result for reconciliation without retrying', async () => {
        const created = await createRun();
        await coordinator.startRun(created.id);
        await waitFor(() => server.dispatchM365WorkspaceMessage.mock.calls.length === 1);
        const [step] = await store.listRunSteps(created.id);

        await coordinator.handleDispatchError({
            runId: created.id,
            stepId: step.id,
            error: { code: 'M365_SEND_UNCONFIRMED' },
            ambiguous: true,
        });
        const run = await store.getRun(created.id);
        const [updatedStep] = await store.listRunSteps(created.id);
        expect(run.status).toBe('RECONCILE_REQUIRED');
        expect(updatedStep.status).toBe('reconcile_required');
        expect(server.dispatchM365WorkspaceMessage).toHaveBeenCalledTimes(1);
    });

    test('recovers an in-flight run conservatively after a local restart', async () => {
        const created = await store.createRun(conversation.id, {
            objective: 'Restart test',
            verification: 'Verified',
            maxSteps: 2,
        });
        await store.transitionRun(created.id, 'QUEUED');
        const step = await store.createRunStep(created.id, { prompt: 'step', requestId: 'request-restart' });
        await store.transitionRun(created.id, 'RUNNING', { currentStep: 1, stepId: step.id });
        await store.updateRunStep(step.id, { status: 'running' });
        await store.close();

        server = { dispatchM365WorkspaceMessage: jest.fn() };
        coordinator = new M365RunCoordinator(server);
        await coordinator.init();
        store = server.m365WorkspaceStore;
        const recovered = await store.getRun(created.id);
        const [recoveredStep] = await store.listRunSteps(created.id);
        expect(recovered.status).toBe('RECONCILE_REQUIRED');
        expect(recoveredStep.status).toBe('reconcile_required');
        expect(server.dispatchM365WorkspaceMessage).not.toHaveBeenCalled();
    });

    test('persists a Copilot-authored plan and advances each tool step only after a host Observation', async () => {
        const firstPlan = {
            schemaVersion: 'golem_plan/1',
            planId: null,
            revision: 1,
            goal: 'List and summarize the project root.',
            completionCriteria: 'A host Observation proves the listing and both plan steps are closed.',
            status: 'running',
            currentStepId: 'step_1',
            steps: [
                { id: 'step_1', title: 'List files', status: 'in_progress', doneWhen: 'Host output contains a listing.' },
                { id: 'step_2', title: 'Summarize', status: 'pending', doneWhen: 'Summary is returned.' },
            ],
            question: '',
            approvalRequest: '',
            completionSummary: '',
        };
        const accepted = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            requestId: 'request-plan-1',
            plan: firstPlan,
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
        });
        expect(accepted).toEqual(expect.objectContaining({
            accepted: true,
            allowActions: true,
            planMode: true,
            planRevision: 1,
        }));
        let run = await store.getRun(accepted.runId);
        let [step] = await store.listRunSteps(run.id);
        expect(run.status).toBe('RUNNING');
        expect(step.status).toBe('running');

        await coordinator.recordAutonomousObservation({
            runId: run.id,
            stepId: step.id,
            actionId: accepted.actionId,
            planStepId: 'step_1',
            lane: 'command',
            status: 'succeeded',
            result: 'file-a.txt',
        });
        [step] = await store.listRunSteps(run.id);
        expect(step.status).toBe('completed');

        const continued = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: run.id,
            requestId: 'request-plan-2',
            plan: {
                ...firstPlan,
                planId: run.id,
                revision: 2,
                currentStepId: 'step_2',
                steps: firstPlan.steps.map((item) => ({
                    ...item,
                    status: item.id === 'step_1' ? 'completed' : 'in_progress',
                })),
            },
            actions: [{ action: 'command', parameter: 'type file-a.txt' }],
            actionCount: 1,
            isSystemFeedback: true,
        });
        expect(continued).toEqual(expect.objectContaining({ accepted: true, allowActions: true, planRevision: 2 }));
        const runSteps = await store.listRunSteps(run.id);
        expect(runSteps).toHaveLength(2);
        expect(runSteps[1].status).toBe('running');

        await coordinator.recordAutonomousObservation({
            runId: run.id,
            stepId: runSteps[1].id,
            actionId: continued.actionId,
            planStepId: 'step_2',
            lane: 'command',
            status: 'succeeded',
            result: 'Summary: file-a.txt is present.',
        });

        const completed = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: run.id,
            requestId: 'request-plan-3',
            plan: {
                ...firstPlan,
                planId: run.id,
                revision: 3,
                status: 'complete',
                currentStepId: null,
                steps: firstPlan.steps.map((item) => ({ ...item, status: 'completed' })),
                completionSummary: 'The project root was listed and summarized.',
            },
            actions: [],
            actionCount: 0,
            isSystemFeedback: true,
        });
        expect(completed).toEqual(expect.objectContaining({ accepted: true, allowActions: false }));
        run = await store.getRun(run.id);
        expect(run.status).toBe('COMPLETED');
        const events = await store.listRunEvents(run.id);
        expect(events.filter((event) => event.eventType === 'autonomous_plan_received')).toHaveLength(3);
        expect(events.filter((event) => event.eventType === 'autonomous_observation_recorded')).toHaveLength(2);
    });

    test('does not accept another planned action before the current host Observation arrives', async () => {
        const plan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Inspect twice.', completionCriteria: 'Two observations are recorded.', status: 'running', currentStepId: 's1',
            steps: [
                { id: 's1', title: 'First inspection', status: 'in_progress', doneWhen: 'First Observation.' },
                { id: 's2', title: 'Second inspection', status: 'pending', doneWhen: 'Second Observation.' },
            ],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan,
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
        });
        const premature = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            plan: {
                ...plan,
                planId: first.runId,
                revision: 2,
                currentStepId: 's2',
                steps: plan.steps.map((item) => ({
                    ...item,
                    status: item.id === 's1' ? 'completed' : 'in_progress',
                })),
            },
            actions: [{ action: 'command', parameter: 'dir /b' }],
            actionCount: 1,
            isSystemFeedback: true,
        });

        expect(premature).toEqual(expect.objectContaining({
            accepted: false,
            code: 'M365_PLAN_OBSERVATION_PENDING',
        }));
        expect(await store.listRunSteps(first.runId)).toHaveLength(1);
    });

    test('pauses an active autonomous run when the next plan revision cannot be parsed', async () => {
        const firstPlan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Inspect once.', completionCriteria: 'The host observation is recorded.',
            status: 'running', currentStepId: 's1',
            steps: [{ id: 's1', title: 'Inspect', status: 'in_progress', doneWhen: 'Observed.' }],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan: firstPlan,
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
        });
        const [step] = await store.listRunSteps(first.runId);
        await coordinator.recordAutonomousObservation({
            runId: first.runId,
            stepId: step.id,
            actionId: first.actionId,
            status: 'succeeded',
            result: 'ok',
        });

        const rejected = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            requestId: 'bad-final-plan',
            planError: { code: 'M365_PLAN_JSON_INVALID', message: 'Malformed final plan.' },
            actions: [],
            actionCount: 0,
            isSystemFeedback: true,
        });

        expect(rejected).toEqual(expect.objectContaining({
            accepted: false,
            runId: first.runId,
            planRevision: 1,
        }));
        expect(await store.getRun(first.runId)).toEqual(expect.objectContaining({
            status: 'PAUSED',
            errorCode: 'M365_PLAN_JSON_INVALID',
        }));
        const events = await store.listRunEvents(first.runId);
        expect(events.some((event) => event.eventType === 'autonomous_plan_rejected')).toBe(true);

        await expect(coordinator.completeRun(first.runId, { confirmed: false })).rejects.toEqual(
            expect.objectContaining({ code: 'M365_RUN_COMPLETION_CONFIRMATION_REQUIRED' })
        );
        const completed = await coordinator.completeRun(first.runId, {
            confirmed: true,
            note: 'Visible final response and host evidence checked.',
        });
        expect(completed.status).toBe('COMPLETED');
        const completedEvents = await store.listRunEvents(first.runId);
        expect(completedEvents.some((event) => event.eventType === 'completion_confirmed_by_user')).toBe(true);
    });

    test('rejects a stale plan revision without creating another action step', async () => {
        const plan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Inspect.', completionCriteria: 'Observed.', status: 'running', currentStepId: 's1',
            steps: [{ id: 's1', title: 'Inspect', status: 'in_progress', doneWhen: 'Observed.' }],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan,
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
        });
        const [step] = await store.listRunSteps(first.runId);
        await coordinator.recordAutonomousObservation({
            runId: first.runId,
            stepId: step.id,
            actionId: first.actionId,
            status: 'succeeded',
            result: 'ok',
        });
        const stale = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            plan: { ...plan, planId: first.runId },
            actions: [{ action: 'command', parameter: 'dir' }],
            actionCount: 1,
            isSystemFeedback: true,
        });
        expect(stale).toEqual(expect.objectContaining({ accepted: false, code: 'M365_PLAN_REVISION_MISMATCH' }));
        expect(await store.listRunSteps(first.runId)).toHaveLength(1);
    });
});
