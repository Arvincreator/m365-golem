/**
 * RateLimiter — Token bucket algorithm for request throttling.
 *
 * Prevents abuse and ensures fair resource distribution across
 * users, skills, and API endpoints.
 *
 * Usage:
 *   const limiter = new RateLimiter({ maxTokens: 60, refillRate: 1 });
 *   if (limiter.acquire('user-123')) {
 *       // Allow request
 *   } else {
 *       const info = limiter.getInfo('user-123');
 *       console.log(`Rate limited. Retry in ${info.retryAfterMs}ms`);
 *   }
 */

'use strict';

class RateLimiter {
    /**
     * @param {Object} options
     * @param {number} options.maxTokens - Maximum tokens per bucket (burst capacity)
     * @param {number} options.refillRate - Tokens added per second
     * @param {number} options.cleanupInterval - Cleanup inactive buckets (ms), 0 to disable
     */
    constructor(options = {}) {
        this._maxTokens = options.maxTokens ?? 60;
        this._refillRate = options.refillRate ?? 1; // tokens per second
        this._buckets = new Map();
        this._blocked = new Set();
        this._stats = {
            totalRequests: 0,
            totalAllowed: 0,
            totalDenied: 0,
        };

        // Periodic cleanup of stale buckets
        this._cleanupInterval = options.cleanupInterval ?? 300000; // 5 min
        this._cleanupTimer = null;
        if (this._cleanupInterval > 0) {
            this._cleanupTimer = setInterval(
                () => this._cleanup(),
                this._cleanupInterval
            );
            if (this._cleanupTimer.unref) this._cleanupTimer.unref();
        }
    }

    /**
     * Try to acquire a token for the given key.
     * @param {string} key - Identifier (userId, IP, skillName, etc.)
     * @param {number} cost - Number of tokens to consume (default: 1)
     * @returns {boolean} true if allowed, false if rate limited
     */
    acquire(key, cost = 1) {
        this._stats.totalRequests++;

        // Check if explicitly blocked
        if (this._blocked.has(key)) {
            this._stats.totalDenied++;
            return false;
        }

        const bucket = this._getBucket(key);
        this._refill(bucket);

        if (bucket.tokens >= cost) {
            bucket.tokens -= cost;
            bucket.lastAccess = Date.now();
            this._stats.totalAllowed++;
            return true;
        }

        this._stats.totalDenied++;
        return false;
    }

    /**
     * Get rate limit info for a key.
     * @param {string} key
     * @returns {Object} Rate limit info
     */
    getInfo(key) {
        const bucket = this._getBucket(key);
        this._refill(bucket);

        const tokensNeeded = Math.max(0, 1 - bucket.tokens);
        const retryAfterMs = tokensNeeded > 0
            ? Math.ceil((tokensNeeded / this._refillRate) * 1000)
            : 0;

        return {
            remaining: Math.floor(bucket.tokens),
            limit: this._maxTokens,
            resetMs: Math.ceil(
                ((this._maxTokens - bucket.tokens) / this._refillRate) * 1000
            ),
            retryAfterMs,
            blocked: this._blocked.has(key),
        };
    }

    /**
     * Block a key entirely (e.g., abusive user).
     * @param {string} key
     */
    block(key) {
        this._blocked.add(key);
    }

    /**
     * Unblock a key.
     * @param {string} key
     */
    unblock(key) {
        this._blocked.delete(key);
    }

    /**
     * Reset a key's bucket to full.
     * @param {string} key
     */
    reset(key) {
        this._buckets.delete(key);
        this._blocked.delete(key);
    }

    /**
     * Get overall stats.
     * @returns {Object}
     */
    stats() {
        return {
            ...this._stats,
            activeBuckets: this._buckets.size,
            blockedKeys: this._blocked.size,
            config: {
                maxTokens: this._maxTokens,
                refillRate: this._refillRate,
            },
        };
    }

    /**
     * Get or create a bucket for a key.
     * @private
     */
    _getBucket(key) {
        if (!this._buckets.has(key)) {
            this._buckets.set(key, {
                tokens: this._maxTokens,
                lastRefill: Date.now(),
                lastAccess: Date.now(),
            });
        }
        return this._buckets.get(key);
    }

    /**
     * Refill tokens based on elapsed time.
     * @private
     */
    _refill(bucket) {
        const now = Date.now();
        const elapsed = (now - bucket.lastRefill) / 1000; // seconds
        const tokensToAdd = elapsed * this._refillRate;

        bucket.tokens = Math.min(
            this._maxTokens,
            bucket.tokens + tokensToAdd
        );
        bucket.lastRefill = now;
    }

    /**
     * Remove stale buckets (no access in 2x cleanup interval).
     * @private
     */
    _cleanup() {
        const cutoff = Date.now() - (this._cleanupInterval * 2);
        for (const [key, bucket] of this._buckets) {
            if (bucket.lastAccess < cutoff) {
                this._buckets.delete(key);
            }
        }
    }

    /**
     * Stop the cleanup timer.
     */
    destroy() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
    }
}

/**
 * Pre-configured limiters for common use cases.
 */
const limiters = {
    /** Per-user API rate limit: 60 req/min */
    api: new RateLimiter({ maxTokens: 60, refillRate: 1, cleanupInterval: 0 }),

    /** Per-skill execution limit: 10 req/min */
    skill: new RateLimiter({ maxTokens: 10, refillRate: 10 / 60, cleanupInterval: 0 }),

    /** Gemini API calls: 15 req/min (free tier) */
    gemini: new RateLimiter({ maxTokens: 15, refillRate: 15 / 60, cleanupInterval: 0 }),
};

module.exports = { RateLimiter, limiters };
