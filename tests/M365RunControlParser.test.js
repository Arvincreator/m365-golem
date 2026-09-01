'use strict';

const {
    parseM365RunControl,
    stripM365RunControl,
} = require('../src/services/M365RunControlParser');
const ResponseParser = require('../src/utils/ResponseParser');

describe('M365 run control parser', () => {
    test('parses a bounded continuation block and keeps user-facing text separate', () => {
        const response = [
            '已完成第一輪盤點。',
            '[GOLEM_RUN]',
            JSON.stringify({
                status: 'continue',
                step_summary: '完成第一輪盤點',
                next_prompt: '整理三項最高風險。',
                evidence: ['工作底稿 A'],
            }),
            '[/GOLEM_RUN]',
        ].join('\n');
        expect(parseM365RunControl(response)).toEqual({
            ok: true,
            control: {
                status: 'continue',
                stepSummary: '完成第一輪盤點',
                nextPrompt: '整理三項最高風險。',
                question: '',
                approvalRequest: '',
                evidence: ['工作底稿 A'],
            },
        });
        expect(stripM365RunControl(response)).toBe('已完成第一輪盤點。');
    });

    test('survives the existing GOLEM_REPLY protocol extraction path', () => {
        const control = JSON.stringify({
            status: 'complete',
            step_summary: 'Completed through the normal response protocol.',
            evidence: [],
        });
        const parsedReply = ResponseParser.parse([
            '[GOLEM_REPLY]',
            '使用者看到的完成說明。',
            '[GOLEM_RUN]',
            control,
            '[/GOLEM_RUN]',
            '[/GOLEM_REPLY]',
        ].join('\n')).reply;

        expect(parseM365RunControl(parsedReply)).toEqual(expect.objectContaining({ ok: true }));
        expect(stripM365RunControl(parsedReply)).toBe('使用者看到的完成說明。');
    });

    test.each([
        ['', 'M365_RUN_CONTROL_MISSING'],
        ['[GOLEM_RUN]{bad json}[/GOLEM_RUN]', 'M365_RUN_CONTROL_JSON_INVALID'],
        ['[GOLEM_RUN]{"status":"continue","step_summary":"done"}[/GOLEM_RUN]', 'M365_RUN_CONTROL_NEXT_PROMPT_REQUIRED'],
        ['[GOLEM_RUN]{"status":"wait_user","step_summary":"done"}[/GOLEM_RUN]', 'M365_RUN_CONTROL_QUESTION_REQUIRED'],
        ['[GOLEM_RUN]{"status":"unknown","step_summary":"done"}[/GOLEM_RUN]', 'M365_RUN_CONTROL_STATUS_INVALID'],
    ])('fails closed for invalid control: %s', (response, errorCode) => {
        expect(parseM365RunControl(response)).toEqual({ ok: false, errorCode });
    });
});
