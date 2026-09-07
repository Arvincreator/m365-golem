'use strict';

const AUTOMATION_MODE_PRESETS = Object.freeze({
    guided: Object.freeze({
        GOLEM_AUTO_APPROVE_ALL: 'false',
        GOLEM_SILENT_AUTO_APPROVE: 'false',
        GOLEM_TRUST_SYSTEM_COMMANDS: 'false',
        GOLEM_STRICT_SAFEGUARD: 'true',
        GOLEM_MAX_AUTO_TURNS: '1',
        GOLEM_INTERVENTION_LEVEL: 'CONSERVATIVE',
        AUTONOMY_LEVEL: '0',
    }),
    balanced: Object.freeze({
        GOLEM_AUTO_APPROVE_ALL: 'false',
        GOLEM_SILENT_AUTO_APPROVE: 'false',
        GOLEM_TRUST_SYSTEM_COMMANDS: 'true',
        GOLEM_STRICT_SAFEGUARD: 'true',
        GOLEM_MAX_AUTO_TURNS: '2',
        GOLEM_INTERVENTION_LEVEL: 'NORMAL',
        AUTONOMY_LEVEL: '1',
    }),
    autopilot: Object.freeze({
        GOLEM_AUTO_APPROVE_ALL: 'true',
        GOLEM_SILENT_AUTO_APPROVE: 'false',
        GOLEM_TRUST_SYSTEM_COMMANDS: 'true',
        GOLEM_STRICT_SAFEGUARD: 'true',
        GOLEM_MAX_AUTO_TURNS: '4',
        GOLEM_INTERVENTION_LEVEL: 'NORMAL',
        AUTONOMY_LEVEL: '2',
    }),
    silent: Object.freeze({
        GOLEM_AUTO_APPROVE_ALL: 'true',
        GOLEM_SILENT_AUTO_APPROVE: 'true',
        GOLEM_TRUST_SYSTEM_COMMANDS: 'true',
        GOLEM_STRICT_SAFEGUARD: 'true',
        GOLEM_MAX_AUTO_TURNS: '4',
        GOLEM_INTERVENTION_LEVEL: 'PROACTIVE',
        AUTONOMY_LEVEL: '3',
    }),
});

const AUTOMATION_MODE_IDS = Object.freeze(Object.keys(AUTOMATION_MODE_PRESETS));

function isEnabled(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function inferAutomationMode(env = process.env) {
    const autoApprove = isEnabled(env.GOLEM_AUTO_APPROVE_ALL);
    const silent = isEnabled(env.GOLEM_SILENT_AUTO_APPROVE);
    const trustLibrary = isEnabled(env.GOLEM_TRUST_SYSTEM_COMMANDS);
    const maxTurns = Number(env.GOLEM_MAX_AUTO_TURNS || 5);

    if (autoApprove && silent) return 'silent';
    if (autoApprove) return 'autopilot';
    if (trustLibrary && maxTurns >= 2) return 'balanced';
    return 'guided';
}

function normalizeAutomationMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (AUTOMATION_MODE_IDS.includes(mode)) return mode;
    if (mode === 'manual' || mode === 'lockdown') return 'guided';
    if (mode === 'auto') return 'autopilot';
    return null;
}

function getAutomationModePreset(value) {
    const mode = normalizeAutomationMode(value);
    if (!mode) return null;
    return { ...AUTOMATION_MODE_PRESETS[mode] };
}

function isFullAutoMode(value) {
    const mode = normalizeAutomationMode(value);
    return mode === 'autopilot' || mode === 'silent';
}

module.exports = {
    AUTOMATION_MODE_IDS,
    AUTOMATION_MODE_PRESETS,
    getAutomationModePreset,
    inferAutomationMode,
    isFullAutoMode,
    normalizeAutomationMode,
};
