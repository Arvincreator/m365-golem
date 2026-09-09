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

    test.each(['running', 'blocked'])('repairs a %s plan without an action once, then pauses instead of looping', async status => {
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
        const exhausted = await coordinator.handleAutonomousPlan({ conversationId: conversation.id, existingRunId: first.runId,
            plan: { ...plan, planId: first.runId, revision: 2 }, actions: [], actionCount: 0 });
        expect(exhausted).toEqual(expect.objectContaining({
            accepted: false,
            stopRepair: true,
            code: 'M365_PROTOCOL_REPAIR_EXHAUSTED',
        }));
        expect((await store.getRun(first.runId))).toEqual(expect.objectContaining({
            status: 'WAITING_USER',
            errorCode: 'M365_PROTOCOL_REPAIR_EXHAUSTED',
        }));
        expect(await store.listRunSteps(first.runId)).toHaveLength(0);
        expect((await store.listRunEvents(first.runId))
            .filter((event) => event.eventType === 'autonomous_plan_action_repair')).toHaveLength(1);
        expect((await store.listRunEvents(first.runId))
            .filter((event) => event.eventType === 'autonomous_plan_action_repair_exhausted')).toHaveLength(1);

        const scheduleSpy = jest.spyOn(coordinator, '_scheduleAutonomousContinuation');
        await coordinator.resumeRun(first.runId, '請改用附件上傳並讀取第一張圖片');
        expect(scheduleSpy).toHaveBeenLastCalledWith(
            first.runId,
            expect.objectContaining({ revision: 2 }),
            '請改用附件上傳並讀取第一張圖片',
            'user_resume',
            'M365_PROTOCOL_REPAIR_EXHAUSTED'
        );
        coordinator._clearDispatchTimer(first.runId);
        await coordinator._beginAutonomousContinuation(
            first.runId,
            { ...plan, planId: first.runId, revision: 2 },
            '請改用附件上傳並讀取第一張圖片',
            'user_resume',
            'M365_PROTOCOL_REPAIR_EXHAUSTED'
        );
        const resumedMessage = server.dispatchM365WorkspaceMessage.mock.calls.at(-1)[0].message;
        expect(resumedMessage).toContain('[HOST_PAUSE_REASON]M365_PROTOCOL_REPAIR_EXHAUSTED[/HOST_PAUSE_REASON]');
        expect(resumedMessage).toContain('[USER_CONTINUATION_INPUT]\n請改用附件上傳並讀取第一張圖片\n[/USER_CONTINUATION_INPUT]');
    });

    test('allows one bounded repair for each distinct protocol failure kind', async () => {
        const run = await store.createRun(conversation.id, {
            objective: 'Compare two attached files',
            verification: 'Comparison is grounded in both attachments.',
            maxSteps: 12,
            startImmediately: true,
        });
        await store.appendRunEvent(run.id, 'autonomous_plan_received', {
            plan: {
                schemaVersion: 'golem_plan/1', planId: run.id, revision: 1,
                goal: 'Compare two attached files', status: 'running', currentStepId: 'step_1',
                completionCriteria: 'Comparison is grounded in both attachments.',
                steps: [{ id: 'step_1', title: 'Read attachments', status: 'in_progress', doneWhen: 'Both read' }],
                question: '', approvalRequest: '', completionSummary: '',
            },
        });
        await store.appendRunEvent(run.id, 'autonomous_protocol_repair', {
            kind: 'completion_evidence_missing', attempt: 1,
        });

        const result = await coordinator.requestProtocolRepair({
            runId: run.id,
            kind: 'completed_evidence_not_preserved',
            issues: ['completed_step_not_preserved:step_1'],
        });

        expect(result).toEqual(expect.objectContaining({
            accepted: false,
            protocolRepair: expect.objectContaining({ status: 'retry' }),
        }));
        expect((await store.getRun(run.id)).status).toBe('RUNNING');
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

    test('accepts multiple ordered actions as one plan step and one bound Observation', async () => {
        const plan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Rebuild and verify a Python script.', status: 'running', currentStepId: 'step_1',
            completionCriteria: 'The combined host Observation confirms the script was rebuilt and checked.',
            steps: [{ id: 'step_1', title: 'Rebuild and verify script', status: 'in_progress', doneWhen: 'Combined execution result is observed.' }],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const actions = [
            { action: 'command', parameter: 'echo first > weekly_report.py' },
            { action: 'command', parameter: 'echo second >> weekly_report.py' },
            { action: 'command', parameter: 'python weekly_report.py' },
        ];

        const accepted = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan,
            actions,
            actionCount: actions.length,
        });

        expect(accepted).toEqual(expect.objectContaining({ accepted: true, allowActions: true }));
        const [step] = await store.listRunSteps(accepted.runId);
        expect(step).toEqual(expect.objectContaining({ stepNumber: 1, status: 'running' }));
        const planned = (await store.listRunEvents(accepted.runId))
            .find((event) => event.eventType === 'autonomous_action_planned');
        expect(planned.payload).toEqual(expect.objectContaining({
            actionCount: 3,
            actionDescriptors: expect.arrayContaining([
                expect.objectContaining({ kind: 'command' }),
            ]),
        }));

        await coordinator.recordAutonomousObservation({
            runId: accepted.runId,
            stepId: step.id,
            actionId: accepted.actionId,
            planStepId: 'step_1',
            lane: 'command',
            status: 'succeeded',
            result: '[Step 1 Success]\nfirst\n---\n[Step 2 Success]\nsecond\n---\n[Step 3 Success]\nverified',
        });

        expect((await store.listRunEvents(accepted.runId))
            .filter((event) => event.eventType === 'autonomous_observation_recorded')).toHaveLength(1);
        expect((await store.listRunSteps(accepted.runId))[0].status).toBe('completed');
    });

    test('automatically repairs a missing action after a failed multi-action Observation', async () => {
        const plan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Rebuild and verify a Python report.', status: 'running', currentStepId: 'step_1',
            completionCriteria: 'A valid report is observed.',
            steps: [{ id: 'step_1', title: 'Build report', status: 'in_progress', doneWhen: 'The combined result verifies the report.' }],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            plan,
            actions: [
                { action: 'command', parameter: 'echo first > weekly_report.py' },
                { action: 'command', parameter: 'python weekly_report.py' },
            ],
            actionCount: 2,
        });
        const [step] = await store.listRunSteps(first.runId);
        await coordinator.recordAutonomousObservation({
            runId: first.runId,
            stepId: step.id,
            actionId: first.actionId,
            planStepId: 'step_1',
            lane: 'command',
            status: 'failed',
            result: '[Step 1 Failed] quoting error\n[Step 2 Failed] script missing',
        });
        expect((await store.listRunSteps(first.runId))[0].status).toBe('failed');

        const schedule = jest.spyOn(coordinator, '_scheduleAutonomousContinuation').mockImplementation(() => {});
        const repaired = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            plan: { ...plan, planId: first.runId, revision: 2 },
            actions: [],
            actionCount: 0,
            isSystemFeedback: true,
        });

        expect(repaired).toEqual(expect.objectContaining({
            accepted: true,
            allowActions: false,
            planRevision: 2,
        }));
        expect(repaired.warning).toBeUndefined();
        expect((await store.getRun(first.runId)).status).toBe('QUEUED');
        expect(schedule).toHaveBeenCalledWith(
            first.runId,
            expect.objectContaining({ revision: 2 }),
            '',
            'MISSING_ACTION_REPAIR'
        );
        schedule.mockRestore();
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
        expect(second).toEqual(expect.objectContaining({
            code: 'M365_PROTOCOL_REPAIR_EXHAUSTED',
            stopRepair: true,
        }));
        expect(second.protocolRepair).toBeUndefined();
        expect(await store.getRun(repair.runId)).toEqual(expect.objectContaining({
            status: 'WAITING_USER',
            errorCode: 'M365_PROTOCOL_REPAIR_EXHAUSTED',
        }));

        const envelopeRepair = await coordinator.requestProtocolRepair({
            runId: repair.runId,
            kind: 'unwrapped_visible_response',
        });
        expect(envelopeRepair).toBeNull();
    });

    test('recovers a visible file result from reconciliation and repairs only the missing plan state', async () => {
        const repair = await coordinator.startExecutionContract({
            conversationId: conversation.id,
            requestId: 'visible-result-request',
            objective: '建立並驗證 Word 報告',
            verification: 'A valid Word file is visible and linked.',
        });
        await store.appendRunEvent(repair.runId, 'autonomous_plan_received', {
            plan: {
                schemaVersion: 'golem_plan/1', planId: repair.runId, revision: 1,
                goal: '建立並驗證 Word 報告', completionCriteria: 'A valid Word file is visible and linked.',
                status: 'running', currentStepId: 'step_1',
                steps: [{ id: 'step_1', title: '建立報告', status: 'in_progress', doneWhen: 'Word file linked' }],
                question: '', approvalRequest: '', completionSummary: '',
            },
        });
        await store.transitionRun(repair.runId, 'RECONCILE_REQUIRED', {
            reason: 'AMBIGUOUS_BROWSER_DISPATCH',
            errorCode: 'M365_RESPONSE_NOT_FOUND',
        });

        const recovered = await coordinator.requestProtocolRepair({
            runId: repair.runId,
            kind: 'visible_result_recovered',
        });

        expect((await store.getRun(repair.runId)).status).toBe('QUEUED');
        expect(recovered.protocolRepair).toEqual(expect.objectContaining({
            status: 'retry',
            preserveVisibleResult: true,
        }));
        expect(recovered.protocolRepair.prompt).toContain('usable result and file link');
        expect(recovered.protocolRepair.prompt).toContain('Do not recreate the document');
        expect(recovered.protocolRepair.prompt).toContain('plan_checkpoint');
        expect(recovered.protocolRepair.prompt).toContain(`plan_id=${repair.runId}`);
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

    test('saves the deferred turn at the soft cap and starts a fresh N+1 automatic-turn allowance', async () => {
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
        const resumed = await coordinator.resumeRun(active.id, '', { continueAutoRun: true });
        expect(resumed.status).toBe('QUEUED');
        expect(schedule).toHaveBeenCalledWith(active.id, pendingPrompt, { used: 0, limit: 6, reset: true });

        schedule.mockRestore();
        await coordinator._beginDeferredAutoTurn(active.id, pendingPrompt, { used: 0, limit: 6, reset: true });
        expect(server.dispatchM365WorkspaceMessage).toHaveBeenCalledWith(expect.objectContaining({
            conversationId: conversation.id,
            message: pendingPrompt,
            runId: active.id,
            planId: active.id,
            internalControl: true,
            autoTurnBudget: { used: 0, limit: 6, reset: true },
        }));
        expect((await store.getRun(active.id)).status).toBe('RUNNING');
    });

    test('returns a resumed auto turn to user attention when response mode fails before dispatch', async () => {
        const active = await store.createRun(conversation.id, {
            objective: 'Continue a document workflow.',
            verification: 'The document is verified.',
            maxSteps: 4,
            startImmediately: true,
            origin: 'copilot',
        });
        const pendingPrompt = '[GOLEM_OBSERVATION]\nContinue.\n[/GOLEM_OBSERVATION]';
        await coordinator.pauseForAutoTurnLimit({
            runId: active.id,
            pendingPrompt,
            used: 5,
            limit: 5,
        });
        const schedule = jest.spyOn(coordinator, '_scheduleDeferredAutoTurn').mockImplementation(() => {});
        await coordinator.resumeRun(active.id, '', { continueAutoRun: true });
        schedule.mockRestore();
        server.dispatchM365WorkspaceMessage.mockRejectedValueOnce(Object.assign(
            new Error('mode hidden'),
            { code: 'M365_RESPONSE_MODE_UNAVAILABLE' }
        ));

        await coordinator._beginDeferredAutoTurn(active.id, pendingPrompt, {
            used: 0,
            limit: 6,
            reset: true,
        });

        expect(await store.getRun(active.id)).toEqual(expect.objectContaining({
            status: 'WAITING_USER',
            errorCode: 'M365_RESPONSE_MODE_UNAVAILABLE',
        }));
    });

    test('starts a fresh plan when a new user request repeats a terminal plan id', async () => {
        const plan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Create and verify a report.', status: 'running', currentStepId: 'step_1',
            completionCriteria: 'The report is visibly verified.',
            steps: [{ id: 'step_1', title: 'Create report', status: 'in_progress', doneWhen: 'Report exists' }],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            requestId: 'request-terminal-first',
            plan,
            actions: [{ action: 'command', parameter: 'Write-Output create' }],
            actionCount: 1,
        });
        await coordinator.cancelRun(first.runId);

        const restart = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            requestId: 'request-terminal-restart',
            plan: { ...plan, planId: first.runId, revision: 2 },
            actions: [{ action: 'command', parameter: 'Write-Output retry' }],
            actionCount: 1,
        });

        expect(restart).toEqual(expect.objectContaining({
            accepted: false,
            allowActions: false,
            code: 'M365_PLAN_RESTART_REQUIRED',
            runId: null,
            planId: null,
            planRevision: 0,
            resetAutoTurnBudget: true,
            protocolRepair: expect.objectContaining({ status: 'retry' }),
        }));
        expect(restart.protocolRepair.prompt).toContain('plan_id=null and revision=1');
        expect(restart.protocolRepair.prompt).toContain('Do not repeat, revise, or describe the terminal plan');
        expect(await store.listRuns(conversation.id)).toHaveLength(1);
    });

    test('silently stops delayed system feedback for a terminal plan', async () => {
        const plan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: 'Create and verify a report.', status: 'running', currentStepId: 'step_1',
            completionCriteria: 'The report is visibly verified.',
            steps: [{ id: 'step_1', title: 'Create report', status: 'in_progress', doneWhen: 'Report exists' }],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const first = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            requestId: 'request-terminal-system-first',
            plan,
            actions: [{ action: 'command', parameter: 'Write-Output create' }],
            actionCount: 1,
        });
        await coordinator.cancelRun(first.runId);

        const delayed = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: first.runId,
            requestId: 'request-terminal-system-delayed',
            isSystemFeedback: true,
            plan: { ...plan, planId: first.runId, revision: 1 },
            actions: [{ action: 'command', parameter: 'Write-Output delayed' }],
            actionCount: 1,
        });

        expect(delayed).toEqual(expect.objectContaining({
            accepted: false,
            allowActions: false,
            code: 'M365_PLAN_TERMINAL',
            runId: first.runId,
            planId: first.runId,
            stopRepair: true,
        }));
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

    test('host completes an evidence-backed plan when Copilot incorrectly asks the user to continue', async () => {
        const firstPlan = {
            schemaVersion: 'golem_plan/1', planId: null, revision: 1,
            goal: '列出指定 SharePoint 資料夾第一層內容',
            completionCriteria: '取得實際 SharePoint 資料夾內容',
            status: 'running', currentStepId: 'step_1',
            steps: [{ id: 'step_1', title: '讀取資料夾', status: 'in_progress', doneWhen: 'Host Observation 回傳清單' }],
            question: '', approvalRequest: '', completionSummary: '',
        };
        const accepted = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            requestId: 'sharepoint-plan-1',
            plan: firstPlan,
            actions: [{ action: 'mcp_call', server: 'm365-session-bridge', tool: 'm365_list_folder', parameters: {} }],
            actionCount: 1,
        });
        await coordinator.recordAutonomousObservation({
            runId: accepted.runId,
            stepId: accepted.stepId,
            actionId: accepted.actionId,
            planStepId: 'step_1',
            lane: 'mcp',
            status: 'succeeded',
            result: '11 files and 2 folders',
        });

        const closed = await coordinator.handleAutonomousPlan({
            conversationId: conversation.id,
            existingRunId: accepted.runId,
            requestId: 'sharepoint-plan-2',
            plan: {
                ...firstPlan,
                planId: accepted.runId,
                revision: 2,
                status: 'wait_user',
                currentStepId: null,
                steps: firstPlan.steps.map((step) => ({ ...step, status: 'completed' })),
                question: '請按繼續以恢復已暫停的流程。',
            },
            actions: [],
            actionCount: 0,
            isSystemFeedback: true,
        });

        expect(closed).toEqual(expect.objectContaining({ accepted: true, allowActions: false }));
        expect((await store.getRun(accepted.runId)).status).toBe('COMPLETED');
        expect((await store.listRunEvents(accepted.runId)).some((event) => event.eventType === 'autonomous_plan_host_completed')).toBe(true);
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
