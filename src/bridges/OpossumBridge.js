// src/bridges/OpossumBridge.js
// Industrial-grade circuit breaker layer using Opossum 9.0
// Wraps existing circuit_breaker.js API surface — drop-in compatible
// Uses environment variables instead of XML config

const CircuitBreaker = require('opossum');
const ConfigManager = require('../config');

// Defaults matching existing circuit_breaker.js behavior
const FALLBACK_OPTS = {
  timeout: parseInt(ConfigManager.CONFIG.CB_TG_TIMEOUT_MS) || 10000,
  resetTimeout: parseInt(ConfigManager.CONFIG.CB_TG_RESET_MS) || 60000,
  errorThresholdPercentage: parseInt(ConfigManager.CONFIG.CB_TG_ERROR_PCT) || 30,
  rollingCountTimeout: 10000,
  rollingCountBuckets: 10,
  volumeThreshold: 3,
};

class OpossumBridge {
  constructor() {
    this._breakers = new Map(); // serviceId → Opossum CircuitBreaker
  }

  /**
   * Get or create an Opossum circuit breaker for a service
   * @param {string} serviceId - e.g. 'fleet', 'rag', 'gemini', 'telegram'
   */
  _getBreaker(serviceId, fn) {
    if (this._breakers.has(serviceId)) {
      return this._breakers.get(serviceId);
    }

    let opts = { ...FALLBACK_OPTS };

    const breaker = new CircuitBreaker(fn, opts);

    // Log state changes
    breaker.on('open', () => {
      console.log(`🔴 [Opossum] ${serviceId}: CLOSED → OPEN`);
    });
    breaker.on('halfOpen', () => {
      console.log(`🟡 [Opossum] ${serviceId}: OPEN → HALF_OPEN`);
    });
    breaker.on('close', () => {
      console.log(`🟢 [Opossum] ${serviceId}: → CLOSED (recovered)`);
    });
    breaker.on('fallback', () => {
      console.log(`🟠 [Opossum] ${serviceId}: Fallback triggered`);
    });
    breaker.on('timeout', () => {
      console.log(`⏰ [Opossum] ${serviceId}: Request timed out`);
    });

    this._breakers.set(serviceId, breaker);
    return breaker;
  }

  // ================================================================
  // Compatible API — same as existing circuit_breaker.js
  // ================================================================

  /**
   * Check if a service call is allowed
   * @param {string} serviceId
   * @returns {boolean}
   */
  canExecute(serviceId) {
    const breaker = this._breakers.get(serviceId);
    if (!breaker) return true; // No breaker yet = allowed
    return !breaker.opened;
  }

  /**
   * Record a success (for manual tracking compatibility)
   */
  recordSuccess(serviceId) {
    // Opossum tracks success automatically; this is a no-op for compatibility
  }

  /**
   * Record a failure (for manual tracking compatibility)
   */
  recordFailure(serviceId, error) {
    // Opossum tracks failures automatically; this is a no-op for compatibility
  }

  /**
   * Reset a circuit breaker
   * @param {string} serviceId
   */
  reset(serviceId) {
    const breaker = this._breakers.get(serviceId);
    if (breaker) {
      breaker.close();
    }
  }

  /**
   * Get status of all circuit breakers (dashboard/diagnostics)
   * @returns {object}
   */
  getStatus() {
    const result = {};
    for (const [id, breaker] of this._breakers) {
      const stats = breaker.stats;
      result[id] = {
        state: breaker.opened ? 'OPEN' : (breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED'),
        failures: stats.failures || 0,
        successes: stats.successes || 0,
        totalTrips: stats.opens || 0,
        timeout: breaker.options.timeout,
        resetTimeout: breaker.options.resetTimeout,
        lastError: null,
      };
    }
    return result;
  }

  /**
   * Execute a function with circuit breaker protection
   * EXACT same signature as existing circuit_breaker.js
   * @param {string} serviceId
   * @param {Function} fn - async function to execute
   * @returns {Promise<any>}
   */
  async execute(serviceId, fn) {
    if (!this._breakers.has(serviceId)) {
      const wrapper = async (action) => await action();
      this._getBreaker(serviceId, wrapper);
    }

    const breaker = this._breakers.get(serviceId);

    try {
      return await breaker.fire(fn);
    } catch (e) {
      if (breaker.opened) {
        const remaining = Math.max(0, breaker.options.resetTimeout -
          (Date.now() - (breaker.stats.latencyTimes?.[0] || Date.now())));
        throw new Error(`[CircuitBreaker] ${serviceId} 熔斷中 (${Math.ceil(remaining / 1000)}s 後重試). 最後錯誤: ${e.message || '?'}`);
      }
      throw e;
    }
  }

  /**
   * Shutdown all breakers gracefully
   */
  shutdown() {
    for (const [, breaker] of this._breakers) {
      breaker.shutdown();
    }
    this._breakers.clear();
  }
}

// Singleton — drop-in replacement
const _instance = new OpossumBridge();

// Register with graceful shutdown
try {
  const shutdown = require('./GracefulShutdown');
  shutdown.register('CircuitBreakers', () => { _instance.shutdown(); return Promise.resolve(); });
} catch (e) { /* optional */ }

module.exports = _instance;
