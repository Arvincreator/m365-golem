'use strict';

const { mayAutoApproveM365Actions } = require('../src/services/M365AutomationPolicy');
const { getAutomationModePreset } = require('../src/config/AutomationModes');

describe('M365 automation policy', () => {
    const keys = Object.keys(getAutomationModePreset('guided'));
    let previous;

    beforeEach(() => {
        previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
        Object.assign(process.env, getAutomationModePreset('guided'));
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    test('allows only bounded host introspection commands without a guided approval prompt', () => {
        expect(mayAutoApproveM365Actions([
            { action: 'command', parameter: 'golem-memory 之前有哪些踩坑經驗' },
        ])).toBe(true);
        expect(mayAutoApproveM365Actions([
            { action: 'command', parameter: 'golem-check tools 建立文件' },
        ])).toBe(true);
        expect(mayAutoApproveM365Actions([
            { action: 'command', parameter: 'cat AGENTS.md' },
        ])).toBe(false);
    });
});
