'use strict';

const crypto = require('crypto');
const {
    getM365WorkspaceStore,
    isM365RunnerEnabled,
    serviceError,
} = require('./M365WorkspaceService');
const { parseM365RunControl } = require('./M365RunControlParser');

const TERMINAL_STATUSES = new Set(['FAILED', 'CANCELED', 'COMPLETED']);

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
        this.readyPromise = null;
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

    async resumeRun(runId, userInput = '') {
        await this.init();
        return this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (!['PAUSED', 'WAITING_USER', 'BLOCKED'].includes(run.status)) {
                throw serviceError('M365_RUN_RESUME_INVALID', 'This run cannot be resumed from its current state.', 409);
            }
            const input = String(userInput || '').trim();
            if (['WAITING_USER', 'BLOCKED'].includes(run.status) && !input) {
                throw serviceError('M365_RUN_INPUT_REQUIRED', 'Add the requested clarification before continuing.', 400);
            }
            const steps = await this.store.listRunSteps(runId);
            const latest = steps[steps.length - 1] || null;
            if (latest?.status === 'running') {
                throw serviceError('M365_RUN_STEP_IN_FLIGHT', 'The current M365 browser step is still finishing.', 409);
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

    async cancelRun(runId) {
        await this.init();
        return this._withRunLock(runId, async () => {
            const run = await this.store.getRun(runId);
            if (TERMINAL_STATUSES.has(run.status)) return run;
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
            return this.store.transitionRun(runId, 'CANCELED', {
                stepId: activeStep?.id || null,
                reason: 'USER_CANCELED',
            });
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
                return this.store.transitionRun(runId, 'CANCELED', { reason: 'USER_ABANDONED_RECONCILIATION' });
            }
            if (resolution === 'completed') {
                await this.store.setConversationBindingState(conversation.id, restoredBindingState);
                return this.store.transitionRun(runId, 'COMPLETED', { reason: 'USER_VERIFIED_COMPLETION' });
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
        const preDispatch = new Set([
            'M365_HUMAN_LOGIN_REQUIRED',
            'M365_TENANT_BLOCKED',
            'M365_UI_NOT_READY',
            'M365_UI_BUSY',
            'M365_UNEXPECTED_HOST',
            'M365_INSECURE_URL',
            'BROWSER_PROFILE_IN_USE',
        ]).has(code) && !ambiguous;
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
                return this.store.transitionRun(runId, 'COMPLETED', { stepId, reason: 'COMPLETION_CHECK_SATISFIED' });
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
