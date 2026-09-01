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
        if (store) await store.close().catch(() => undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
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
});
