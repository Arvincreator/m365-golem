// We need to clear the module registry since persona is a singleton
// and we want fresh mocks per test.
jest.mock('fs');

const fs = require('fs');
const persona = require('../src/skills/core/persona');

describe('Persona Manager', () => {
    const testDir = '/tmp/test_golem';
    const testPersona = {
        aiName: 'Golem',
        userName: 'Alan',
        currentRole: 'An AI assistant',
        tone: 'Friendly',
        skills: [],
        isNew: false
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('get() returns default persona when file does not exist', () => {
        fs.existsSync.mockReturnValue(false);
        const result = persona.get(testDir);
        expect(result.aiName).toBe('Golem');
        expect(result.userName).toBe('Traveler');
        expect(result.isNew).toBe(true);
    });

    test('get() loads persona from file when it exists', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(testPersona));
        const result = persona.get(testDir);
        expect(result.userName).toBe('Alan');
    });

    test('get() returns default on file read error', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockImplementation(() => { throw new Error('cannot read'); });
        const result = persona.get(testDir);
        expect(result.aiName).toBe('Golem');
    });

    test('save() writes persona to file', () => {
        fs.existsSync.mockReturnValue(true);
        persona.save(testDir, testPersona);
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining('persona.json'),
            expect.stringContaining('"userName": "Alan"')
        );
    });

    test('save() creates directory if missing', () => {
        fs.existsSync.mockReturnValueOnce(false); // dir missing
        persona.save(testDir, testPersona);
        expect(fs.mkdirSync).toHaveBeenCalledWith(testDir, { recursive: true });
    });

    test('setName() saves ai name', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(testPersona));
        const result = persona.setName(testDir, 'ai', 'NewGolem');
        expect(result).toBe('NewGolem');
        expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('setName() saves user name and marks isNew=false', () => {
        const freshPersona = { ...testPersona, isNew: true };
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(freshPersona));
        persona.setName(testDir, 'user', 'Bob');
        const savedData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(savedData.userName).toBe('Bob');
        expect(savedData.isNew).toBe(false);
    });

    test('setRole() updates current role', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(testPersona));
        persona.setRole(testDir, 'New Role Description');
        const savedData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(savedData.currentRole).toBe('New Role Description');
    });

    test('exists() returns true when file present', () => {
        fs.existsSync.mockReturnValue(true);
        expect(persona.exists(testDir)).toBe(true);
    });

    test('exists() returns false when file missing', () => {
        fs.existsSync.mockReturnValue(false);
        expect(persona.exists(testDir)).toBe(false);
    });

    test('_getPersonaPath uses cwd when no userDataDir given', () => {
        const p = persona._getPersonaPath(null);
        expect(p).toContain('golem_persona.json');
    });
});
