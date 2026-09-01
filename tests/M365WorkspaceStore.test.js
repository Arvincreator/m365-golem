'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const M365WorkspaceStore = require('../src/managers/M365WorkspaceStore');

function makeKey(byte) {
    return Buffer.alloc(32, byte).toString('base64');
}

describe('M365WorkspaceStore', () => {
    let tempDir;
    let dbPath;
    let store;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-m365-workspace-'));
        dbPath = path.join(tempDir, 'workspace.sqlite');
        store = new M365WorkspaceStore({
            dbPath,
            encryptionKey: makeKey(7),
        });
    });

    afterEach(async () => {
        if (store) await store.close().catch(() => undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('fails closed when the encryption key is missing or invalid', () => {
        expect(() => new M365WorkspaceStore({ dbPath, encryptionKey: '' }))
            .toThrow(expect.objectContaining({ code: 'M365_DATA_KEY_REQUIRED' }));
        expect(() => new M365WorkspaceStore({ dbPath, encryptionKey: 'not-a-32-byte-key' }))
            .toThrow(expect.objectContaining({ code: 'M365_DATA_KEY_INVALID' }));
    });

    test('persists encrypted projects, isolated conversations, and messages across restart', async () => {
        const alpha = await store.createProject({
            name: 'Client Alpha Secret',
            description: 'Alpha accounting engagement',
            instructions: 'Never mix this project with another client.',
        });
        const beta = await store.createProject({ name: 'Client Beta Secret' });
        const alphaConversation = await store.createConversation(alpha.id, { title: 'Alpha VAT review' });
        const betaConversation = await store.createConversation(beta.id, { title: 'Beta payroll review' });

        const userMessage = await store.addMessage(alphaConversation.id, {
            role: 'user',
            source: 'user',
            content: 'ALPHA-PRIVATE-PROMPT',
            requestId: 'request-alpha-1',
            deliveryState: 'dispatch_started',
        });
        await store.updateMessageDeliveryState(userMessage.id, 'confirmed');
        await store.addMessage(alphaConversation.id, {
            role: 'assistant',
            source: 'm365',
            content: 'ALPHA-PRIVATE-RESPONSE',
            requestId: 'request-alpha-1',
            deliveryState: 'response_confirmed',
        });
        await store.addMessage(betaConversation.id, {
            role: 'user',
            source: 'user',
            content: 'BETA-PRIVATE-PROMPT',
            deliveryState: 'local',
        });

        expect(await store.listMessages(alphaConversation.id)).toEqual([
            expect.objectContaining({ content: 'ALPHA-PRIVATE-PROMPT', deliveryState: 'confirmed' }),
            expect.objectContaining({ content: 'ALPHA-PRIVATE-RESPONSE', deliveryState: 'response_confirmed' }),
        ]);
        expect(await store.listMessages(betaConversation.id)).toEqual([
            expect.objectContaining({ content: 'BETA-PRIVATE-PROMPT' }),
        ]);

        await store.close();
        const rawDatabase = fs.readFileSync(dbPath).toString('utf8');
        expect(rawDatabase).not.toContain('Client Alpha Secret');
        expect(rawDatabase).not.toContain('ALPHA-PRIVATE-PROMPT');
        expect(rawDatabase).not.toContain('ALPHA-PRIVATE-RESPONSE');

        store = new M365WorkspaceStore({ dbPath, encryptionKey: makeKey(7) });
        const projects = await store.listProjects();
        expect(projects.map((project) => project.name).sort()).toEqual([
            'Client Alpha Secret',
            'Client Beta Secret',
        ]);
        expect(await store.listMessages(alphaConversation.id)).toHaveLength(2);
    });

    test('authenticates encrypted data and rejects a different key after restart', async () => {
        await store.createProject({ name: 'Protected Project' });
        await store.close();

        store = new M365WorkspaceStore({ dbPath, encryptionKey: makeKey(8) });
        await expect(store.listProjects()).rejects.toMatchObject({ code: 'M365_DATA_DECRYPT_FAILED' });
    });

    test('stores a bound M365 conversation locator without treating it as credentials', async () => {
        const project = await store.createProject({ name: 'M365 Binding' });
        const conversation = await store.createConversation(project.id, { title: 'Bound chat' });
        const bound = await store.setConversationBinding(conversation.id, {
            bindingState: 'bound',
            remoteConversationUrl: 'https://m365.cloud.microsoft/chat/conversation/example-id',
            remoteConversationId: 'example-id',
        });

        expect(bound).toMatchObject({
            bindingState: 'bound',
            remoteConversationUrl: 'https://m365.cloud.microsoft/chat/conversation/example-id',
            remoteConversationId: 'example-id',
        });

        const updatedProject = await store.updateProject(project.id, { instructions: 'Use the revised review rule.' });
        expect(updatedProject.contextVersion).toBe(2);
        expect((await store.getConversation(conversation.id)).projectContextVersion).toBe(1);
        const acknowledged = await store.acknowledgeConversationProjectContext(
            conversation.id,
            updatedProject.contextVersion
        );
        expect(acknowledged.projectContextVersion).toBe(2);
    });

    test('enforces run transitions and writes durable checkpoints and events', async () => {
        const project = await store.createProject({ name: 'Durable Work' });
        const conversation = await store.createConversation(project.id, { title: 'Three-step work' });
        const run = await store.createRun(conversation.id, {
            objective: 'Prepare a review-ready memo.',
            constraints: 'Use only this conversation.',
            verification: 'Return a memo and a self-check.',
            maxSteps: 3,
        });

        expect(run.status).toBe('WAITING_START_APPROVAL');
        await expect(store.transitionRun(run.id, 'RUNNING')).rejects.toMatchObject({
            code: 'M365_RUN_TRANSITION_INVALID',
        });

        await store.transitionRun(run.id, 'QUEUED');
        await store.transitionRun(run.id, 'RUNNING');
        const step = await store.createRunStep(run.id, {
            prompt: 'Step 1 prompt',
            summary: 'Plan the memo',
            requestId: 'run-request-1',
        });
        await store.updateRunStep(step.id, { status: 'running' });
        await store.updateRunStep(step.id, { status: 'completed', summary: 'Plan completed' });
        const completed = await store.transitionRun(run.id, 'COMPLETED', { currentStep: 1, stepId: step.id });

        expect(completed).toMatchObject({ status: 'COMPLETED', currentStep: 1 });
        expect(await store.listRunSteps(run.id)).toEqual([
            expect.objectContaining({ status: 'completed', summary: 'Plan completed' }),
        ]);
        const events = await store.listRunEvents(run.id);
        expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
            'run_created',
            'run_status_changed',
            'step_created',
            'step_status_changed',
        ]));
        expect((await store.getLatestCheckpoint(run.id)).state).toMatchObject({
            status: 'COMPLETED',
            currentStep: 1,
        });
    });

    test('persists approval requests and accepts exactly one decision', async () => {
        const project = await store.createProject({ name: 'Approval Work' });
        const conversation = await store.createConversation(project.id, { title: 'Approval chat' });
        const run = await store.createRun(conversation.id, {
            objective: 'Draft a checklist.',
            verification: 'Checklist has owner and evidence.',
        });
        const approval = await store.createApproval(run.id, {
            approvalType: 'run_start',
            request: 'Start this bounded run?',
        });

        expect(approval.status).toBe('pending');
        const decided = await store.decideApproval(approval.id, {
            status: 'approved',
            decision: 'Approved by the local user.',
        });
        expect(decided).toMatchObject({ status: 'approved', decision: 'Approved by the local user.' });
        await expect(store.decideApproval(approval.id, { status: 'denied' })).rejects.toMatchObject({
            code: 'M365_APPROVAL_ALREADY_DECIDED',
        });
    });

    test('does not archive a project while it contains unfinished work', async () => {
        const project = await store.createProject({ name: 'Open Work' });
        const conversation = await store.createConversation(project.id, { title: 'Open run' });
        await store.createRun(conversation.id, {
            objective: 'Prepare a draft.',
            verification: 'Draft exists.',
        });

        await expect(store.archiveProject(project.id)).rejects.toMatchObject({
            code: 'M365_PROJECT_HAS_ACTIVE_RUN',
        });
        await expect(store.createRun(conversation.id, {
            objective: 'Create a competing run.',
            verification: 'Should not be created.',
        })).rejects.toMatchObject({
            code: 'M365_CONVERSATION_HAS_ACTIVE_RUN',
        });
    });
});
