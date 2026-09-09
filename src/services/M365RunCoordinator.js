'use strict';

const crypto = require('crypto');
const {
    getM365WorkspaceStore,
    isM365RunnerEnabled,
    serviceError,
} = require('./M365WorkspaceService');
const { parseM365RunControl } = require('./M365RunControlParser');
const {
    classifyUnverifiedStop,
    describeAction,
    validatePlanCompletion,
} = require('./M365ExecutionContract');
const TERMINAL_STATUSES = new Set(['FAILED', 'CANCELED', 'COMPLETED']);
const PRE_DISPATCH_ERROR_CODES = new Set([
    'M365_HUMAN_LOGIN_REQUIRED',
    'M365_TENANT_BLOCKED',
    'M365_UI_NOT_READY',
    'M365_UI_BUSY',
    'M365_UNEXPECTED_HOST',
    'M365_INSECURE_URL',
    'M365_RESPONSE_MODE_INVALID',
    'M365_RESPONSE_MODE_UNAVAILABLE',
    'M365_RESPONSE_MODE_SWITCH_FAILED',
    'BROWSER_PROFILE_IN_USE',
]);

function planForStorage(plan, planId) {
    return {
        schemaVersion: plan.schemaVersion,
        planId,
        revision: plan.revision,
        goal: plan.goal,
        completionCriteria: plan.completionCriteria,
        status: plan.status,
        currentStepId: plan.currentStepId,
        steps: plan.steps,
        question: plan.question,
        approvalRequest: plan.approvalRequest,
        completionSummary: plan.completionSummary,
    };
}

function buildRunStepPrompt(run, stepNumber, nextPrompt = '', userInput = '') {
    const focus = String(nextPrompt || '').trim()
        || (stepNumber === 1 ? 'Begin the work and complete the highest-value verifiable step.' : 'Continue toward the stated objective.');
    const sections = [
        `[M365_BOUNDED_RUN step="${stepNumber}" max_steps="${run.maxSteps}"]`,
        'You are continuing one bounded, text-only work run in this same M365 Copilot conversation.',
        'Do not claim that you opened files, changed systems, submitted records, or obtained approvals unless that evidence is present in this conversation.',
        'Stop for the user when required facts or professional judgment are missing. Accounting, tax, legal, audit, filing, and approval conclusions require human review.',
        '',
        '[RUN_OBJECTIVE]',
        run.objective,
        '[/RUN_OBJECTIVE]',
        '[RUN_CONSTRAINTS]',
        run.constraints || 'No additional constraints were provided.',
        '[/RUN_CONSTRAINTS]',
        '[COMPLETION_CHECK]',
        run.verification,
        '[/COMPLETION_CHECK]',
        '[THIS_STEP]',
        focus,
        '[/THIS_STEP]',
    ];
    if (userInput) {
        sections.push('[USER_CONTINUATION_INPUT]', userInput, '[/USER_CONTINUATION_INPUT]');
    }
    sections.push(
        '',
        'At the very end of your user-facing answer, include exactly one machine-readable block in this form:',
        '[GOLEM_RUN]',
        '{"status":"continue|wait_user|wait_approval|complete|blocked","step_summary":"short completed-step summary","next_prompt":"required only for continue","question":"required only for wait_user","approval_request":"required only for wait_approval","evidence":["short evidence item"]}',
        '[/GOLEM_RUN]',
        'Use status=complete only when the completion check is satisfied. Use continue only when another safe text step is clearly needed.',
        '[/M365_BOUNDED_RUN]'
    );
    return sections.join('\n');
}

class M365RunCoordinator {
    constructor(server) {
        this.server = server;
        this.store = null;
        this.runLocks = new Map();
        this.dispatchTimers = new Map();
        this.runLocalFolders = new Map();
        this.readyPromise = null;
    }

    rememberRunLocalFolders(runId, folders) {
        const id = String(runId || '').trim();
        if (!id || !Array.isArray(folders) || folders.length === 0) return;
        this.runLocalFolders.set(id, folders.slice(0, 3).map((folder) => ({
            id: String(folder.id || ''),
            name: String(folder.name || ''),
            path: String(folder.path || ''),
        })));
    }

    getRunLocalFolders(runId) {
        return (this.runLocalFolders.get(String(runId || '').trim()) || []).map((folder) => ({ ...folder }));
    }

    forgetRunLocalFolders(runId) {
        this.runLocalFolders.delete(String(runId || '').trim());
    }

    async init() {
        if (this.readyPromise) return this.readyPromise;
        this.readyPromise = (async () => {
            if (!isM365RunnerEnabled()) {
                throw serviceError('M365_RUNNER_DISABLED', 'M365 multi-step runs are disabled.', 409);
            }
            this.store = await getM365WorkspaceStore(this.server);
            await this._recoverInterruptedRuns();
            return this;
        })().catch((error) => {
            this.readyPromise = null;
            throw error;
        });
        return this.readyPromise;
    }

    async _withRunLock(runId, work) {
        const previous = this.runLocks.get(runId) || Promise.resolve();
        const current = previous.catch(() => undefined).then(work);
        this.runLocks.set(runId, current);
        try {
            return await current;
        } finally {
            if (this.runLocks.get(runId) === current) this.runLocks.delete(runId);
        }
    }

    _requireDispatcher() {
        if (typeof this.server.dispatchM365WorkspaceMessage !== 'function') {
            throw serviceError(
                'M365_RUNTIME_NOT_READY',
                'The M365 chat dispatcher is not ready yet.',
                503
            );
        }
        return this.server.dispatchM365WorkspaceMessage;
    }

    async _recoverInterruptedRuns() {
        const runs = await this.store.listRecoverableRuns();
        for (const run of runs) {
            if (run.status === 'QUEUED') {
                await this.store.transitionRun(run.id, 'PAUSED', {
                    reason: 'SERVER_RESTART_BEFORE_DISPATCH',
                    errorCode: 'M365_RUN_RESTARTED',
                });
                continue;
            }
            const steps = await this.store.listRunSteps(run.id);
            const runningStep = steps.find((step) => step.status === 'running');
            if (runningStep) {
                await this.store.updateRunStep(runningStep.id, {
                    status: 'reconcile_required',
                    summary: 'The local process restarted while this browser step was in flight.',
                });
            }
            await this.store.transitionRun(run.id, 'RECONCILE_REQUIRED', {
                stepId: runningStep?.id || null,
                reason: 'SERVER_RESTART_DURING_DISPATCH',
                errorCode: 'M365_RUN_RESTARTED_IN_FLIGHT',
            });
        }
    }

