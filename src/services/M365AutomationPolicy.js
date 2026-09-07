'use strict';

const SecurityManager = require('../../packages/security/SecurityManager');
const {
    getAutomationModePreset,
    inferAutomationMode,
    isFullAutoMode,
} = require('../config/AutomationModes');

function normalizeActionName(value) {
    return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function extractCommand(action) {
    if (!action || typeof action !== 'object') return '';
    return String(
        action.cmd ||
        action.parameter ||
        action.command ||
        action.parameters?.command ||
        action.parameters?.cmd ||
        action.parameters?.parameter ||
        ''
    ).trim();
}

function mayAutoApproveM365Actions(actions) {
    const env = process.env;
    const mode = inferAutomationMode(env);
    if (isFullAutoMode(mode)) return true;
    const hostReadOnlyInspection = Array.isArray(actions) && actions.length > 0 && actions.every((action) => {
        if (normalizeActionName(action?.action) !== 'command') return false;
        return /^golem[-_](?:check|memory)(?:\s|$)/i.test(extractCommand(action));
    });
    if (hostReadOnlyInspection) return true;
    if (mode !== 'balanced' || !Array.isArray(actions) || actions.length === 0) return false;

    const presetLevel = Number(getAutomationModePreset(mode)?.AUTONOMY_LEVEL || 0);
    const configuredLevel = Number(env.AUTONOMY_LEVEL);
    const allowedLevel = Number.isFinite(configuredLevel) ? configuredLevel : presetLevel;
    const security = new SecurityManager();

    return actions.every((action) => {
        if (normalizeActionName(action?.action) !== 'command') return false;
        const command = extractCommand(action);
        if (!command) return false;
        return security.assess(command).level === 'SAFE'
            && security.evaluateCommandLevel(command) <= allowedLevel;
    });
}

module.exports = {
    mayAutoApproveM365Actions,
};
