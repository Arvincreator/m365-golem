'use strict';

const express = require('express');
const {
    acquireM365DispatchLease,
    activateM365Conversation,
    getM365WorkspaceStore,
    isM365RunnerEnabled,
    isM365WorkspaceEnabled,
    releaseM365DispatchLease,
} = require('../../src/services/M365WorkspaceService');
const { getM365RunCoordinator } = require('../../src/services/M365RunCoordinator');

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

    router.post('/api/projects', async (req, res) => {
        try {
            const store = await getM365WorkspaceStore(server);
            const project = await store.createProject({
                name: req.body.name,
                description: req.body.description,
                instructions: req.body.instructions,
            });
            return res.status(201).json({ success: true, project });
        } catch (error) {
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
            return res.json({ success: true, run, steps, events, approvals, checkpoint });
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

module.exports._private = { sendError, statusForError };
