const { RateLimiter, limiters } = require('../src/utils/RateLimiter');

describe('RateLimiter', () => {
    let limiter;

    afterEach(() => {
        if (limiter) limiter.destroy();
    });

    describe('basic token bucket', () => {
        test('allows requests within limit', () => {
            limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, cleanupInterval: 0 });
            expect(limiter.acquire('user1')).toBe(true);
            expect(limiter.acquire('user1')).toBe(true);
            expect(limiter.acquire('user1')).toBe(true);
        });

        test('denies requests when bucket empty', () => {
            limiter = new RateLimiter({ maxTokens: 2, refillRate: 0, cleanupInterval: 0 });
            expect(limiter.acquire('user1')).toBe(true);
            expect(limiter.acquire('user1')).toBe(true);
            expect(limiter.acquire('user1')).toBe(false);
        });

        test('separate buckets per key', () => {
            limiter = new RateLimiter({ maxTokens: 1, refillRate: 0, cleanupInterval: 0 });
            expect(limiter.acquire('user1')).toBe(true);
            expect(limiter.acquire('user2')).toBe(true);
            expect(limiter.acquire('user1')).toBe(false);
            expect(limiter.acquire('user2')).toBe(false);
        });

        test('supports variable cost', () => {
            limiter = new RateLimiter({ maxTokens: 5, refillRate: 0, cleanupInterval: 0 });
            expect(limiter.acquire('user1', 3)).toBe(true);
            expect(limiter.acquire('user1', 3)).toBe(false);
            expect(limiter.acquire('user1', 2)).toBe(true);
        });
    });

    describe('token refill', () => {
        test('refills tokens over time', async () => {
            limiter = new RateLimiter({ maxTokens: 2, refillRate: 100, cleanupInterval: 0 }); // 100 tokens/sec
            limiter.acquire('user1');
            limiter.acquire('user1');
            expect(limiter.acquire('user1')).toBe(false);

            // Wait 50ms → should have ~5 tokens refilled
            await new Promise(r => setTimeout(r, 50));
            expect(limiter.acquire('user1')).toBe(true);
        });

        test('does not exceed max tokens', async () => {
            limiter = new RateLimiter({ maxTokens: 3, refillRate: 1000, cleanupInterval: 0 });
            await new Promise(r => setTimeout(r, 50));
            const info = limiter.getInfo('user1');
            expect(info.remaining).toBeLessThanOrEqual(3);
        });
    });

    describe('getInfo()', () => {
        test('returns remaining tokens', () => {
            limiter = new RateLimiter({ maxTokens: 10, refillRate: 0, cleanupInterval: 0 });
            limiter.acquire('user1');
            limiter.acquire('user1');
            const info = limiter.getInfo('user1');
            expect(info.remaining).toBe(8);
            expect(info.limit).toBe(10);
        });

        test('returns retryAfterMs when limited', () => {
            limiter = new RateLimiter({ maxTokens: 1, refillRate: 1, cleanupInterval: 0 });
            limiter.acquire('user1');
            const info = limiter.getInfo('user1');
            expect(info.retryAfterMs).toBeGreaterThan(0);
        });

        test('returns retryAfterMs=0 when tokens available', () => {
            limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, cleanupInterval: 0 });
            const info = limiter.getInfo('user1');
            expect(info.retryAfterMs).toBe(0);
        });
    });

    describe('block/unblock', () => {
        test('block prevents all requests', () => {
            limiter = new RateLimiter({ maxTokens: 100, refillRate: 100, cleanupInterval: 0 });
            limiter.block('bad-user');
            expect(limiter.acquire('bad-user')).toBe(false);
        });

        test('unblock allows requests again', () => {
            limiter = new RateLimiter({ maxTokens: 100, refillRate: 100, cleanupInterval: 0 });
            limiter.block('user1');
            limiter.unblock('user1');
            expect(limiter.acquire('user1')).toBe(true);
        });

        test('getInfo shows blocked status', () => {
            limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, cleanupInterval: 0 });
            limiter.block('user1');
            expect(limiter.getInfo('user1').blocked).toBe(true);
        });
    });

    describe('reset()', () => {
        test('resets bucket to full', () => {
            limiter = new RateLimiter({ maxTokens: 5, refillRate: 0, cleanupInterval: 0 });
            limiter.acquire('user1');
            limiter.acquire('user1');
            limiter.acquire('user1');
            limiter.reset('user1');
            const info = limiter.getInfo('user1');
            expect(info.remaining).toBe(5);
        });

        test('unblocks when reset', () => {
            limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, cleanupInterval: 0 });
            limiter.block('user1');
            limiter.reset('user1');
            expect(limiter.acquire('user1')).toBe(true);
        });
    });

    describe('stats()', () => {
        test('tracks request counts', () => {
            limiter = new RateLimiter({ maxTokens: 2, refillRate: 0, cleanupInterval: 0 });
            limiter.acquire('user1'); // allowed
            limiter.acquire('user1'); // allowed
            limiter.acquire('user1'); // denied
            const stats = limiter.stats();
            expect(stats.totalRequests).toBe(3);
            expect(stats.totalAllowed).toBe(2);
            expect(stats.totalDenied).toBe(1);
        });

        test('tracks active buckets', () => {
            limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, cleanupInterval: 0 });
            limiter.acquire('user1');
            limiter.acquire('user2');
            expect(limiter.stats().activeBuckets).toBe(2);
        });

        test('tracks blocked keys', () => {
            limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, cleanupInterval: 0 });
            limiter.block('a');
            limiter.block('b');
            expect(limiter.stats().blockedKeys).toBe(2);
        });
    });

    describe('pre-configured limiters', () => {
        test('api limiter exists with 60 tokens', () => {
            expect(limiters.api).toBeInstanceOf(RateLimiter);
            expect(limiters.api.stats().config.maxTokens).toBe(60);
        });

        test('skill limiter exists with 10 tokens', () => {
            expect(limiters.skill).toBeInstanceOf(RateLimiter);
            expect(limiters.skill.stats().config.maxTokens).toBe(10);
        });

        test('gemini limiter exists with 15 tokens', () => {
            expect(limiters.gemini).toBeInstanceOf(RateLimiter);
            expect(limiters.gemini.stats().config.maxTokens).toBe(15);
        });
    });

    describe('destroy()', () => {
        test('stops cleanup timer', () => {
            limiter = new RateLimiter({ cleanupInterval: 100 });
            expect(() => limiter.destroy()).not.toThrow();
        });
    });
});