    async startRun(runId) {
        await this.init();
        return this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (run.status !== 'WAITING_START_APPROVAL') {
                throw serviceError('M365_RUN_START_INVALID', 'This run is not waiting for start approval.', 409);
            }
            const approvals = await this.store.listApprovals(runId);
            const approval = approvals.find((item) => item.status === 'pending' && item.approvalType === 'run_start');
            if (!approval) throw serviceError('M365_RUN_START_APPROVAL_MISSING', 'Start approval was not found.', 409);
            await this.store.decideApproval(approval.id, {
                status: 'approved',
                decision: 'User explicitly confirmed start in the local dashboard.',
            });
            const queuedRun = await this.store.transitionRun(runId, 'QUEUED', { reason: 'USER_APPROVED_START' });
            const step = await this._prepareNextStep(queuedRun, '', '');
            this._scheduleStep(runId, step.id);
            return this.store.getRun(runId);
        });
    }

    async pauseRun(runId) {
        await this.init();
        return this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (!['QUEUED', 'RUNNING'].includes(run.status)) {
                throw serviceError('M365_RUN_PAUSE_INVALID', 'Only queued or running work can be paused.', 409);
            }
            this._clearDispatchTimer(runId);
            await this.store.appendRunEvent(runId, 'pause_requested', {
                afterCurrentBrowserStep: run.status === 'RUNNING',
            });
            return this.store.transitionRun(runId, 'PAUSED', {
                reason: run.status === 'RUNNING' ? 'PAUSE_AFTER_CURRENT_STEP' : 'USER_PAUSED',
            });
        });
    }

    async resumeRun(runId, userInput = '', options = {}) {
        await this.init();
        return this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (!['PAUSED', 'WAITING_USER', 'BLOCKED'].includes(run.status)) {
                throw serviceError('M365_RUN_RESUME_INVALID', 'This run cannot be resumed from its current state.', 409);
            }
            const input = String(userInput || '').trim();
            const attachmentBatchId = String(options.attachmentBatchId || '').trim();
            const continueAutoRun = options.continueAutoRun === true;
            if (run.status === 'WAITING_USER' && run.errorCode === 'M365_AUTO_TURN_LIMIT') {
                if (!continueAutoRun) {
                    throw serviceError(
                        'M365_AUTO_RUN_CONTINUE_REQUIRED',
                        'Choose “Continue automatic execution” to start the next automatic-execution allowance.',
                        400
                    );
                }
                const events = await this.store.listRunEvents(runId);
                const gate = [...events].reverse().find((event) => event.eventType === 'auto_turn_limit_reached');
                const pendingPrompt = String(gate?.payload?.pendingPrompt || '').trim();
                if (!pendingPrompt) {
                    throw serviceError(
                        'M365_AUTO_TURN_PENDING_MISSING',
                        'The saved continuation could not be found. Stop this work or add a new clarification.',
                        409
                    );
                }
                const used = Math.max(0, Math.floor(Number(gate.payload.used) || 0));
                const previousLimit = Math.max(1, Math.floor(Number(gate.payload.limit) || used || 1));
                const nextLimit = previousLimit + 1;
                await this.store.appendRunEvent(runId, 'auto_turn_limit_extended', {
                    from: previousLimit,
                    to: nextLimit,
                    allowanceTurns: nextLimit,
                });
                const queuedRun = await this.store.transitionRun(runId, 'QUEUED', {
                    reason: 'USER_CONTINUED_AUTO_RUN',
                });
                this._scheduleDeferredAutoTurn(queuedRun.id, pendingPrompt, {
                    used: 0,
                    limit: nextLimit,
                    reset: true,
                });
                return this.store.getRun(runId);
            }
            if (['WAITING_USER', 'BLOCKED'].includes(run.status) && !input && !attachmentBatchId) {
                throw serviceError('M365_RUN_INPUT_REQUIRED', 'Add the requested clarification before continuing.', 400);
            }
            const steps = await this.store.listRunSteps(runId);
            const latest = steps[steps.length - 1] || null;
            if (latest?.status === 'running') {
                throw serviceError('M365_RUN_STEP_IN_FLIGHT', 'The current M365 browser step is still finishing.', 409);
            }
            const planEvent = await this._latestAutonomousPlan(runId);
            if (planEvent) {
                const queuedRun = await this.store.transitionRun(runId, 'QUEUED', {
                    reason: 'USER_RESUMED_AUTONOMOUS_PLAN',
                    stepId: latest?.id || null,
                });
                this._scheduleAutonomousContinuation(
                    queuedRun.id,
                    planEvent.payload.plan,
                    input || 'The user attached the requested files. Read them and continue the saved plan.',
                    'user_resume',
                    run.errorCode || '',
                    ...(attachmentBatchId ? [{ attachmentBatchId }] : [])
                );
                return this.store.getRun(runId);
            }
            const queuedRun = await this.store.transitionRun(runId, 'QUEUED', {
                reason: 'USER_RESUMED',
                stepId: latest?.id || null,
            });
            if (latest?.status === 'queued') {
                this._scheduleStep(runId, latest.id);
            } else {
                const step = await this._prepareNextStep(
                    queuedRun,
                    input ? 'Continue using the user clarification below.' : 'Continue safely from the last completed step.',
                    input
                );
                this._scheduleStep(runId, step.id);
            }
            return this.store.getRun(runId);
        });
    }

    async pauseForAutoTurnLimit({ runId, pendingPrompt, used, limit }) {
        await this.init();
        return this._withRunLock(runId, async () => {
            let run = await this.store.getRun(runId);
            if (TERMINAL_STATUSES.has(run.status) || run.goalMode) return run;
            const prompt = String(pendingPrompt || '').trim().slice(0, 200000);
            if (!prompt) {
                throw serviceError('M365_AUTO_TURN_PENDING_REQUIRED', 'The pending continuation is empty.', 400);
            }
            const resolvedUsed = Math.max(0, Math.floor(Number(used) || 0));
            const resolvedLimit = Math.max(1, Math.floor(Number(limit) || resolvedUsed || 1));
            this._clearDispatchTimer(runId);
            if (run.status === 'QUEUED') {
                run = await this.store.transitionRun(runId, 'RUNNING', {
                    reason: 'AUTO_TURN_LIMIT_PREPARE_PAUSE',
                });
            }
            await this.store.appendRunEvent(runId, 'auto_turn_limit_reached', {
                pendingPrompt: prompt,
                used: resolvedUsed,
                limit: resolvedLimit,
                nextLimit: resolvedLimit + 1,
            });
            if (run.status === 'RUNNING') {
                return this.store.transitionRun(runId, 'WAITING_USER', {
                    reason: 'AUTO_TURN_LIMIT_REACHED',
                    errorCode: 'M365_AUTO_TURN_LIMIT',
                });
            }
            return run;
        });
    }

    async cancelRun(runId) {
        await this.init();
        return this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (TERMINAL_STATUSES.has(run.status)) {
                this.forgetRunLocalFolders(runId);
                return run;
            }
            this._clearDispatchTimer(runId);
            const steps = await this.store.listRunSteps(runId);
            const activeStep = [...steps].reverse().find((step) => ['queued', 'running', 'waiting'].includes(step.status));
            if (activeStep) {
                await this.store.updateRunStep(activeStep.id, {
                    status: 'canceled',
                    summary: activeStep.status === 'running'
                        ? 'Continuation canceled; an already submitted M365 browser turn may still finish.'
                        : 'Canceled before dispatch.',
                });
            }
            const canceled = await this.store.transitionRun(runId, 'CANCELED', {
                stepId: activeStep?.id || null,
                reason: 'USER_CANCELED',
            });
            this.forgetRunLocalFolders(runId);
            return canceled;
        });
    }

    async completeRun(runId, input = {}) {
        await this.init();
        return this._withRunLock(runId, async () => {
            if (input.confirmed !== true) {
                throw serviceError(
                    'M365_RUN_COMPLETION_CONFIRMATION_REQUIRED',
                    '請先確認可見 M365 回覆與宿主執行紀錄已證明工作完成。',
                    400
                );
            }
            const run = await this.store.getRun(runId);
            if (run.status === 'COMPLETED') {
                this.forgetRunLocalFolders(runId);
                return run;
            }
            if (!['RUNNING', 'PAUSED', 'WAITING_USER', 'BLOCKED'].includes(run.status)) {
                throw serviceError(
                    'M365_RUN_COMPLETE_INVALID',
                    '目前狀態不能由使用者確認完成。',
                    409
                );
            }
            const steps = await this.store.listRunSteps(runId);
            if (steps.length === 0) {
                throw serviceError(
                    'M365_RUN_COMPLETION_EVIDENCE_REQUIRED',
                    '還沒有宿主執行或檢查紀錄，不能標記完成。',
                    409
                );
            }
            const inFlight = steps.find((step) => ['queued', 'running', 'reconcile_required'].includes(step.status));
            if (inFlight) {
                throw serviceError(
                    'M365_RUN_STEP_IN_FLIGHT',
                    '目前仍有宿主動作尚未結束，不能標記完成。',
                    409
                );
            }
            this._clearDispatchTimer(runId);
            await this.store.appendRunEvent(runId, 'completion_confirmed_by_user', {
                note: String(input.note || '').trim().slice(0, 2000),
            });
            const completed = await this.store.transitionRun(runId, 'COMPLETED', {
                reason: 'USER_VERIFIED_COMPLETION',
            });
            this.forgetRunLocalFolders(runId);
            return completed;
        });
    }

    async decideApproval(approvalId, input = {}) {
        await this.init();
        const approvalsStatus = String(input.status || '').toLowerCase();
        const approval = await this.store.decideApproval(approvalId, {
            status: approvalsStatus,
            decision: input.decision || '',
        });
        if (approval.approvalType === 'run_start') {
            if (approvalsStatus !== 'approved') return this.cancelRun(approval.runId);
            return this._withRunLock(approval.runId, async () => {
                const run = await this.store.getRun(approval.runId);
                if (run.status !== 'WAITING_START_APPROVAL') {
                    throw serviceError('M365_RUN_START_INVALID', 'This run is not waiting to start.', 409);
                }
                const queuedRun = await this.store.transitionRun(run.id, 'QUEUED', { reason: 'USER_APPROVED_START' });
                const step = await this._prepareNextStep(queuedRun, '', '');
                this._scheduleStep(run.id, step.id);
                return this.store.getRun(run.id);
            });
        }
        if (approvalsStatus !== 'approved') return this.cancelRun(approval.runId);
        return this.resumeApprovalRun(approval.runId);
    }

    async resumeApprovalRun(runId) {
        return this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (run.status !== 'WAITING_APPROVAL') {
                throw serviceError('M365_RUN_APPROVAL_STATE_INVALID', 'This run is not waiting for approval.', 409);
            }
            const queuedRun = await this.store.transitionRun(runId, 'QUEUED', { reason: 'USER_APPROVED_CONTINUATION' });
            const planEvent = await this._latestAutonomousPlan(runId);
            if (planEvent) {
                this._scheduleAutonomousContinuation(queuedRun.id, planEvent.payload.plan, '', 'user_approval');
                return this.store.getRun(runId);
            }
            const step = await this._prepareNextStep(queuedRun, 'Continue after the user-approved checkpoint.', '');
            this._scheduleStep(runId, step.id);
            return this.store.getRun(runId);
        });
    }

    async reconcileRun(runId, input = {}) {
        await this.init();
        return this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (run.status !== 'RECONCILE_REQUIRED') {
                throw serviceError('M365_RUN_RECONCILE_INVALID', 'This run does not require reconciliation.', 409);
            }
            const resolution = String(input.resolution || '').toLowerCase();
            const conversation = await this.store.getConversation(run.conversationId);
            const restoredBindingState = conversation.remoteConversationUrl && conversation.remoteConversationId
                ? 'bound'
                : 'unbound';
            if (resolution === 'abandon') {
                await this.store.setConversationBindingState(conversation.id, restoredBindingState);
                const canceled = await this.store.transitionRun(runId, 'CANCELED', { reason: 'USER_ABANDONED_RECONCILIATION' });
                this.forgetRunLocalFolders(runId);
                return canceled;
            }
            if (resolution === 'completed') {
                await this.store.setConversationBindingState(conversation.id, restoredBindingState);
                const completed = await this.store.transitionRun(runId, 'COMPLETED', { reason: 'USER_VERIFIED_COMPLETION' });
                this.forgetRunLocalFolders(runId);
                return completed;
            }
            if (resolution !== 'not_sent') {
                throw serviceError(
                    'M365_RUN_RECONCILE_RESOLUTION_INVALID',
                    'Choose not_sent, completed, or abandon after checking the visible Edge conversation.',
                    400
                );
            }
            await this.store.setConversationBindingState(conversation.id, restoredBindingState);
            const queuedRun = await this.store.transitionRun(runId, 'QUEUED', { reason: 'USER_VERIFIED_NOT_SENT' });
            const step = await this._prepareNextStep(
                queuedRun,
                'Retry only because the user explicitly verified that the prior browser turn was not sent.',
                String(input.note || '')
            );
            this._scheduleStep(runId, step.id);
            return this.store.getRun(runId);
        });
    }

    async _prepareNextStep(run, nextPrompt, userInput) {
        if (run.currentStep >= run.maxSteps) {
            const running = await this.store.transitionRun(run.id, 'RUNNING', { currentStep: run.currentStep });
            await this.store.transitionRun(running.id, 'BLOCKED', {
                reason: 'MAX_STEPS_REACHED',
                errorCode: 'M365_RUN_STEP_LIMIT',
            });
            throw serviceError('M365_RUN_STEP_LIMIT', 'The configured maximum step count was reached.', 409);
        }
        const stepNumber = run.currentStep + 1;
        return this.store.createRunStep(run.id, {
            stepNumber,
            requestId: crypto.randomUUID(),
            prompt: buildRunStepPrompt(run, stepNumber, nextPrompt, userInput),
            summary: '',
        });
    }

    _scheduleStep(runId, stepId) {
        this._clearDispatchTimer(runId);
        const timer = setTimeout(() => {
            this.dispatchTimers.delete(runId);
            this._beginStepDispatch(runId, stepId).catch((error) => {
                console.error('[M365RunCoordinator] Failed to dispatch step:', error);
            });
        }, 100);
        if (typeof timer.unref === 'function') timer.unref();
        this.dispatchTimers.set(runId, timer);
    }

    _scheduleAutonomousContinuation(runId, plan, userInput = '', reason = 'resume', priorErrorCode = '', dispatchOptions = {}) {
        this._clearDispatchTimer(runId);
        const timer = setTimeout(() => {
            this.dispatchTimers.delete(runId);
            this._beginAutonomousContinuation(runId, plan, userInput, reason, priorErrorCode, dispatchOptions).catch((error) => {
                console.error('[M365RunCoordinator] Failed to resume autonomous plan:', error);
            });
        }, 100);
        if (typeof timer.unref === 'function') timer.unref();
        this.dispatchTimers.set(runId, timer);
    }

    _scheduleDeferredAutoTurn(runId, pendingPrompt, autoTurnBudget) {
        this._clearDispatchTimer(runId);
        const timer = setTimeout(() => {
            this.dispatchTimers.delete(runId);
            this._beginDeferredAutoTurn(runId, pendingPrompt, autoTurnBudget).catch((error) => {
                console.error('[M365RunCoordinator] Failed to dispatch saved auto turn:', error);
            });
        }, 100);
        if (typeof timer.unref === 'function') timer.unref();
        this.dispatchTimers.set(runId, timer);
    }

    async _beginDeferredAutoTurn(runId, pendingPrompt, autoTurnBudget) {
        await this.init();
        let dispatchInput = null;
        await this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (run.status !== 'QUEUED') return;
            const conversation = await this.store.getConversation(run.conversationId);
            const latestPlan = await this._latestAutonomousPlan(runId);
            await this.store.transitionRun(runId, 'RUNNING', { reason: 'AUTO_TURN_GRANT_DISPATCH' });
            dispatchInput = {
                golemId: 'golem_A',
                projectId: conversation.projectId,
                conversationId: conversation.id,
                message: String(pendingPrompt || ''),
                runId,
                planId: runId,
                planRevision: Number(latestPlan?.payload?.plan?.revision || 0),
                requestId: crypto.randomUUID(),
                internalControl: true,
                toolRoutingQuery: run.objective,
                goalMode: run.goalMode === true,
                maxActionDepth: run.maxSteps,
                autoTurnBudget,
            };
        });
        if (!dispatchInput) return;
        try {
            await this._requireDispatcher()(dispatchInput);
        } catch (error) {
            await this._withRunLock(runId, async () => {
                const run = await this.store.getRun(runId);
                if (run.status !== 'RUNNING') return;
                const preDispatch = PRE_DISPATCH_ERROR_CODES.has(String(error?.code || ''));
                await this.store.transitionRun(runId, preDispatch ? 'WAITING_USER' : 'RECONCILE_REQUIRED', {
                    reason: preDispatch ? 'AUTO_TURN_GRANT_PRE_DISPATCH_FAILED' : 'AUTO_TURN_GRANT_AMBIGUOUS',
                    errorCode: String(error?.code || 'M365_RUN_DISPATCH_FAILED'),
                });
            });
        }
    }

    async _beginAutonomousContinuation(runId, plan, userInput, reason, priorErrorCode = '', dispatchOptions = {}) {
        await this.init();
        let dispatchInput = null;
        await this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (run.status !== 'QUEUED') return;
            const conversation = await this.store.getConversation(run.conversationId);
            await this.store.transitionRun(runId, 'RUNNING', { reason: 'AUTONOMOUS_PLAN_RESUME_DISPATCH' });
            const lines = [
                '[GOLEM_PLAN_CONTROL]',
                `The Golem host has resumed plan ${runId}.`,
                `Last accepted revision: ${Number(plan?.revision || 0)}. Return revision ${Number(plan?.revision || 0) + 1} using the exact same plan_id.`,
                `Resume reason: ${reason}.`,
                'Re-evaluate the saved plan. If status=running, emit one GOLEM_ACTION block with one or more ordered actions for the current step. Otherwise return a valid non-running plan status.',
            ];
            if (run.goalMode) lines.push(
                'Goal mode remains active: keep working until the objective is verified, unless human authorization, essential user input, a safety boundary, or repeated no-progress requires a pause.',
                'Do not access or modify paths outside the assigned project workspace. User-selected folders remain bounded read-only sources. Action Gate permissions are unchanged.'
            );
            if (reason === 'MISSING_ACTION_REPAIR') lines.push(
                'The previous response updated the plan but supplied no action and no concrete blocker. No new tool was executed. Lack of an observation for an unattempted step is not a blocker.',
                'Using the existing goal and verified results, emit the next necessary GOLEM_ACTION with status=running. Do not repeat completed work. If genuinely blocked, specify the actual failure or missing input in question. Preserve approval and access boundaries.'
            );
            if (priorErrorCode) lines.push(
                `[HOST_PAUSE_REASON]${priorErrorCode}[/HOST_PAUSE_REASON]`,
                'The host paused this run for the reason above. Use the newest user input and that reason to correct the next plan revision; do not merely repeat the previous response.'
            );
            if (userInput) lines.push('[USER_CONTINUATION_INPUT]', userInput, '[/USER_CONTINUATION_INPUT]');
            lines.push('[/GOLEM_PLAN_CONTROL]');
            dispatchInput = {
                golemId: 'golem_A',
                projectId: conversation.projectId,
                conversationId: conversation.id,
                message: lines.join('\n'),
                runId,
                planId: runId,
                planRevision: Number(plan?.revision || 0),
                requestId: crypto.randomUUID(),
                internalControl: true,
                toolRoutingQuery: run.objective,
                goalMode: run.goalMode === true,
                maxActionDepth: run.maxSteps,
                attachmentBatchId: String(dispatchOptions.attachmentBatchId || '').trim() || undefined,
            };
        });
        if (!dispatchInput) return;
        try {
            await this._requireDispatcher()(dispatchInput);
        } catch (error) {
            await this._withRunLock(runId, async () => {
                const run = await this.store.getRun(runId);
                if (run.status !== 'RUNNING') return;
                const preDispatch = PRE_DISPATCH_ERROR_CODES.has(String(error?.code || ''));
                await this.store.transitionRun(runId, preDispatch ? 'WAITING_USER' : 'RECONCILE_REQUIRED', {
                    reason: preDispatch ? 'AUTONOMOUS_RESUME_PRE_DISPATCH_FAILED' : 'AUTONOMOUS_RESUME_AMBIGUOUS',
                    errorCode: String(error?.code || 'M365_RUN_DISPATCH_FAILED'),
                });
            });
        }
    }

    _clearDispatchTimer(runId) {
        const timer = this.dispatchTimers.get(runId);
        if (timer) clearTimeout(timer);
        this.dispatchTimers.delete(runId);
    }

    async _beginStepDispatch(runId, stepId) {
        await this.init();
        let dispatchInput = null;
        await this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (run.status !== 'QUEUED') return;
            const steps = await this.store.listRunSteps(runId);
            const step = steps.find((item) => item.id === stepId);
            if (!step || step.status !== 'queued') return;
            const conversation = await this.store.getConversation(run.conversationId);
            await this.store.transitionRun(runId, 'RUNNING', {
                currentStep: step.stepNumber,
                stepId: step.id,
                reason: 'STEP_DISPATCH_STARTED',
            });
            await this.store.updateRunStep(step.id, { status: 'running', summary: '' });
            dispatchInput = {
                golemId: 'golem_A',
                projectId: conversation.projectId,
                conversationId: conversation.id,
                message: step.prompt,
                runId,
                stepId: step.id,
                requestId: step.requestId,
                internalControl: true,
                toolRoutingQuery: run.objective,
                goalMode: run.goalMode === true,
                maxActionDepth: run.maxSteps,
            };
        });
        if (!dispatchInput) return;
        try {
            await this._requireDispatcher()(dispatchInput);
        } catch (error) {
            await this.handleDispatchError({
                runId,
                stepId,
                error,
                ambiguous: false,
            });
        }
    }

    async handleDispatchError({ runId, stepId, error, ambiguous = true }) {
        await this.init();
        return this._withRunLock(runId, () => this._handleDispatchErrorLocked({
            runId,
            stepId,
            error,
            ambiguous,
        }));
    }

    async _handleDispatchErrorLocked({ runId, stepId, error, ambiguous }) {
        const run = await this.store.getRun(runId);
        if (TERMINAL_STATUSES.has(run.status)) return run;
        const steps = await this.store.listRunSteps(runId);
        const step = steps.find((item) => item.id === stepId);
        if (!step || !['running', 'queued'].includes(step.status)) return run;
        const code = String(error?.code || 'M365_RUN_DISPATCH_FAILED');
        const preDispatch = PRE_DISPATCH_ERROR_CODES.has(code) && !ambiguous;
        await this.store.updateRunStep(step.id, {
            status: preDispatch ? 'waiting' : 'reconcile_required',
            summary: preDispatch
                ? 'The browser step did not start and requires user attention.'
                : 'The browser dispatch result is ambiguous and must be checked in Edge.',
        });
        return this.store.transitionRun(runId, preDispatch ? 'WAITING_USER' : 'RECONCILE_REQUIRED', {
            stepId,
            reason: preDispatch ? 'SAFE_PRE_DISPATCH_FAILURE' : 'AMBIGUOUS_BROWSER_DISPATCH',
            errorCode: code,
        });
    }

    async _latestAutonomousPlan(runId) {
        const events = await this.store.listRunEvents(runId);
        return [...events].reverse().find((event) => event.eventType === 'autonomous_plan_received') || null;
    }

    async _activePlanConflictResult(activeRun, { resumeFromUser = false } = {}) {
        const priorStatus = activeRun.status;
        const priorErrorCode = activeRun.errorCode;
        let run = activeRun;
        if (resumeFromUser && ['WAITING_USER', 'BLOCKED'].includes(run.status)) {
            run = await this.store.transitionRun(run.id, 'QUEUED', {
                reason: 'USER_MESSAGE_REQUESTED_REPLAN',
            });
            run = await this.store.transitionRun(run.id, 'RUNNING', {
                reason: 'USER_MESSAGE_REPLAN_APPLYING',
            });
        }
        const activePlan = await this._latestAutonomousPlan(run.id);
        const activeRevision = Number(activePlan?.payload?.plan?.revision || 0);
        const hasAcceptedPlan = activeRevision > 0;
        const prompt = [
            '[GOLEM_ACTIVE_PLAN_CONFLICT]',
            `The host rejected the new plan because run ${run.id} was still ${priorStatus}.`,
            priorErrorCode ? `Host state reason: ${priorErrorCode}.` : '',
            resumeFromUser && ['WAITING_USER', 'BLOCKED'].includes(priorStatus)
                ? 'The newest user message is an allowed intervention. The host resumed this same run so you may continue it or redesign its unfinished steps.'
                : '',
            hasAcceptedPlan
                ? `Continue with plan_id=${run.id}; the next revision must be ${activeRevision + 1}. Do not create another plan yet.`
                : 'The host has reserved this run but has not accepted its first plan. Return plan_id=null and revision=1; do not create another host run.',
            'Use the active plan and the newest user message to decide whether to continue, replan, or ask for the specific missing input.',
            'You may replace unfinished steps in the next revision and mark obsolete steps skipped. Preserve completed steps that have host evidence. Replanning is allowed and does not require closing this run.',
            'Only mark the active plan complete when host Observations satisfy its completion check. Never fake completion to clear it.',
            'Once the host accepts a terminal state, the next user task can start as a new plan.',
            '[/GOLEM_ACTIVE_PLAN_CONFLICT]',
        ].filter(Boolean).join('\n');
        return {
            accepted: false,
            allowActions: false,
            planMode: true,
            runId: run.id,
            planId: hasAcceptedPlan ? run.id : null,
            planRevision: activeRevision,
            maxActionDepth: run.maxSteps,
            goalMode: run.goalMode === true,
            resetAutoTurnBudget: resumeFromUser,
            protocolRepair: {
                status: 'retry',
                prompt,
                toolRoutingQuery: run.objective,
                message: '偵測到尚未結案的工作，正在把狀態交回 Copilot 續接或重新規劃。',
            },
        };
    }

    async startExecutionContract({ conversationId, requestId = '', objective, verification, localFolders = [], goalMode = false }) {
        await this.init();
        let run;
        try {
            run = await this.store.createRun(conversationId, {
                objective,
                constraints: 'The user explicitly requested execution. Discover and use available resources, retain Action Gate controls, and do not replace execution with suggestions.',
                verification,
                maxSteps: 12,
                goalMode,
                startImmediately: true,
                origin: 'host_execution_contract',
            });
        } catch (error) {
            if (error?.code === 'M365_CONVERSATION_HAS_ACTIVE_RUN') {
                const activeRun = (await this.store.listRuns(conversationId))
                    .find((item) => !TERMINAL_STATUSES.has(item.status));
                if (activeRun) return this._activePlanConflictResult(activeRun, { resumeFromUser: true });
            }
            throw error;
        }
        this.rememberRunLocalFolders(run.id, localFolders);
        await this.store.appendRunEvent(run.id, 'execution_contract_created', { requestId });
        return this.requestProtocolRepair({ runId: run.id, kind: 'missing_initial_execution' });
    }

    async requestProtocolRepair({ runId, kind = 'missing_plan_or_action', issues = [] }) {
        await this.init();
        return this._withRunLock(runId, () => this._requestProtocolRepairLocked({ runId, kind, issues }));
    }

    async _requestProtocolRepairLocked({ runId, kind = 'missing_plan_or_action', issues = [] }) {
        let run = await this.store.getRun(runId);
        const visibleResultRecovered = kind === 'visible_result_recovered';
        const unwrappedVisibleResponse = kind === 'unwrapped_visible_response';
        const recoverableVisibleResponse = visibleResultRecovered || unwrappedVisibleResponse;
        if (TERMINAL_STATUSES.has(run.status) || ['WAITING_USER', 'WAITING_APPROVAL', 'PAUSED'].includes(run.status)
            || (run.status === 'RECONCILE_REQUIRED' && !recoverableVisibleResponse)) {
            return null;
        }
        if (run.status === 'RECONCILE_REQUIRED' && recoverableVisibleResponse) {
            run = await this.store.transitionRun(run.id, 'QUEUED', {
                reason: 'VISIBLE_RESULT_RECOVERED_AFTER_AMBIGUOUS_RESPONSE',
            });
            await this.store.appendRunEvent(run.id, 'ambiguous_response_recovered', {
                kind,
            });
        }
        const events = await this.store.listRunEvents(runId);
        const sameKindRepairs = events.filter((event) => event.eventType === 'autonomous_protocol_repair'
            && event.payload?.kind === kind).length;

        const latest = [...events].reverse().find((event) => event.eventType === 'autonomous_plan_received');
        const hasExecutionContract = events.some((event) => event.eventType === 'execution_contract_created');
        const rejectedFirstPlan = new Set([
            'completion_evidence_missing',
            'unverified_capability_blocker',
            'repeated_permission_request',
        ]).has(kind);
        if (!latest && !hasExecutionContract && !rejectedFirstPlan) return null;
        const nextRevision = Number(latest?.payload?.plan?.revision || 0) + 1;
        const hasPlan = Boolean(latest);
        // One corrective turn is enough for ordinary format failures. A second
        // turn is allowed only when the host recovered a genuinely visible
        // result and needs to bind that result back to durable plan state.
        // Each distinct contract problem gets its own bounded correction. A
        // prior repair for (for example) missing completion evidence must not
        // consume the only chance to repair a later revision-history mistake.
        if (sameKindRepairs >= (recoverableVisibleResponse ? 2 : 1)) {
            if (run.status === 'QUEUED') {
                run = await this.store.transitionRun(run.id, 'RUNNING', {
                    reason: 'PROTOCOL_REPAIR_EXHAUSTED_PREPARE_PAUSE',
                });
            }
            if (run.status === 'RUNNING') {
                run = await this.store.transitionRun(run.id, 'WAITING_USER', {
                    reason: 'M365_PROTOCOL_REPAIR_EXHAUSTED',
                    errorCode: 'M365_PROTOCOL_REPAIR_EXHAUSTED',
                });
            }
            await this.store.appendRunEvent(run.id, 'autonomous_protocol_repair_exhausted', {
                kind,
                attempts: sameKindRepairs,
            });
            return {
                accepted: false,
                allowActions: false,
                planMode: true,
                runId: run.id,
                planId: hasPlan ? run.id : null,
                planRevision: hasPlan ? nextRevision - 1 : 0,
                maxActionDepth: run.maxSteps,
                code: 'M365_PROTOCOL_REPAIR_EXHAUSTED',
                warning: '⚠️ 自主計畫已暫停：Copilot 未依執行格式提出可執行步驟，系統已停止自動補正，避免重複訊息。',
                stopRepair: true,
            };
        }
        const preserveVisibleResult = recoverableVisibleResponse;
        const prompt = [
            '[GOLEM_EXECUTION_REPAIR]',
            preserveVisibleResult
                ? (unwrappedVisibleResponse
                    ? 'The prior visible Microsoft 365 response omitted the required Golem envelope. Its visible user-facing result has already been delivered by the host.'
                    : 'The prior visible Microsoft 365 response included a usable result and file link, but omitted the active plan control state. The host recovered and displayed that result.')
                : 'The prior response did not satisfy the active execution contract. It was not a successful tool attempt.',
            `Repair reason: ${kind}.`,
            issues.length > 0 ? `Unmet host checks: ${issues.slice(0, 12).join(', ')}.` : '',
            '[RUN_OBJECTIVE]', run.objective, '[/RUN_OBJECTIVE]',
            '[COMPLETION_CHECK]', run.verification, '[/COMPLETION_CHECK]',
            hasPlan
                ? `Return GOLEM_PLAN revision ${nextRevision} with plan_id=${run.id}. Preserve completed steps that have host evidence.`
                : 'Create GOLEM_PLAN revision 1 with plan_id=null. The host has reserved the run but has not accepted a plan yet.',
            preserveVisibleResult
                ? 'Do not recreate the document, repeat the prior action, or produce a second copy. Restore only the missing envelope and plan control state. If the visible native result advances the current step, bind it with one plan_checkpoint action and concise visible evidence.'
                : '',
            'If work remains and the inputs are sufficient, set status=running and include one GOLEM_ACTION block with one or more ordered actions for the current step in this same response.',
            'Use the available tool-routing guide. If runtime availability is uncertain, the first action may be a bounded read-only capability check. Do not ask the user to repeat permission already present in the objective.',
            'Use blocked or wait_user only for a concrete obstacle or missing input, and state that specific fact in question. Do not mark complete until every completed step has a successful host Observation and the completion check is satisfied.',
            '[/GOLEM_EXECUTION_REPAIR]',
        ].filter(Boolean).join('\n');
        await this.store.appendRunEvent(run.id, 'autonomous_protocol_repair', {
            kind,
            attempt: sameKindRepairs + 1,
            issues: issues.slice(0, 12),
        });
        return {
            accepted: false,
            allowActions: false,
            planMode: true,
            runId: run.id,
            planId: hasPlan ? run.id : null,
            planRevision: hasPlan ? nextRevision - 1 : 0,
            maxActionDepth: run.maxSteps,
            protocolRepair: {
                status: 'retry',
                attempt: sameKindRepairs + 1,
                prompt,
                toolRoutingQuery: run.objective,
                preserveVisibleResult,
                message: sameKindRepairs === 0 && kind === 'missing_initial_execution'
                    ? '正在確認可用資源並準備執行…'
                    : '',
            },
        };
    }

    async _isAutonomousRun(runId) {
        return Boolean(await this._latestAutonomousPlan(runId));
    }

    _planRejection(code, message, extra = {}) {
        return {
            accepted: false,
            allowActions: false,
            planMode: true,
            code,
            warning: `⚠️ 自主計畫已暫停：${message}`,
            ...extra,
        };
    }

    _terminalPlanRestartResult(run, plan) {
        return {
            accepted: false,
            allowActions: false,
            planMode: true,
            code: 'M365_PLAN_RESTART_REQUIRED',
            runId: null,
            planId: null,
            planRevision: 0,
            maxActionDepth: run.maxSteps,
            resetAutoTurnBudget: true,
            protocolRepair: {
                status: 'retry',
                prompt: [
                    '[GOLEM_PLAN_RESTART]',
                    `The previous plan ${run.id} is terminal and cannot be revised or resumed.`,
                    'The current user message is a new execution request. Do not repeat, revise, or describe the terminal plan.',
                    'Create a fresh GOLEM_PLAN with plan_id=null and revision=1.',
                    'If work can proceed, use status=running and include the GOLEM_ACTION block for its first current step in the same response.',
                    'Preserve only verified results from prior host Observations; do not treat the prior failure as completion evidence.',
                    '[/GOLEM_PLAN_RESTART]',
                ].join('\n'),
                toolRoutingQuery: plan.goal,
                message: '正在建立新的執行計畫並重新開始…',
            },
        };
    }

    async handleAutonomousPlan({
        conversationId,
        requestId = '',
        existingRunId = null,
        plan = null,
        planError = null,
        actionCount = 0,
        actions = [],
        isSystemFeedback = false,
        workspaceRoot = '',
        localFolders = [],
        goalMode = false,
    }) {
        await this.init();
        if (planError) {
            if (existingRunId) {
                return this._withRunLock(existingRunId, async () => {
                    let run;
                    try {
                        run = await this.store.getRun(existingRunId);
                    } catch (_) {
                        return this._planRejection(
                            planError.code || 'M365_PLAN_INVALID',
                            planError.message || '計畫格式無效。'
                        );
                    }
                    await this.store.appendRunEvent(existingRunId, 'autonomous_plan_rejected', {
                        requestId,
                        errorCode: planError.code,
                        message: planError.message,
                    });
                    if (['QUEUED', 'RUNNING'].includes(run.status)) {
                        run = await this.store.transitionRun(existingRunId, 'PAUSED', {
                            reason: 'AUTONOMOUS_PLAN_PARSE_ERROR',
                            errorCode: planError.code || 'M365_PLAN_INVALID',
                        });
                    }
                    const latestEvent = await this._latestAutonomousPlan(existingRunId);
                    return this._planRejection(
                        planError.code || 'M365_PLAN_INVALID',
                        planError.message || '計畫格式無效。',
                        {
                            runId: run.id,
                            planId: run.id,
                            planRevision: Number(latestEvent?.payload?.plan?.revision || 0),
                        }
                    );
                });
            }
            return this._planRejection(planError.code || 'M365_PLAN_INVALID', planError.message || '計畫格式無效。');
        }
        if (!plan) return null;
        if (!conversationId) {
            return this._planRejection('M365_PLAN_CONVERSATION_REQUIRED', '找不到目前的專案對話。');
        }

        if (!existingRunId && plan.planId && isSystemFeedback !== true) {
            let referencedRun = null;
            try {
                referencedRun = await this.store.getRun(plan.planId);
            } catch (_) { }
            if (referencedRun
                && referencedRun.conversationId === conversationId
                && TERMINAL_STATUSES.has(referencedRun.status)) {
                return this._terminalPlanRestartResult(referencedRun, plan);
            }
        }

        let resolvedRunId = existingRunId || plan.planId || null;
        if (!resolvedRunId) {
            if (plan.revision !== 1 || plan.planId !== null) {
                return this._planRejection('M365_PLAN_FIRST_REVISION_INVALID', '新計畫必須使用 plan_id=null、revision=1。');
            }
            try {
                const created = await this.store.createRun(conversationId, {
                    objective: plan.goal,
                    constraints: 'Copilot-authored autonomous plan. Tool actions remain subject to Action Gate and host policy.',
                    verification: plan.completionCriteria,
                    maxSteps: 12,
                    goalMode,
                    startImmediately: true,
                    origin: 'copilot',
                });
                resolvedRunId = created.id;
            } catch (error) {
                if (error?.code === 'M365_CONVERSATION_HAS_ACTIVE_RUN') {
                    const activeRun = (await this.store.listRuns(conversationId))
                        .find((item) => !TERMINAL_STATUSES.has(item.status));
                    if (activeRun) return this._activePlanConflictResult(activeRun, {
                        resumeFromUser: isSystemFeedback !== true,
                    });
                }
                return this._planRejection(error.code || 'M365_PLAN_CREATE_FAILED', error.message || '無法建立自主計畫。');
            }
        }

        return this._withRunLock(resolvedRunId, async () => {
            let run;
            try {
                run = await this.store.getRun(resolvedRunId);
            } catch (error) {
                return this._planRejection(error.code || 'M365_RUN_NOT_FOUND', error.message || '找不到自主計畫。', { runId: resolvedRunId });
            }
            if (run.conversationId !== conversationId) {
                return this._planRejection('M365_PLAN_CONVERSATION_MISMATCH', '計畫不屬於目前專案對話。', { runId: run.id });
            }
            const latestEvent = await this._latestAutonomousPlan(run.id);
            const latestRevision = Number(latestEvent?.payload?.plan?.revision || 0);
            if (TERMINAL_STATUSES.has(run.status)) {
                if (isSystemFeedback !== true) {
                    return this._terminalPlanRestartResult(run, plan);
                }
                return this._planRejection('M365_PLAN_TERMINAL', '這個計畫已經結束，不能再執行動作。', {
                    runId: run.id,
                    planId: run.id,
                    planRevision: latestRevision,
                    stopRepair: true,
                });
            }
            if (latestRevision > 0) {
                if (plan.planId !== run.id) {
                    return this._planRejection('M365_PLAN_ID_MISMATCH', '後續版本必須沿用宿主指定的 plan_id。', { runId: run.id });
                }
                if (plan.revision !== latestRevision + 1) {
                    return this._planRejection(
                        'M365_PLAN_REVISION_MISMATCH',
                        `版本必須從 ${latestRevision} 遞增為 ${latestRevision + 1}。`,
                        { runId: run.id, planId: run.id, planRevision: latestRevision }
                    );
                }
            } else if (plan.revision !== 1 || plan.planId !== null) {
                return this._planRejection('M365_PLAN_FIRST_REVISION_INVALID', '第一版計畫必須使用 plan_id=null、revision=1。', { runId: run.id });
            }

            if (run.status === 'PAUSED') {
                return this._planRejection('M365_PLAN_PAUSED', '計畫已由使用者暫停。請先按「繼續」。', {
                    runId: run.id,
                    planId: run.id,
                    planRevision: latestRevision,
                });
            }
            if (run.status === 'RECONCILE_REQUIRED') {
                return this._planRejection('M365_PLAN_RECONCILE_REQUIRED', '上一個瀏覽器傳送結果不明，必須先完成核對。', {
                    runId: run.id,
                    planId: run.id,
                    planRevision: latestRevision,
                });
            }
            if (run.status === 'WAITING_APPROVAL') {
                return this._planRejection('M365_PLAN_WAITING_APPROVAL', '計畫正在等待使用者核准。', {
                    runId: run.id,
                    planId: run.id,
                    planRevision: latestRevision,
                });
            }
            if (run.status === 'BLOCKED' && run.errorCode === 'M365_GOAL_NO_PROGRESS' && isSystemFeedback) {
                return this._planRejection('M365_GOAL_NO_PROGRESS', '連續三個工具結果都沒有進展；已保留工作並等待使用者補充或停止。', {
                    runId: run.id,
                    planId: run.id,
                    planRevision: latestRevision,
                    goalMode: true,
                });
            }
            if (run.status === 'WAITING_USER' && isSystemFeedback && plan.status === 'running') {
                return this._planRejection('M365_PLAN_USER_INPUT_REQUIRED', '上一個工具動作被拒絕或計畫正在等待使用者補充，不能自行恢復。', {
                    runId: run.id,
                    planId: run.id,
                    planRevision: latestRevision,
                });
            }

            // Bind folder references only after the run is proven to belong to
            // this conversation and is still eligible for the plan update.
            this.rememberRunLocalFolders(run.id, localFolders);

            const missingAction = actionCount === 0 && (plan.status === 'running'
                || (plan.status === 'blocked' && !String(plan.question || '').trim()));
            if (missingAction && ['RUNNING', 'QUEUED'].includes(run.status)) {
                const previousSteps = await this.store.listRunSteps(run.id);
                const lastStep = previousSteps[previousSteps.length - 1];
                // A missing proposal is safe to repair after a terminal Observation:
                // the host has not received or dispatched any new action to duplicate.
                if (!lastStep || ['completed', 'failed', 'canceled'].includes(lastStep.status)) {
                    const events = await this.store.listRunEvents(run.id);
                    const repairs = events.filter(event => event.eventType === 'autonomous_plan_action_repair').length;
                    if (run.currentStep < run.maxSteps) {
                        const storedPlan = planForStorage(plan, run.id);
                        await this.store.appendRunEvent(run.id, 'autonomous_plan_received', { requestId, plan: storedPlan });
                        if (repairs >= 1) {
                            if (run.status === 'QUEUED') {
                                run = await this.store.transitionRun(run.id, 'RUNNING', {
                                    reason: 'MISSING_ACTION_REPAIR_EXHAUSTED_PREPARE_PAUSE',
                                });
                            }
                            run = await this.store.transitionRun(run.id, 'WAITING_USER', {
                                reason: 'M365_PROTOCOL_REPAIR_EXHAUSTED',
                                errorCode: 'M365_PROTOCOL_REPAIR_EXHAUSTED',
                            });
                            await this.store.appendRunEvent(run.id, 'autonomous_plan_action_repair_exhausted', {
                                revision: plan.revision,
                                attempts: repairs,
                            });
                            return {
                                accepted: false,
                                allowActions: false,
                                planMode: true,
                                runId: run.id,
                                planId: run.id,
                                planRevision: plan.revision,
                                maxActionDepth: run.maxSteps,
                                code: 'M365_PROTOCOL_REPAIR_EXHAUSTED',
                                warning: '⚠️ 自主計畫已暫停：Copilot 連續未提出可執行動作，已停止自動補正避免重複回合。',
                                stopRepair: true,
                            };
                        }
                        await this.store.appendRunEvent(run.id, 'autonomous_plan_action_repair', { revision: plan.revision, attempt: repairs + 1 });
                        if (run.status === 'RUNNING') await this.store.transitionRun(run.id, 'QUEUED', { reason: 'MISSING_ACTION_REPAIR' });
                        this._scheduleAutonomousContinuation(run.id, storedPlan, '', 'MISSING_ACTION_REPAIR');
                        return { accepted: true, allowActions: false, planMode: true, runId: run.id, planId: run.id, planRevision: plan.revision, maxActionDepth: run.maxSteps };
                    }
                }
            }
            const nonRunning = plan.status !== 'running';
            if ((nonRunning && actionCount !== 0) || (!nonRunning && actionCount < 1)) {
                return this._planRejection(
                    'M365_PLAN_ACTION_CARDINALITY_INVALID',
                    nonRunning ? '非執行狀態不能同時提出工具動作。' : '執行中的計畫每輪至少需要提出一個工具動作。',
                    { runId: run.id, planId: run.id, planRevision: latestRevision }
                );
            }
            if (plan.status === 'running' && actions.some((action) => String(action?.action || '').toLowerCase() === 'multi_agent')) {
                return this._planRejection('M365_PLAN_MULTI_AGENT_UNSUPPORTED', '目前自主計畫尚未支援多代理動作的完成回傳，請改用 command、Skill 或 MCP。', {
                    runId: run.id,
                    planId: run.id,
                    planRevision: latestRevision,
                });
            }

            const steps = await this.store.listRunSteps(run.id);
            const activeStep = [...steps].reverse().find((step) => step.status === 'running');
            if (activeStep) {
                return this._planRejection('M365_PLAN_OBSERVATION_PENDING', '上一個工具動作尚未收到宿主 Observation。', {
                    runId: run.id,
                    stepId: activeStep.id,
                    planId: run.id,
                    planRevision: latestRevision,
                });
            }
            if (plan.status === 'running' && run.currentStep >= run.maxSteps) {
                if (run.status === 'RUNNING') {
                    await this.store.transitionRun(run.id, 'BLOCKED', {
                        reason: 'MAX_STEPS_REACHED',
                        errorCode: 'M365_RUN_STEP_LIMIT',
                    });
                }
                return this._planRejection('M365_RUN_STEP_LIMIT', `已達 ${run.maxSteps} 個工具步驟上限。`, {
                    runId: run.id,
                    planId: run.id,
                    planRevision: latestRevision,
                });
            }

            const evidenceEvents = await this.store.listRunEvents(run.id);
            const observedCompletedStepIds = [...new Set(evidenceEvents
                .filter((event) => event.eventType === 'autonomous_observation_recorded'
                    && event.payload?.status === 'succeeded'
                    && String(event.payload?.planStepId || '').trim())
                .map((event) => String(event.payload.planStepId).trim()))];
            const missingCompletedEvidence = observedCompletedStepIds.filter((planStepId) => {
                const step = plan.steps.find((item) => item.id === planStepId);
                return !step || step.status !== 'completed';
            });
            if (latestRevision > 0 && missingCompletedEvidence.length > 0) {
                await this.store.appendRunEvent(run.id, 'autonomous_plan_evidence_history_rejected', {
                    revision: plan.revision,
                    planStepIds: missingCompletedEvidence,
                });
                return this._requestProtocolRepairLocked({
                    runId: run.id,
                    kind: 'completed_evidence_not_preserved',
                    issues: missingCompletedEvidence.map((id) => `completed_step_not_preserved:${id}`),
                });
            }

            // Copilot occasionally reports every evidence-backed step as
            // completed but leaves the plan in wait_user/blocked and asks the
            // user to press Continue. The host already has the authoritative
            // evidence in that case, so close the run instead of spending more
            // turns repairing a purely contradictory status field.
            const allPlanStepsFinished = plan.steps.every((step) => ['completed', 'skipped'].includes(step.status));
            if (plan.status !== 'complete' && allPlanStepsFinished) {
                const hostCompletedPlan = {
                    ...plan,
                    status: 'complete',
                    currentStepId: null,
                    question: '',
                    approvalRequest: '',
                    completionSummary: plan.completionSummary || `已完成：${plan.goal}`,
                };
                const hostCompletion = validatePlanCompletion({
                    plan: hostCompletedPlan,
                    run,
                    events: evidenceEvents,
                    workspaceRoot,
                });
                if (hostCompletion.ok) {
                    await this.store.appendRunEvent(run.id, 'autonomous_plan_host_completed', {
                        revision: plan.revision,
                        reason: 'ALL_EVIDENCE_BACKED_STEPS_FINISHED',
                    });
                    plan = hostCompletedPlan;
                }
            }

            const remainingInSameWaitState = (run.status === 'WAITING_USER' && plan.status === 'wait_user')
                || (run.status === 'BLOCKED' && plan.status === 'blocked');
            if (['WAITING_USER', 'BLOCKED'].includes(run.status) && !remainingInSameWaitState) {
                run = await this.store.transitionRun(run.id, 'QUEUED', { reason: 'COPILOT_PLAN_STATE_UPDATED' });
                run = await this.store.transitionRun(run.id, 'RUNNING', { reason: 'COPILOT_PLAN_STATE_APPLYING' });
            }

            const unverifiedStop = classifyUnverifiedStop(plan, evidenceEvents);
            if (unverifiedStop) {
                await this.store.appendRunEvent(run.id, 'autonomous_plan_stop_rejected', {
                    revision: plan.revision,
                    reason: unverifiedStop,
                });
                return this._requestProtocolRepairLocked({
                    runId: run.id,
                    kind: unverifiedStop,
                });
            }

            if (plan.status === 'complete') {
                const events = evidenceEvents;
                const completion = validatePlanCompletion({ plan, run, events, workspaceRoot });
                if (!completion.ok) {
                    await this.store.appendRunEvent(run.id, 'autonomous_plan_completion_rejected', {
                        revision: plan.revision,
                        issues: completion.issues,
                    });
                    return this._requestProtocolRepairLocked({
                        runId: run.id,
                        kind: 'completion_evidence_missing',
                        issues: completion.issues,
                    });
                }
            }

            const storedPlan = planForStorage(plan, run.id);
            await this.store.appendRunEvent(run.id, 'autonomous_plan_received', {
                requestId,
                plan: storedPlan,
            });

            if (plan.status === 'complete') {
                run = await this.store.transitionRun(run.id, 'COMPLETED', {
                    reason: 'COPILOT_PLAN_COMPLETED',
                });
                this.forgetRunLocalFolders(run.id);
                return { accepted: true, allowActions: false, planMode: true, runId: run.id, planId: run.id, planRevision: plan.revision, maxActionDepth: run.maxSteps };
            }
            if (plan.status === 'blocked') {
                run = await this.store.transitionRun(run.id, 'BLOCKED', {
                    reason: plan.question || 'COPILOT_PLAN_BLOCKED',
                });
                return { accepted: true, allowActions: false, planMode: true, runId: run.id, planId: run.id, planRevision: plan.revision, maxActionDepth: run.maxSteps };
            }
            if (plan.status === 'wait_user') {
                run = await this.store.transitionRun(run.id, 'WAITING_USER', { reason: plan.question });
                return { accepted: true, allowActions: false, planMode: true, runId: run.id, planId: run.id, planRevision: plan.revision, maxActionDepth: run.maxSteps };
            }
            if (plan.status === 'wait_approval') {
                await this.store.createApproval(run.id, {
                    approvalType: 'plan_continue',
                    request: plan.approvalRequest,
                });
                run = await this.store.transitionRun(run.id, 'WAITING_APPROVAL', { reason: plan.approvalRequest });
                return { accepted: true, allowActions: false, planMode: true, runId: run.id, planId: run.id, planRevision: plan.revision, maxActionDepth: run.maxSteps };
            }

            if (['WAITING_USER', 'BLOCKED'].includes(run.status)) {
                run = await this.store.transitionRun(run.id, 'QUEUED', { reason: 'COPILOT_PLAN_RESUMED' });
            }
            if (run.status === 'QUEUED') {
                run = await this.store.transitionRun(run.id, 'RUNNING', { reason: 'COPILOT_PLAN_ACTION_READY' });
            }
            if (run.status !== 'RUNNING') {
                return this._planRejection('M365_PLAN_RUN_STATE_INVALID', `目前狀態 ${run.status} 無法執行下一步。`, {
                    runId: run.id,
                    planId: run.id,
                    planRevision: plan.revision,
                });
            }

            const planStep = plan.steps.find((step) => step.id === plan.currentStepId);
            const runStep = await this.store.createRunStep(run.id, {
                stepNumber: run.currentStep + 1,
                requestId: crypto.randomUUID(),
                prompt: JSON.stringify({ planId: run.id, revision: plan.revision, step: planStep }),
                summary: '',
            });
            await this.store.transitionRun(run.id, 'RUNNING', {
                currentStep: runStep.stepNumber,
                stepId: runStep.id,
                reason: 'COPILOT_PLAN_ACTION_STARTED',
            });
            await this.store.updateRunStep(runStep.id, { status: 'running', summary: '' });
            await this.store.appendRunEvent(run.id, 'autonomous_action_planned', {
                requestId,
                stepId: runStep.id,
                actionId: runStep.requestId,
                planStepId: plan.currentStepId,
                actionCount,
                revision: plan.revision,
                actionDescriptor: describeAction(actions[0]),
                actionDescriptors: actions.map((action) => describeAction(action)),
            });
            return {
                accepted: true,
                allowActions: true,
                planMode: true,
                runId: run.id,
                stepId: runStep.id,
                actionId: runStep.requestId,
                planId: run.id,
                planRevision: plan.revision,
                planStepId: plan.currentStepId,
                maxActionDepth: run.maxSteps,
            };
        });
    }

    async recordAutonomousObservation({
        runId,
        stepId,
        actionId = '',
        planStepId = '',
        lane = 'action',
        status = 'failed',
        result = '',
    }) {
        await this.init();
        if (!runId || !stepId) {
            throw serviceError('M365_PLAN_OBSERVATION_BINDING_REQUIRED', 'Observation is missing its run or step binding.', 409);
        }
        return this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            const steps = await this.store.listRunSteps(runId);
            const step = steps.find((item) => item.id === stepId);
            if (!step) throw serviceError('M365_RUN_STEP_NOT_FOUND', 'Observation step was not found.', 404);
            if (actionId && step.requestId !== actionId) {
                throw serviceError('M365_PLAN_ACTION_ID_MISMATCH', 'Observation does not match the planned action.', 409);
            }
            const latest = await this._latestAutonomousPlan(runId);
            const planRevision = Number(latest?.payload?.plan?.revision || 0);
            if (['completed', 'failed', 'canceled'].includes(step.status)) {
                return { run, step, planId: runId, planRevision, duplicate: true };
            }
            if (step.status !== 'running') {
                throw serviceError('M365_PLAN_OBSERVATION_STATE_INVALID', 'The planned action is not running.', 409);
            }
            const succeeded = status === 'succeeded';
            const denied = status === 'denied';
            const summary = String(result || '').trim().slice(0, 20000)
                || (succeeded ? 'Tool action completed.' : 'Tool action failed.');
            const updatedStep = await this.store.updateRunStep(step.id, {
                status: succeeded ? 'completed' : 'failed',
                summary,
            });
            await this.store.appendRunEvent(runId, 'autonomous_observation_recorded', {
                stepId,
                actionId: step.requestId,
                planStepId,
                lane,
                status: succeeded ? 'succeeded' : (denied ? 'denied' : 'failed'),
                planRevision,
                summary: summary.slice(0, 4000),
            });
            let updatedRun = await this.store.getRun(runId);
            if (!succeeded && !denied && run.goalMode && updatedRun.status === 'RUNNING') {
                const events = await this.store.listRunEvents(runId);
                let consecutiveFailures = 0;
                for (const event of [...events].reverse()) {
                    if (event.eventType !== 'autonomous_observation_recorded') continue;
                    if (event.payload?.status === 'succeeded') break;
                    if (event.payload?.status === 'failed') consecutiveFailures += 1;
                    if (consecutiveFailures >= 3) break;
                }
                if (consecutiveFailures >= 3) {
                    updatedRun = await this.store.transitionRun(runId, 'BLOCKED', {
                        stepId,
                        reason: 'GOAL_MODE_REPEATED_NO_PROGRESS',
                        errorCode: 'M365_GOAL_NO_PROGRESS',
                    });
                    await this.store.appendRunEvent(runId, 'goal_no_progress_paused', {
                        consecutiveFailures,
                        lastSummary: summary.slice(0, 1000),
                    });
                }
            }
            if (denied && updatedRun.status === 'RUNNING') {
                updatedRun = await this.store.transitionRun(runId, 'WAITING_USER', {
                    stepId,
                    reason: 'USER_DENIED_TOOL_ACTION',
                });
            }
            return {
                run: updatedRun,
                step: updatedStep,
                planId: runId,
                planRevision,
                duplicate: false,
            };
        });
    }

    async handleStepResponse({ runId, stepId, responseText, transportFailed = false, transportAmbiguous = false, transportErrorCode = '' }) {
        await this.init();
        return this._withRunLock(runId, async () => {
            let run = await this.store.getRun(runId);
            if (TERMINAL_STATUSES.has(run.status)) return run;
            const steps = await this.store.listRunSteps(runId);
            const step = steps.find((item) => item.id === stepId);
            if (!step || step.status !== 'running') return run;

            if (transportFailed) {
                return this._handleDispatchErrorLocked({
                    runId,
                    stepId,
                    error: { code: transportErrorCode || 'M365_RUN_TRANSPORT_FAILED' },
                    ambiguous: transportAmbiguous,
                });
            }

            const parsed = parseM365RunControl(responseText);
            if (!parsed.ok) {
                await this.store.updateRunStep(step.id, {
                    status: 'waiting',
                    summary: 'M365 returned a response without a valid continuation control block.',
                });
                if (run.status === 'PAUSED') {
                    await this.store.appendRunEvent(runId, 'run_control_invalid', { errorCode: parsed.errorCode, stepId });
                    return this.store.getRun(runId);
                }
                return this.store.transitionRun(runId, 'WAITING_USER', {
                    stepId,
                    reason: 'RUN_CONTROL_INVALID',
                    errorCode: parsed.errorCode,
                });
            }

            const control = parsed.control;
            await this.store.updateRunStep(step.id, {
                status: 'completed',
                summary: control.stepSummary,
            });
            await this.store.appendRunEvent(runId, 'run_control_received', {
                stepId,
                status: control.status,
                evidence: control.evidence,
                question: control.question,
                approvalRequest: control.approvalRequest,
            });
            run = await this.store.getRun(runId);

            if (control.status === 'complete') {
                const completed = await this.store.transitionRun(runId, 'COMPLETED', { stepId, reason: 'COMPLETION_CHECK_SATISFIED' });
                this.forgetRunLocalFolders(runId);
                return completed;
            }
            if (control.status === 'blocked') {
                return this.store.transitionRun(runId, 'BLOCKED', { stepId, reason: control.question || 'MODEL_REPORTED_BLOCKED' });
            }
            if (control.status === 'wait_user') {
                return this.store.transitionRun(runId, 'WAITING_USER', { stepId, reason: control.question });
            }
            if (control.status === 'wait_approval') {
                await this.store.createApproval(runId, {
                    stepId,
                    approvalType: 'run_continue',
                    request: control.approvalRequest,
                });
                return this.store.transitionRun(runId, 'WAITING_APPROVAL', { stepId, reason: control.approvalRequest });
            }

            if (run.status === 'PAUSED') return run;
            if (run.currentStep >= run.maxSteps) {
                return this.store.transitionRun(runId, 'BLOCKED', {
                    stepId,
                    reason: 'MAX_STEPS_REACHED',
                    errorCode: 'M365_RUN_STEP_LIMIT',
                });
            }
            const queuedRun = await this.store.transitionRun(runId, 'QUEUED', { stepId, reason: 'MODEL_REQUESTED_CONTINUATION' });
            const nextStep = await this._prepareNextStep(queuedRun, control.nextPrompt, '');
            this._scheduleStep(runId, nextStep.id);
            return this.store.getRun(runId);
        });
    }
}

async function getM365RunCoordinator(server) {
    if (!server.m365RunCoordinator) server.m365RunCoordinator = new M365RunCoordinator(server);
    await server.m365RunCoordinator.init();
    return server.m365RunCoordinator;
}

module.exports = {
    M365RunCoordinator,
    buildRunStepPrompt,
    getM365RunCoordinator,
};
