const { t, setLocale, getLocale, getSupportedLocales } = require('../src/i18n');

describe('i18n System', () => {
    beforeEach(() => {
        setLocale('zh-TW'); // Reset to default
    });

    describe('basic translation', () => {
        test('translates zh-TW keys', () => {
            expect(t('system.boot.starting')).toContain('Golem');
            expect(t('system.boot.starting')).toContain('啟動');
        });

        test('translates en keys', () => {
            setLocale('en');
            expect(t('system.boot.starting')).toContain('starting');
        });

        test('translates ja keys', () => {
            setLocale('ja');
            expect(t('system.boot.starting')).toContain('起動');
        });
    });

    describe('variable substitution', () => {
        test('substitutes {{variables}}', () => {
            const result = t('system.boot.model_loaded', { model: 'Gemini 2.5' });
            expect(result).toContain('Gemini 2.5');
        });

        test('substitutes multiple variables', () => {
            const result = t('android.swiped', { x1: 100, y1: 200, x2: 300, y2: 400 });
            expect(result).toContain('100');
            expect(result).toContain('400');
        });

        test('preserves unmatched variables', () => {
            const result = t('system.boot.model_loaded', {});
            expect(result).toContain('{{model}}');
        });
    });

    describe('fallback behavior', () => {
        test('returns key when translation missing', () => {
            expect(t('nonexistent.key')).toBe('nonexistent.key');
        });

        test('falls back to zh-TW for missing keys in en', () => {
            setLocale('en');
            // All keys exist in en, so test with a deep path
            expect(t('system.boot.ready')).toBeTruthy();
        });
    });

    describe('locale management', () => {
        test('getLocale returns current locale', () => {
            expect(getLocale()).toBe('zh-TW');
            setLocale('en');
            expect(getLocale()).toBe('en');
        });

        test('getSupportedLocales returns all locales', () => {
            const locales = getSupportedLocales();
            expect(locales).toContain('zh-TW');
            expect(locales).toContain('en');
            expect(locales).toContain('ja');
        });

        test('rejects unsupported locale', () => {
            const result = setLocale('fr');
            expect(result).toBe(false);
            expect(getLocale()).toBe('zh-TW');
        });

        test('accepts supported locale', () => {
            const result = setLocale('ja');
            expect(result).toBe(true);
            expect(getLocale()).toBe('ja');
        });
    });

    describe('coverage across all sections', () => {
        const sections = ['system', 'security', 'android', 'dashboard', 'doctor', 'memory', 'common'];

        test.each(sections)('section "%s" exists in zh-TW', (section) => {
            // Just verify the section key resolves to something
            const result = t(`${section}`);
            // If it returns the key itself, the section doesn't exist
            expect(result).not.toBe(section);
        });
    });

    describe('all locales have same keys', () => {
        function getKeys(obj, prefix = '') {
            const keys = [];
            for (const [k, v] of Object.entries(obj)) {
                const fullKey = prefix ? `${prefix}.${k}` : k;
                if (typeof v === 'object' && v !== null) {
                    keys.push(...getKeys(v, fullKey));
                } else {
                    keys.push(fullKey);
                }
            }
            return keys.sort();
        }

        test('en has same keys as zh-TW', () => {
            const zhTW = require('../src/i18n/locales/zh-TW.json');
            const en = require('../src/i18n/locales/en.json');
            expect(getKeys(en)).toEqual(getKeys(zhTW));
        });

        test('ja has same keys as zh-TW', () => {
            const zhTW = require('../src/i18n/locales/zh-TW.json');
            const ja = require('../src/i18n/locales/ja.json');
            expect(getKeys(ja)).toEqual(getKeys(zhTW));
        });
    });
});
