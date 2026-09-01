jest.mock('../src/config', () => ({ CONFIG: { API_KEYS: ['key1', 'key2'] } }));

const KeyChain = require('../src/services/KeyChain');

describe('KeyChain', () => {
    let kc;

    beforeEach(() => {
        kc = new KeyChain();
        // disable throttle
        kc._minInterval = 0;
        kc._lastCallTime = 0;
    });

    test('getKey should rotate keys', async () => {
        const k1 = await kc.getKey();
        const k2 = await kc.getKey();
        const k3 = await kc.getKey();
        expect(k1).toBe('key1');
        expect(k2).toBe('key2');
        expect(k3).toBe('key1');
    });

    test('markCooldown should temporarily skip a key', async () => {
        kc.markCooldown('key1', 60000); // 1 minute cooldown
        const k = await kc.getKey();
        expect(k).toBe('key2');
    });

    test('_isCooling should return false when cooldown expired', () => {
        kc._cooldownUntil.set('key1', Date.now() - 1000); // already expired
        expect(kc._isCooling('key1')).toBe(false);
    });

    test('_isCooling should return true when key is cooling', () => {
        kc._cooldownUntil.set('key1', Date.now() + 60000);
        expect(kc._isCooling('key1')).toBe(true);
    });

    test('getKey should return null if all keys are cooling', async () => {
        kc.markCooldown('key1', 60000);
        kc.markCooldown('key2', 60000);
        const k = await kc.getKey();
        expect(k).toBeNull();
    });

    test('getKey should return null if no keys', async () => {
        // Also clear CONFIG so the hot-reload check doesn't restore keys
        const { CONFIG } = require('../src/config');
        const saved = CONFIG.API_KEYS;
        CONFIG.API_KEYS = [];
        kc.keys = [];
        const k = await kc.getKey();
        expect(k).toBeNull();
        CONFIG.API_KEYS = saved; // restore
    });

    test('recordError should increment error count', () => {
        kc.recordError('key1', new Error('Some error'));
        const stat = kc._stats.get('key1');
        expect(stat.errors).toBe(1);
    });

    test('recordError with 429 should trigger cooldown', () => {
        const spy = jest.spyOn(kc, 'markCooldown');
        kc.recordError('key1', new Error('429 RESOURCE_EXHAUSTED'));
        expect(spy).toHaveBeenCalledWith('key1', expect.any(Number));
    });

    test('recordError with daily limit should use longer cooldown', () => {
        const spy = jest.spyOn(kc, 'markCooldown');
        kc.recordError('key1', new Error('429 RESOURCE_EXHAUSTED per day'));
        expect(spy).toHaveBeenCalledWith('key1', 15 * 60 * 1000);
    });

    test('getStatus should show available when no cooldown', () => {
        const status = kc.getStatus();
        expect(status).toBe('全部可用');
    });

    test('getStatus should show cooling keys', () => {
        kc.markCooldown('key1', 60000);
        const status = kc.getStatus();
        expect(status).toContain('#0');
    });

    test('updateKeys should replace keys and reset state', () => {
        kc.markCooldown('key1', 60000);
        kc.updateKeys(['newKey1', 'newKey2', 'newKey3']);
        expect(kc.keys).toEqual(['newKey1', 'newKey2', 'newKey3']);
        expect(kc.currentIndex).toBe(0);
        expect(kc._cooldownUntil.size).toBe(0);
    });

    test('updateKeys should ignore non-array input', () => {
        const originalKeys = [...kc.keys];
        kc.updateKeys('not-an-array');
        expect(kc.keys).toEqual(originalKeys);
    });

    test('getKey should hot-reload when CONFIG.API_KEYS changes', async () => {
        const { CONFIG } = require('../src/config');
        CONFIG.API_KEYS = ['newKey'];
        const spy = jest.spyOn(kc, 'updateKeys');
        await kc.getKey();
        expect(spy).toHaveBeenCalledWith(['newKey']);
        CONFIG.API_KEYS = ['key1', 'key2']; // restore
    });
});
