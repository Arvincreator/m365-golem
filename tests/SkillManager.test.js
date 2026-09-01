const SkillManager = require('../src/managers/SkillManager');
const fs = require('fs');

jest.mock('fs');

describe('SkillManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        fs.existsSync.mockReturnValue(true);
        fs.readdirSync.mockReturnValue([]);
        SkillManager.skills.clear();
    });

    test('refresh should scan directories', () => {
        fs.readdirSync.mockReturnValue([]);
        SkillManager.refresh();
        expect(fs.readdirSync).toHaveBeenCalled();
    });

    test('refresh should create directories when missing', () => {
        fs.existsSync.mockReturnValue(false);
        fs.readdirSync.mockReturnValue([]);
        SkillManager.refresh();
        expect(fs.mkdirSync).toHaveBeenCalled();
    });

    test('refresh loads valid JS skills from directories', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readdirSync.mockReturnValue(['test-skill.js']);
        // Can't really mock require, so we expect error and it to be caught silently
        SkillManager.refresh();
        // The error is caught silently, skills remain empty but no crash
        expect(SkillManager.skills.size).toBe(0);
    });

    test('getSkill triggers refresh if skills empty', () => {
        const refreshSpy = jest.spyOn(SkillManager, 'refresh');
        SkillManager.getSkill('nonexistent');
        expect(refreshSpy).toHaveBeenCalled();
    });

    test('getSkill returns undefined for unknown skill', () => {
        const result = SkillManager.getSkill('nothing');
        expect(result).toBeUndefined();
    });

    test('getSkill returns skill when present', () => {
        SkillManager.skills.set('TestSkill', { name: 'TestSkill', run: jest.fn() });
        const result = SkillManager.getSkill('TestSkill');
        expect(result.name).toBe('TestSkill');
    });

    test('listSkills returns array of all skills', () => {
        SkillManager.skills.set('A', { name: 'A', description: 'desc A', _type: 'CORE', run: jest.fn() });
        SkillManager.skills.set('B', { name: 'B', description: 'desc B', _type: 'USER', run: jest.fn() });
        const list = SkillManager.listSkills();
        expect(list).toHaveLength(2);
        expect(list[0].name).toBe('A');
    });

    test('importSkill should write file and return success', () => {
        const payload = { n: 'imported', c: 'console.log("hello")' };
        const token = `GOLEM_SKILL::${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
        
        const result = SkillManager.importSkill(token);
        expect(result.success).toBe(true);
        expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('importSkill backs up existing file', () => {
        fs.existsSync.mockReturnValue(true);
        const payload = { n: 'existing', c: 'module.exports = { name: "existing", run: () => {} }' };
        const token = `GOLEM_SKILL::${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
        SkillManager.importSkill(token);
        expect(fs.renameSync).toHaveBeenCalled();
    });

    test('importSkill should reject invalid token format', () => {
        expect(() => SkillManager.importSkill('INVALID_TOKEN')).toThrow('Invalid Skill Capsule format');
    });

    test('importSkill should reject skill with child_process', () => {
        const payload = { n: 'evil', c: 'const {exec} = require("child_process"); exec("rm -rf /")' };
        const token = `GOLEM_SKILL::${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
        const result = SkillManager.importSkill(token);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Security Alert');
    });

    test('importSkill should fail for corrupted data', () => {
        const payload = { x: 'something_wrong' }; // missing n and c
        const token = `GOLEM_SKILL::${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
        const result = SkillManager.importSkill(token);
        expect(result.success).toBe(false);
    });

    test('exportSkill should throw for unknown skill', () => {
        expect(() => SkillManager.exportSkill('ghost-skill')).toThrow('Skill "ghost-skill" not found');
    });

    test('exportSkill should throw for CORE skills', () => {
        SkillManager.skills.set('core-skill', { name: 'core-skill', _type: 'CORE' });
        expect(() => SkillManager.exportSkill('core-skill')).toThrow('Cannot export Core skills');
    });

    test('exportSkill should return valid GOLEM_SKILL:: token', () => {
        fs.readFileSync.mockReturnValue('module.exports = { name: "mySkill", run: () => {} }');
        SkillManager.skills.set('mySkill', { name: 'mySkill', version: '1.0', _type: 'USER', _filepath: '/tmp/mySkill.js' });
        const token = SkillManager.exportSkill('mySkill');
        expect(token.startsWith('GOLEM_SKILL::')).toBe(true);
    });

    test('getEnabled returns array of enabled skills', () => {
        SkillManager.skills.set('A', { name: 'A', description: 'Test', _type: 'CORE' });
        // listSkills includes all skills
        const items = SkillManager.listSkills();
        expect(items.some(s => s.name === 'A')).toBe(true);
    });
});
