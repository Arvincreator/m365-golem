'use strict';

const {
    extractJsonPayloadFromRenderedCode,
    stripSequentialRenderedLineNumbers,
} = require('../utils/M365RenderedCode');

const PLAN_SCHEMA_VERSION = 'golem_plan/1';
const PLAN_STATUSES = new Set(['running', 'wait_user', 'wait_approval', 'complete', 'blocked']);
const STEP_STATUSES = new Set(['pending', 'in_progress', 'completed', 'blocked', 'skipped']);
const MAX_PLAN_STEPS = 12;

function result(ok, plan = null, errorCode = '', message = '') {
    return { present: true, ok, plan, errorCode, message };
}

function boundedText(value, field, { required = false, max = 20000 } = {}) {
    if (value === null || value === undefined) value = '';
    if (typeof value !== 'string') {
        throw Object.assign(new Error(`${field} must be a string.`), { code: 'M365_PLAN_FIELD_INVALID' });
    }
    const text = value.trim();
    if (required && !text) {
        throw Object.assign(new Error(`${field} is required.`), { code: 'M365_PLAN_FIELD_REQUIRED' });
    }
    if (text.length > max) {
        throw Object.assign(new Error(`${field} is too long.`), { code: 'M365_PLAN_FIELD_TOO_LONG' });
    }
    return text;
}

function rejectUnknownKeys(value, allowed, field) {
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        throw Object.assign(new Error(`${field} contains unsupported fields: ${unknown.join(', ')}.`), {
            code: 'M365_PLAN_SCHEMA_INVALID',
        });
    }
}

function normalizeStep(step, index) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw Object.assign(new Error(`steps[${index}] must be an object.`), { code: 'M365_PLAN_STEP_INVALID' });
    }
    rejectUnknownKeys(step, new Set(['id', 'title', 'status', 'done_when']), `steps[${index}]`);
    const id = boundedText(step.id, `steps[${index}].id`, { required: true, max: 80 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
        throw Object.assign(new Error(`steps[${index}].id has an invalid format.`), { code: 'M365_PLAN_STEP_ID_INVALID' });
    }
    const status = boundedText(step.status, `steps[${index}].status`, { required: true, max: 32 }).toLowerCase();
    if (!STEP_STATUSES.has(status)) {
        throw Object.assign(new Error(`steps[${index}].status is invalid.`), { code: 'M365_PLAN_STEP_STATUS_INVALID' });
    }
    return {
        id,
        title: boundedText(step.title, `steps[${index}].title`, { required: true, max: 500 }),
        status,
        doneWhen: boundedText(step.done_when, `steps[${index}].done_when`, { required: true, max: 2000 }),
    };
}

function normalizePlan(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw Object.assign(new Error('GOLEM_PLAN must contain one JSON object.'), { code: 'M365_PLAN_OBJECT_REQUIRED' });
    }
    rejectUnknownKeys(value, new Set([
        'schema_version', 'plan_id', 'revision', 'goal', 'completion_criteria',
        'status', 'current_step_id', 'steps', 'question', 'approval_request',
        'completion_summary',
    ]), 'GOLEM_PLAN');

    if (value.schema_version !== PLAN_SCHEMA_VERSION) {
        throw Object.assign(new Error(`schema_version must be ${PLAN_SCHEMA_VERSION}.`), { code: 'M365_PLAN_SCHEMA_VERSION_INVALID' });
    }
    const planId = value.plan_id === null
        ? null
        : boundedText(value.plan_id, 'plan_id', { required: true, max: 128 });
    if (planId && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId)) {
        throw Object.assign(new Error('plan_id has an invalid format.'), { code: 'M365_PLAN_ID_INVALID' });
    }
    const revision = Number(value.revision);
    if (!Number.isInteger(revision) || revision < 1 || revision > 1000) {
        throw Object.assign(new Error('revision must be an integer from 1 to 1000.'), { code: 'M365_PLAN_REVISION_INVALID' });
    }
    const status = boundedText(value.status, 'status', { required: true, max: 32 }).toLowerCase();
    if (!PLAN_STATUSES.has(status)) {
        throw Object.assign(new Error('status is invalid.'), { code: 'M365_PLAN_STATUS_INVALID' });
    }
    if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_PLAN_STEPS) {
        throw Object.assign(new Error(`steps must contain 1 to ${MAX_PLAN_STEPS} entries.`), { code: 'M365_PLAN_STEPS_INVALID' });
    }
    const steps = value.steps.map(normalizeStep);
    if (new Set(steps.map((step) => step.id)).size !== steps.length) {
        throw Object.assign(new Error('Step ids must be unique.'), { code: 'M365_PLAN_STEP_ID_DUPLICATE' });
    }

    const currentStepId = boundedText(value.current_step_id, 'current_step_id', { max: 80 });
    const inProgress = steps.filter((step) => step.status === 'in_progress');
    if (status === 'running') {
        if (inProgress.length !== 1 || !currentStepId || inProgress[0].id !== currentStepId) {
            throw Object.assign(new Error('A running plan must have exactly one matching in_progress step.'), {
                code: 'M365_PLAN_CURRENT_STEP_INVALID',
            });
        }
    } else if (inProgress.length > 0) {
        throw Object.assign(new Error('A non-running plan cannot contain an in_progress step.'), {
            code: 'M365_PLAN_NONRUNNING_STEP_INVALID',
        });
    }
    if (currentStepId && !steps.some((step) => step.id === currentStepId)) {
        throw Object.assign(new Error('current_step_id does not identify a plan step.'), { code: 'M365_PLAN_CURRENT_STEP_INVALID' });
    }

    const question = boundedText(value.question, 'question', { max: 4000 });
    const approvalRequest = boundedText(value.approval_request, 'approval_request', { max: 4000 });
    const completionSummary = boundedText(value.completion_summary, 'completion_summary', { max: 10000 });
    if (status === 'wait_user' && !question) {
        throw Object.assign(new Error('question is required for wait_user.'), { code: 'M365_PLAN_QUESTION_REQUIRED' });
    }
    if (status === 'wait_approval' && !approvalRequest) {
        throw Object.assign(new Error('approval_request is required for wait_approval.'), { code: 'M365_PLAN_APPROVAL_REQUIRED' });
    }
    if (status === 'complete') {
        if (!completionSummary) {
            throw Object.assign(new Error('completion_summary is required for complete.'), { code: 'M365_PLAN_SUMMARY_REQUIRED' });
        }
        if (steps.some((step) => !['completed', 'skipped'].includes(step.status))) {
            throw Object.assign(new Error('Every step must be completed or skipped before completion.'), { code: 'M365_PLAN_PREMATURE_COMPLETION' });
        }
    }

    return {
        schemaVersion: PLAN_SCHEMA_VERSION,
        planId,
        revision,
        goal: boundedText(value.goal, 'goal', { required: true, max: 20000 }),
        completionCriteria: boundedText(value.completion_criteria, 'completion_criteria', { required: true, max: 20000 }),
        status,
        currentStepId: currentStepId || null,
        steps,
        question,
        approvalRequest,
        completionSummary,
    };
}

