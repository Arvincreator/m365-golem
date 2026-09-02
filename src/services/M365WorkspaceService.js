'use strict';

const crypto = require('crypto');
const path = require('path');
const ConfigManager = require('../config');
const M365WorkspaceStore = require('../managers/M365WorkspaceStore');
const M365ProjectWorkspaceService = require('./M365ProjectWorkspaceService');

function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    return String(raw).trim().toLowerCase() === 'true';
}

function isM365WorkspaceEnabled() {
    return ConfigManager.CONFIG.GOLEM_BACKEND === 'm365-web'
        && envFlag('M365_WORKSPACE_ENABLED', false);
}

function isM365RunnerEnabled() {
    return isM365WorkspaceEnabled() && envFlag('M365_RUNNER_ENABLED', false);
}

function serviceError(code, message, statusCode = 400, details = null) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    if (details) error.details = details;
    return error;
}

async function getM365WorkspaceStore(server) {
    if (!isM365WorkspaceEnabled()) {
        throw serviceError(
            'M365_WORKSPACE_DISABLED',
            'M365 project and conversation persistence is disabled.',
            409
        );
    }

    if (!server.m365WorkspaceStore) {
        const configuredPath = String(process.env.M365_WORKSPACE_DB_PATH || '').trim();
        const dbPath = configuredPath
            ? path.resolve(configuredPath)
            : path.resolve(process.cwd(), 'data', 'm365-workspace.sqlite');
        server.m365WorkspaceStore = new M365WorkspaceStore({
            dbPath,
            encryptionKey: process.env.M365_DATA_ENCRYPTION_KEY,
        });
        server.m365WorkspaceStoreReady = server.m365WorkspaceStore.init().catch((error) => {
            server.m365WorkspaceStore = null;
            server.m365WorkspaceStoreReady = null;
            throw error;
        });
    }

    await server.m365WorkspaceStoreReady;
    return server.m365WorkspaceStore;
}

function getM365ProjectWorkspaceService(server) {
    if (!isM365WorkspaceEnabled()) {
        throw serviceError(
            'M365_WORKSPACE_DISABLED',
            'M365 project and conversation persistence is disabled.',
            409
        );
    }
    if (!server.m365ProjectWorkspaceService) {
        const configuredRoot = String(process.env.M365_PROJECTS_ROOT || '').trim();
        server.m365ProjectWorkspaceService = new M365ProjectWorkspaceService({
            rootDir: configuredRoot
                ? path.resolve(configuredRoot)
                : path.resolve(process.cwd(), 'data', 'm365-projects'),
        });
    }
    return server.m365ProjectWorkspaceService;
}

function resolveM365Brain(golemId) {
    const index = require('../../index.js');
    const instance = typeof index.getOrCreateGolem === 'function'
        ? index.getOrCreateGolem(golemId || 'golem_A')
        : null;
    const brain = instance && instance.brain;
    if (!brain || typeof brain.activateM365Conversation !== 'function') {
        throw serviceError(
            'M365_RUNTIME_NOT_READY',
            'The M365 browser runtime is not ready yet.',
            503
        );
    }
    return brain;
}

async function activateM365Conversation(golemId, conversation) {
    if (!conversation || conversation.status !== 'active') {
        throw serviceError('M365_CONVERSATION_ARCHIVED', 'The selected conversation is not active.', 409);
    }
    if (conversation.bindingState === 'reconcile_required') {
        throw serviceError(
            'M365_RECONCILIATION_REQUIRED',
            'This conversation has an ambiguous prior dispatch and must be reconciled before another message is sent.',
            409
        );
    }
    if (conversation.bindingState === 'broken') {
        throw serviceError(
            'M365_CONVERSATION_BINDING_BROKEN',
            'This conversation binding is marked broken and must be repaired before use.',
            409
        );
    }

    const brain = resolveM365Brain(golemId);
    const snapshot = await brain.activateM365Conversation(
        conversation.bindingState === 'bound' ? conversation.remoteConversationUrl : null,
        { requireNew: conversation.bindingState === 'unbound' }
    );
    if (conversation.bindingState === 'bound'
        && snapshot.conversationId !== conversation.remoteConversationId) {
        throw serviceError(
            'M365_CONVERSATION_MISMATCH',
            'The visible M365 conversation does not match the selected local conversation.',
            409,
            {
                expectedConversationId: conversation.remoteConversationId,
                actualConversationId: snapshot.conversationId,
            }
        );
    }
    return snapshot;
}

async function captureM365ConversationBinding(store, golemId, conversation) {
    const brain = resolveM365Brain(golemId);
    const snapshot = brain.getM365ConversationSnapshot();
    if (snapshot.status !== 'expected_host' || !snapshot.isConversation || !snapshot.conversationId) {
        throw serviceError(
            'M365_CONVERSATION_BINDING_PENDING',
            'M365 accepted the turn, but a stable conversation URL is not available yet.',
            409
        );
    }

    if (conversation.bindingState === 'bound'
        && snapshot.conversationId !== conversation.remoteConversationId) {
        throw serviceError(
            'M365_CONVERSATION_MISMATCH',
            'The active M365 conversation changed while the message was being processed.',
            409,
            {
                expectedConversationId: conversation.remoteConversationId,
                actualConversationId: snapshot.conversationId,
            }
        );
    }

    if (conversation.bindingState !== 'bound') {
        return store.setConversationBinding(conversation.id, {
            bindingState: 'bound',
            remoteConversationUrl: snapshot.url,
            remoteConversationId: snapshot.conversationId,
        });
    }
    return conversation;
}

function acquireM365DispatchLease(server, input = {}) {
    const current = server.m365DispatchLease;
    if (current) {
        throw serviceError(
            'M365_UI_BUSY',
            'Another M365 conversation is currently using the visible Edge window. Wait for it to finish.',
            409,
            {
                conversationId: current.conversationId,
                acquiredAt: current.acquiredAt,
            }
        );
    }
    const lease = {
        token: crypto.randomUUID(),
        projectId: input.projectId || null,
        conversationId: input.conversationId || null,
        requestId: input.requestId || null,
        acquiredAt: new Date().toISOString(),
    };
    server.m365DispatchLease = lease;
    return lease;
}

function releaseM365DispatchLease(server, token) {
    if (!server.m365DispatchLease) return false;
    if (server.m365DispatchLease.token !== token) return false;
    server.m365DispatchLease = null;
    return true;
}

async function markConversationReconcileRequired(store, conversationId) {
    return store.setConversationBindingState(conversationId, 'reconcile_required');
}

module.exports = {
    acquireM365DispatchLease,
    activateM365Conversation,
    captureM365ConversationBinding,
    getM365ProjectWorkspaceService,
    getM365WorkspaceStore,
    isM365RunnerEnabled,
    isM365WorkspaceEnabled,
    markConversationReconcileRequired,
    releaseM365DispatchLease,
    resolveM365Brain,
    serviceError,
};
