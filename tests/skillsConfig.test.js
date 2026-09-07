const { MANDATORY_SKILLS, OPTIONAL_SKILLS, resolveEnabledSkills } = require('../src/skills/skillsConfig');

describe('skillsConfig', () => {
    test('MANDATORY_SKILLS is a non-empty array', () => {
        expect(Array.isArray(MANDATORY_SKILLS)).toBe(true);
        expect(MANDATORY_SKILLS.length).toBeGreaterThan(0);
    });

    test('OPTIONAL_SKILLS has no retired built-in placeholders', () => {
        expect(Array.isArray(OPTIONAL_SKILLS)).toBe(true);
        expect(OPTIONAL_SKILLS).toEqual([]);
    });

    test('resolveEnabledSkills includes all mandatory skills', () => {
        const result = resolveEnabledSkills('', []);
        for (const skill of MANDATORY_SKILLS) {
            expect(result.has(skill)).toBe(true);
        }
    });

    test('resolveEnabledSkills includes optionals from env string', () => {
        const result = resolveEnabledSkills('vat-review, client-intake', []);
        expect(result.has('vat-review')).toBe(true);
        expect(result.has('client-intake')).toBe(true);
    });

    test('resolveEnabledSkills includes optionals from persona skills', () => {
        const result = resolveEnabledSkills('', ['owner-rules']);
        expect(result.has('owner-rules')).toBe(true);
    });

    test('resolveEnabledSkills does not double-add mandatory skills from optionals', () => {
        const firstMandatory = MANDATORY_SKILLS[0];
        const result = resolveEnabledSkills(firstMandatory, []);
        // Size should not grow if we add an already-mandatory skill
        const baseSize = resolveEnabledSkills('', []).size;
        expect(result.size).toBe(baseSize);
    });

    test('resolveEnabledSkills filters empty strings from env', () => {
        const result = resolveEnabledSkills(',,,', []);
        const baseSize = resolveEnabledSkills('', []).size;
        expect(result.size).toBe(baseSize);
    });
});
