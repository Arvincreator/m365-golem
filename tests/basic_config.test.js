const config = require('../src/config');

describe('ConfigManager', () => {
    test('cleanEnv should remove non-printable characters', () => {
        const input = "test\x00\x1FValue";
        expect(config.cleanEnv(input)).toBe("testValue");
    });

    test('cleanEnv should remove spaces by default', () => {
        const input = "test value";
        expect(config.cleanEnv(input)).toBe("testvalue");
    });

    test('cleanEnv should allow spaces when specified', () => {
        const input = "test value";
        expect(config.cleanEnv(input, true)).toBe("test value");
    });

    test('isPlaceholder should identify typical placeholders', () => {
        expect(config.isPlaceholder("YOUR_TOKEN_HERE")).toBe(true);
        expect(config.isPlaceholder("你的TOKEN")).toBe(true);
        // [Fix] config.isPlaceholder also checks length < 10, so use a longer string
        expect(config.isPlaceholder("real_token_v9_1_2_abc123")).toBe(false);
    });
});
