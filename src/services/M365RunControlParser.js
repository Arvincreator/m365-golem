'use strict';

const RUN_CONTROL_STATUSES = Object.freeze([
    'continue',
    'wait_user',
    'wait_approval',
    'complete',
    'blocked',
]);

function boundedText(value, maxLength) {
    return String(value || '').trim().slice(0, maxLength);
}

function parseM365RunControl(responseText) {
    const text = String(responseText || '');
    const openMarker = '[GOLEM_RUN]';
    const closeMarker = '[/GOLEM_RUN]';
    const start = text.lastIndexOf(openMarker);
    const end = start >= 0 ? text.indexOf(closeMarker, start + openMarker.length) : -1;
    if (start < 0 || end < 0) {
        return { ok: false, errorCode: 'M365_RUN_CONTROL_MISSING' };
    }

    const raw = text.slice(start + openMarker.length, end).trim();
    if (!raw || raw.length > 50000) {
        return { ok: false, errorCode: 'M365_RUN_CONTROL_INVALID' };
    }

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch (_) {
        return { ok: false, errorCode: 'M365_RUN_CONTROL_JSON_INVALID' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, errorCode: 'M365_RUN_CONTROL_INVALID' };
    }

    const status = String(payload.status || '').trim().toLowerCase();
    if (!RUN_CONTROL_STATUSES.includes(status)) {
        return { ok: false, errorCode: 'M365_RUN_CONTROL_STATUS_INVALID' };
    }

    const stepSummary = boundedText(payload.step_summary, 20000);
    const nextPrompt = boundedText(payload.next_prompt, 50000);
    const question = boundedText(payload.question, 20000);
    const approvalRequest = boundedText(payload.approval_request, 20000);
    const evidence = Array.isArray(payload.evidence)
        ? payload.evidence.slice(0, 50).map((item) => boundedText(item, 2000)).filter(Boolean)
        : [];

    if (!stepSummary) return { ok: false, errorCode: 'M365_RUN_CONTROL_SUMMARY_REQUIRED' };
    if (status === 'continue' && !nextPrompt) {
        return { ok: false, errorCode: 'M365_RUN_CONTROL_NEXT_PROMPT_REQUIRED' };
    }
    if (status === 'wait_user' && !question) {
        return { ok: false, errorCode: 'M365_RUN_CONTROL_QUESTION_REQUIRED' };
    }
    if (status === 'wait_approval' && !approvalRequest) {
        return { ok: false, errorCode: 'M365_RUN_CONTROL_APPROVAL_REQUIRED' };
    }

    return {
        ok: true,
        control: {
            status,
            stepSummary,
            nextPrompt,
            question,
            approvalRequest,
            evidence,
        },
    };
}

function stripM365RunControl(responseText) {
    const text = String(responseText || '');
    const openMarker = '[GOLEM_RUN]';
    const closeMarker = '[/GOLEM_RUN]';
    const start = text.lastIndexOf(openMarker);
    const end = start >= 0 ? text.indexOf(closeMarker, start + openMarker.length) : -1;
    if (start < 0 || end < 0) return text.trim();
    return `${text.slice(0, start)}${text.slice(end + closeMarker.length)}`.trim();
}

module.exports = {
    RUN_CONTROL_STATUSES,
    parseM365RunControl,
    stripM365RunControl,
};
