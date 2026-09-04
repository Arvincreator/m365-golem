'use strict';

const crypto = require('crypto');
const express = require('express');
const LocalWorkspacePicker = require('../../src/services/LocalWorkspacePicker');
const { getM365AttachmentService } = require('../../src/services/M365AttachmentService');
const {
    acquireM365DispatchLease,
    activateM365Conversation,
    getM365ProjectWorkspaceService,
    getM365WorkspaceStore,
    isM365RunnerEnabled,
    isM365WorkspaceEnabled,
    releaseM365DispatchLease,
} = require('../../src/services/M365WorkspaceService');
const { getM365RunCoordinator } = require('../../src/services/M365RunCoordinator');
const { getClientIp, isLocalIp } = require('../server/security');

const LOCAL_BROWSER_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_BROWSER_PORTS = new Set(['3000', '3001']);

function isLocalBrowserRequest(req) {
    if (!isLocalIp(getClientIp(req))) return false;
    const source = String(req.headers.origin || req.headers.referer || '').trim();
    if (!source) return false;
    try {
        const url = new URL(source);
        return ['http:', 'https:'].includes(url.protocol)
            && LOCAL_BROWSER_HOSTS.has(url.hostname)
            && LOCAL_BROWSER_PORTS.has(url.port);
    } catch (_) {
        return false;
    }
}

function statusForError(error) {
    if (Number.isInteger(error && error.statusCode)) return error.statusCode;
    const code = String(error && error.code || '');
    if (code.endsWith('_NOT_FOUND')) return 404;
    if (code.includes('ARCHIVED') || code.includes('ACTIVE_RUN') || code.includes('TRANSITION')) return 409;
    if (code === 'M365_DATA_KEY_REQUIRED' || code === 'M365_DATA_KEY_INVALID') return 503;
    if (code === 'M365_DATA_DECRYPT_FAILED') return 500;
    if (code.startsWith('M365_VALIDATION') || code.includes('_INVALID')) return 400;
    return 500;
}

function sendError(res, error) {
    const status = statusForError(error);
    return res.status(status).json({
        success: false,
        error: String(error && error.code || 'M365_WORKSPACE_ERROR'),
        message: status >= 500 && !String(error && error.code || '').startsWith('M365_')
            ? 'M365 workspace is temporarily unavailable.'
            : String(error && error.message || 'M365 workspace request failed.'),
    });
}