function stripRenderedLineNumbers(raw) {
    return stripSequentialRenderedLineNumbers(raw, {
        payloadPattern: /^\s*\{[\s\S]*"schema_version"\s*:/,
    });
}

function parseM365PlanBlock(raw) {
    const text = String(raw || '');
    const opens = [...text.matchAll(/\[GOLEM_PLAN\]/gi)];
    const closes = [...text.matchAll(/\[\/GOLEM_PLAN\]/gi)];
    if (opens.length === 0 && closes.length === 0) return { present: false, ok: true, plan: null, errorCode: '', message: '' };
    if (opens.length !== 1 || closes.length !== 1 || closes[0].index < opens[0].index) {
        return result(false, null, 'M365_PLAN_BOUNDARY_INVALID', 'GOLEM_PLAN must appear exactly once with a closing tag.');
    }
    const start = opens[0].index + opens[0][0].length;
    let candidate = text.slice(start, closes[0].index).trim();
    if (candidate.length > 50000) return result(false, null, 'M365_PLAN_TOO_LARGE', 'GOLEM_PLAN is too large.');
    candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').replace(/^json\s*\r?\n/i, '').trim();
    candidate = stripRenderedLineNumbers(candidate);
    candidate = extractJsonPayloadFromRenderedCode(candidate, {
        payloadPattern: /^\s*\{[\s\S]*"schema_version"\s*:/,
    });
    try {
        return result(true, normalizePlan(JSON.parse(candidate)));
    } catch (error) {
        return result(false, null, error.code || 'M365_PLAN_JSON_INVALID', error.message || 'GOLEM_PLAN is invalid.');
    }
}

function truncate(value, max = 15000) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n...[truncated by Golem host]`;
}

function buildM365PlanObservation(input = {}) {
    const payload = {
        schema_version: 'golem_observation/1',
        source: 'golem_host',
        plan_id: String(input.planId || ''),
        plan_revision: Number(input.planRevision || 0),
        run_step_id: String(input.stepId || ''),
        plan_step_id: String(input.planStepId || ''),
        action_id: String(input.actionId || ''),
        lane: String(input.lane || 'action'),
        status: input.status === 'succeeded' ? 'succeeded' : 'failed',
        result: truncate(input.result),
    };
    return `[GOLEM_OBSERVATION]\n${JSON.stringify(payload, null, 2)}\n[/GOLEM_OBSERVATION]\n` +
        `This block was generated by the Golem host and is the only proof that the bound tool result or native plan checkpoint was recorded. ` +
        `Return the next revision of [GOLEM_PLAN]. If it remains running, also emit exactly one bounded [GOLEM_ACTION]. ` +
        `Otherwise move the plan to wait_user, wait_approval, blocked, or complete. Never repeat a completed action without a new host instruction.`;
}

module.exports = {
    MAX_PLAN_STEPS,
    PLAN_SCHEMA_VERSION,
    PLAN_STATUSES,
    STEP_STATUSES,
    buildM365PlanObservation,
    normalizePlan,
    parseM365PlanBlock,
};
