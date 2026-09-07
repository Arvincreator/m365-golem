const {
    AUTOMATION_MODE_IDS,
    getAutomationModePreset,
    inferAutomationMode,
    isFullAutoMode,
    normalizeAutomationMode,
} = require('../src/config/AutomationModes');

describe('AutomationModes', () => {
    test.each([
        ['guided', '0', 'false', 'false', 'false', '1'],
        ['balanced', '1', 'false', 'false', 'true', '2'],
        ['autopilot', '2', 'true', 'false', 'true', '4'],
        ['silent', '3', 'true', 'true', 'true', '4'],
    ])('%s uses the original Golem safety preset', (mode, level, auto, silent, trust, maxTurns) => {
        const preset = getAutomationModePreset(mode);

        expect(preset).toEqual(expect.objectContaining({
            AUTONOMY_LEVEL: level,
            GOLEM_AUTO_APPROVE_ALL: auto,
            GOLEM_SILENT_AUTO_APPROVE: silent,
            GOLEM_TRUST_SYSTEM_COMMANDS: trust,
            GOLEM_STRICT_SAFEGUARD: 'true',
            GOLEM_MAX_AUTO_TURNS: maxTurns,
        }));
        expect(inferAutomationMode(preset)).toBe(mode);
    });

    test('exposes only the four canonical user-facing modes', () => {
        expect(AUTOMATION_MODE_IDS).toEqual(['guided', 'balanced', 'autopilot', 'silent']);
    });

    test.each([
        ['manual', 'guided'],
        ['lockdown', 'guided'],
        ['auto', 'autopilot'],
        ['balanced', 'balanced'],
        ['unknown', null],
    ])('normalizes legacy mode %s to %s', (input, expected) => {
        expect(normalizeAutomationMode(input)).toBe(expected);
    });

    test('returns a copy so callers cannot mutate the shared preset', () => {
        const first = getAutomationModePreset('balanced');
        first.AUTONOMY_LEVEL = '9';

        expect(getAutomationModePreset('balanced').AUTONOMY_LEVEL).toBe('1');
    });

    test('treats only autopilot and silent as full-auto modes', () => {
        expect(isFullAutoMode('guided')).toBe(false);
        expect(isFullAutoMode('balanced')).toBe(false);
        expect(isFullAutoMode('autopilot')).toBe(true);
        expect(isFullAutoMode('silent')).toBe(true);
    });
});