module.exports = function registerM365WorkspaceRoutes(server) {
    const router = express.Router();

    router.get('/api/m365/workspace/status', async (req, res) => {
        const enabled = isM365WorkspaceEnabled();
        if (!enabled) {
            return res.json({
                success: true,
                workspace: {
                    enabled: false,
                    runnerEnabled: false,
                    encryptionConfigured: false,
                    activeDispatch: false,
                },
            });
        }
        try {
            await getM365WorkspaceStore(server);
            return res.json({
                success: true,
                workspace: {
                    enabled: true,
                    runnerEnabled: isM365RunnerEnabled(),
                    encryptionConfigured: !!String(process.env.M365_DATA_ENCRYPTION_KEY || '').trim(),
                    activeDispatch: !!server.m365DispatchLease,
                },
            });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.get('/api/projects', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const projects = await store.listProjects({ includeArchived: req.query.includeArchived === 'true' });
            return res.json({ success: true, projects });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/m365/workspace/pick-folder', async (req, res) => {
        if (!isLocalBrowserRequest(req)) {
            return res.status(403).json({
                success: false,
                error: 'M365_FOLDER_PICKER_LOCAL_ONLY',
                message: 'The folder picker can only be opened from the local M365 Golem interface.',
            });
        }
        try {
            if (!server.localWorkspacePicker) server.localWorkspacePicker = new LocalWorkspacePicker();
            const result = await server.localWorkspacePicker.selectFolder({
                description: req.body && req.body.description,
                initialPath: req.body && req.body.initialPath,
            });
            return res.json({ success: true, ...result });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/m365/attachments/batches', async (req, res) => {
        if (!isLocalBrowserRequest(req)) {
            return res.status(403).json({
                success: false,
                error: 'M365_ATTACHMENT_LOCAL_ONLY',
                message: 'Attachments can only be staged from the local M365 Golem interface.',
            });
        }
        try {
            const projectId = String(req.body && req.body.projectId || '').trim();
            const conversationId = String(req.body && req.body.conversationId || '').trim();
            const store = await getM365WorkspaceStore(server);
            const conversation = await store.getConversation(conversationId);
            if (conversation.projectId !== projectId) {
                const error = new Error('The selected conversation does not belong to the selected project.');
                error.code = 'M365_PROJECT_CONVERSATION_MISMATCH';
                error.statusCode = 409;
                throw error;
            }
            const batch = getM365AttachmentService(server).createBatch({ projectId, conversationId });
            return res.status(201).json({ success: true, ...batch });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/m365/attachments/batches/:batchId/files', async (req, res) => {
        if (!isLocalBrowserRequest(req)) {
            return res.status(403).json({
                success: false,
                error: 'M365_ATTACHMENT_LOCAL_ONLY',
                message: 'Attachments can only be staged from the local M365 Golem interface.',
            });
        }
        try {
            const projectId = String(req.body && req.body.projectId || '').trim();
            const conversationId = String(req.body && req.body.conversationId || '').trim();
            const store = await getM365WorkspaceStore(server);
            const conversation = await store.getConversation(conversationId);
            if (conversation.projectId !== projectId) {
                const error = new Error('The selected conversation does not belong to the selected project.');
                error.code = 'M365_PROJECT_CONVERSATION_MISMATCH';
                error.statusCode = 409;
                throw error;
            }
            const staged = getM365AttachmentService(server).stageFile(
                req.params.batchId,
                { projectId, conversationId },
                {
                    fileName: req.body && req.body.fileName,
                    base64Data: req.body && req.body.base64Data,
                }
            );
            return res.status(201).json({ success: true, ...staged });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/m365/attachments/batches/:batchId/cancel', async (req, res) => {
        if (!isLocalBrowserRequest(req)) {
            return res.status(403).json({
                success: false,
                error: 'M365_ATTACHMENT_LOCAL_ONLY',
                message: 'Attachments can only be removed from the local M365 Golem interface.',
            });
        }
        try {
            const projectId = String(req.body && req.body.projectId || '').trim();
            const conversationId = String(req.body && req.body.conversationId || '').trim();
            const removed = getM365AttachmentService(server).cleanupBatch(
                req.params.batchId,
                { projectId, conversationId }
            );
            return res.json({ success: true, removed });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/projects', async (req, res) => {
        let project = null;
        try {
            const store = await getM365WorkspaceStore(server);
            const workspaceService = getM365ProjectWorkspaceService(server);
            const input = req.body || {};
            const projectId = crypto.randomUUID();
            const workspacePlan = workspaceService.planProjectWorkspace(projectId, {
                workspaceMode: input.workspaceMode,
                workspacePath: input.workspacePath,
                workspaceFolderName: input.workspaceFolderName,
                projectName: input.name,
            });
            project = await store.createProject({
                id: projectId,
                name: input.name,
                description: input.description,
                instructions: input.instructions,
                workspaceMode: workspacePlan.mode,
                workspacePath: workspacePlan.workspacePathForStorage,
            });
            const workspace = workspaceService.ensureProject(project.id, {
                workspacePath: workspacePlan.workspacePathForStorage,
                createWorkspaceRoot: !workspacePlan.rootExisted,
            });
            return res.status(201).json({ success: true, project, workspace });
        } catch (error) {
            if (project) {
                try {
                    const store = await getM365WorkspaceStore(server);
                    await store.removeProjectAfterFailedCreation(project.id);
                } catch (rollbackError) {
                    console.error(`[M365 Workspace] Failed to roll back project ${project.id}:`, rollbackError);
                }
            }
            return sendError(res, error);
        }
    });

    router.get('/api/projects/:projectId', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const project = await store.getProject(req.params.projectId);
            return res.json({ success: true, project });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.patch('/api/projects/:projectId', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const project = await store.updateProject(req.params.projectId, req.body || {});
            return res.json({ success: true, project });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.get('/api/projects/:projectId/workspace', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const project = await store.getProject(req.params.projectId);
            const workspace = getM365ProjectWorkspaceService(server).ensureProject(project.id, {
                workspacePath: project.workspacePath,
            });
            return res.json({ success: true, workspace });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.put('/api/projects/:projectId/agents', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const project = await store.getProject(req.params.projectId);
            const workspace = getM365ProjectWorkspaceService(server).writeAgents(
                project.id,
                req.body && req.body.content
            );
            const updatedProject = await store.bumpProjectContextVersion(project.id);
            return res.json({ success: true, project: updatedProject, workspace });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/projects/:projectId/archive', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const project = await store.archiveProject(req.params.projectId);
            return res.json({ success: true, project });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.get('/api/projects/:projectId/conversations', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const conversations = await store.listConversations(req.params.projectId, {
                includeArchived: req.query.includeArchived === 'true',
            });
            return res.json({ success: true, conversations });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/projects/:projectId/conversations', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const conversation = await store.createConversation(req.params.projectId, {
                title: req.body.title,
            });
            return res.status(201).json({ success: true, conversation });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.get('/api/conversations/:conversationId', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const conversation = await store.getConversation(req.params.conversationId);
            return res.json({ success: true, conversation });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.patch('/api/conversations/:conversationId', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const conversation = await store.updateConversationTitle(
                req.params.conversationId,
                req.body.title
            );
            return res.json({ success: true, conversation });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/conversations/:conversationId/archive', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const conversation = await store.archiveConversation(req.params.conversationId);
            return res.json({ success: true, conversation });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.get('/api/conversations/:conversationId/messages', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const messages = await store.listMessages(req.params.conversationId, { limit: req.query.limit });
            return res.json({ success: true, messages });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/conversations/:conversationId/activate', async (req, res) => {
        let lease = null;
        try {
            const store = await getM365WorkspaceStore(server);
            const conversation = await store.getConversation(req.params.conversationId);
            lease = acquireM365DispatchLease(server, {
                projectId: conversation.projectId,
                conversationId: conversation.id,
                requestId: `activate:${conversation.id}`,
            });
            const snapshot = await activateM365Conversation(req.body.golemId || 'golem_A', conversation);
            return res.json({
                success: true,
                conversation,
                browser: {
                    ready: snapshot.status === 'expected_host',
                    bound: snapshot.isConversation,
                },
            });
        } catch (error) {
            return sendError(res, error);
        } finally {
            if (lease) releaseM365DispatchLease(server, lease.token);
        }
    });

    router.post('/api/conversations/:conversationId/reconcile', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const conversation = await store.getConversation(req.params.conversationId);
            if (conversation.bindingState !== 'reconcile_required') {
                return res.status(409).json({
                    success: false,
                    error: 'M365_RECONCILIATION_NOT_REQUIRED',
                    message: 'This conversation does not require reconciliation.',
                });
            }
            const resolution = String(req.body.resolution || '').toLowerCase();
            if (!['not_sent', 'sent', 'broken'].includes(resolution)) {
                return res.status(400).json({
                    success: false,
                    error: 'M365_RECONCILIATION_RESOLUTION_INVALID',
                    message: 'Choose not_sent, sent, or broken after checking the visible Edge conversation.',
                });
            }
            const bindingState = resolution === 'broken'
                ? 'broken'
                : (conversation.remoteConversationUrl && conversation.remoteConversationId ? 'bound' : 'unbound');
            const updated = await store.setConversationBindingState(conversation.id, bindingState);
            await store.addMessage(conversation.id, {
                role: 'system',
                source: 'system',
                content: resolution === 'not_sent'
                    ? '人工核對：已在 Edge 確認上一則未送出，可由使用者決定是否重新傳送。'
                    : resolution === 'sent'
                        ? '人工核對：已在 Edge 確認上一則已送出，系統沒有自動重送。'
                        : '人工核對：M365 對話連結已標記為失效，需要另行修復。',
                deliveryState: 'local',
            });
            return res.json({ success: true, conversation: updated });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.get('/api/conversations/:conversationId/runs', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const runs = await store.listRuns(req.params.conversationId);
            return res.json({ success: true, runs });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/conversations/:conversationId/runs', async (req, res) => {
        try {
            if (!isM365RunnerEnabled()) {
                return res.status(409).json({
                    success: false,
                    error: 'M365_RUNNER_DISABLED',
                    message: 'M365 multi-step runs are disabled.',
                });
            }
            const store = await getM365WorkspaceStore(server);
            const run = await store.createRun(req.params.conversationId, {
                objective: req.body.objective,
                constraints: req.body.constraints,
                verification: req.body.verification,
                maxSteps: req.body.maxSteps,
            });
            const approval = await store.createApproval(run.id, {
                approvalType: 'run_start',
                request: 'Start this bounded M365 Web run?',
            });
            return res.status(201).json({ success: true, run, approval });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.get('/api/runs/:runId', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const [run, steps, events, approvals, checkpoint] = await Promise.all([
                store.getRun(req.params.runId),
                store.listRunSteps(req.params.runId),
                store.listRunEvents(req.params.runId),
                store.listApprovals(req.params.runId),
                store.getLatestCheckpoint(req.params.runId),
            ]);
            const latestPlanEvent = [...events].reverse().find((event) => event.eventType === 'autonomous_plan_received');
            const createdEvent = events.find((event) => event.eventType === 'run_created');
            return res.json({
                success: true,
                run,
                steps,
                events,
                approvals,
                checkpoint,
                plan: latestPlanEvent?.payload?.plan || null,
                origin: createdEvent?.payload?.origin || 'user',
            });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/runs/:runId/start', async (req, res) => {
        try {
            const coordinator = await getM365RunCoordinator(server);
            const run = await coordinator.startRun(req.params.runId);
            return res.json({ success: true, run });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/runs/:runId/pause', async (req, res) => {
        try {
            const coordinator = await getM365RunCoordinator(server);
            const run = await coordinator.pauseRun(req.params.runId);
            return res.json({ success: true, run });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/runs/:runId/resume', async (req, res) => {
        try {
            const coordinator = await getM365RunCoordinator(server);
            const run = await coordinator.resumeRun(req.params.runId, req.body.input || '');
            return res.json({ success: true, run });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/runs/:runId/input', async (req, res) => {
        try {
            const coordinator = await getM365RunCoordinator(server);
            const run = await coordinator.resumeRun(req.params.runId, req.body.input || '');
            return res.json({ success: true, run });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/runs/:runId/cancel', async (req, res) => {
        try {
            const coordinator = await getM365RunCoordinator(server);
            const run = await coordinator.cancelRun(req.params.runId);
            return res.json({ success: true, run });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/runs/:runId/complete', async (req, res) => {
        try {
            const coordinator = await getM365RunCoordinator(server);
            const run = await coordinator.completeRun(req.params.runId, req.body || {});
            return res.json({ success: true, run });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/runs/:runId/reconcile', async (req, res) => {
        try {
            const coordinator = await getM365RunCoordinator(server);
            const run = await coordinator.reconcileRun(req.params.runId, req.body || {});
            return res.json({ success: true, run });
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post('/api/approvals/:approvalId/decision', async (req, res) => {
        try {
            const coordinator = await getM365RunCoordinator(server);
            const run = await coordinator.decideApproval(req.params.approvalId, req.body || {});
            return res.json({ success: true, run });
        } catch (error) {
            return sendError(res, error);
        }
    });

    return router;
};

module.exports._private = { isLocalBrowserRequest, sendError, statusForError };
