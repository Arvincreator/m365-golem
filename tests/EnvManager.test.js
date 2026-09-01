const fs = require('fs');

jest.mock('fs', () => ({
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
}));

const EnvManager = require('../src/utils/EnvManager');

describe('EnvManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        fs.existsSync.mockReturnValue(true);
    });

    test.each([
        ['LF', 'GEMINI_API_KEYS=abc\nSYSTEM_CONFIGURED=true\n'],
        ['CRLF', 'GEMINI_API_KEYS=abc\r\nSYSTEM_CONFIGURED=true\r\n'],
        ['CR', 'GEMINI_API_KEYS=abc\rSYSTEM_CONFIGURED=true\r'],
    ])('readEnv parses %s line endings', (_lineEnding, content) => {
        fs.readFileSync.mockReturnValue(content);

        expect(EnvManager.readEnv()).toEqual({
            GEMINI_API_KEYS: 'abc',
            SYSTEM_CONFIGURED: 'true',
        });
    });
});
