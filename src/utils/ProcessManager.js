/**
 * ProcessManager — Crash recovery and auto-restart for Golem subsystems
 *
 * Monitors critical processes (brain, memory, dashboard) and automatically
 * restarts them on failure with configurable policies.
 *
 * @example
 *   const pm = new ProcessManager();
 *   pm.register('brain', () => brain.init(), { maxRestarts: 5, cooldown: 5000 });
 *   pm.register('memory', () => memory.init(), { maxRestarts: 3 });
 *   await pm.startAll();
 */

class ProcessManager {
    constructor(options = {}) {
        this._processes = new Map();
        this._running = false;
        this._globalMaxRestarts = options.maxRestarts || 10;
        this._globalCooldown = options.cooldown || 3000;
        this._onCrash = options.onCrash || null;
    }

    /**
     * Register a managed process
     * @param {string} name - Process identifier
     * @param {function} startFn - Async function to start the process
     * @param {object} options
     * @param {number} options.maxRestarts - Max restart attempts before giving up (default: 5)
     * @param {number} options.cooldown - Delay between restarts in ms (default: 3000)
     * @param {boolean} options.critical - If true, all processes stop when this one dies (default: false)
     * @param {function} options.healthCheck - Optional health check function
     * @param {number} options.healthInterval - Health check interval in ms (default: 60000)
     */
    register(name, startFn, options = {}) {
        this._processes.set(name, {
            name,
            startFn,
            maxRestarts: options.maxRestarts ?? 5,
            cooldown: options.cooldown ?? this._globalCooldown,
            critical: options.critical ?? false,
            healthCheck: options.healthCheck || null,
            healthInterval: options.healthInterval || 60000,
            // Runtime state
            restartCount: 0,
            status: 'registered', // registered, running, crashed, stopped, dead
            lastStart: null,
            lastCrash: null,
            crashLog: [],
            healthTimer: null,
        });
    }

    /**
     * Start all registered processes
     */
    async startAll() {
        this._running = true;
        const results = {};

        for (const [name, proc] of this._processes) {
            if (!this._running) break; // Stop if shutdown was triggered (e.g. critical process died)
            try {
                await this._startProcess(proc);
                results[name] = proc.status === 'running' ? 'started' : `failed: ${proc.status}`;
            } catch (e) {
                results[name] = `failed: ${e.message}`;
            }
        }

        return results;
    }

    /**
     * Stop all processes
     */
    async stopAll() {
        this._running = false;
        for (const proc of this._processes.values()) {
            proc.status = 'stopped';
            if (proc.healthTimer) {
                clearInterval(proc.healthTimer);
                proc.healthTimer = null;
            }
        }
    }

    /**
     * Get status of all processes
     */
    status() {
        const result = {};
        for (const [name, proc] of this._processes) {
            result[name] = {
                status: proc.status,
                restarts: proc.restartCount,
                maxRestarts: proc.maxRestarts,
                lastStart: proc.lastStart ? new Date(proc.lastStart).toISOString() : null,
                lastCrash: proc.lastCrash ? new Date(proc.lastCrash).toISOString() : null,
                uptime: proc.status === 'running' && proc.lastStart
                    ? Math.round((Date.now() - proc.lastStart) / 1000)
                    : 0,
                recentErrors: proc.crashLog.slice(-3).map(e => e.message),
            };
        }
        return result;
    }

    /**
     * Manually restart a specific process
     */
    async restart(name) {
        const proc = this._processes.get(name);
        if (!proc) throw new Error(`Process "${name}" not found`);
        proc.restartCount = 0; // Reset counter on manual restart
        await this._startProcess(proc);
    }

    // --- Internal ---

    async _startProcess(proc) {
        try {
            proc.status = 'starting';
            proc.lastStart = Date.now();
            console.log(`🟢 [PM:${proc.name}] Starting...`);

            await proc.startFn();

            proc.status = 'running';
            console.log(`✅ [PM:${proc.name}] Started successfully`);

            // Set up health check if configured
            if (proc.healthCheck && proc.healthInterval > 0) {
                this._setupHealthCheck(proc);
            }
        } catch (error) {
            await this._handleCrash(proc, error);
        }
    }

    async _handleCrash(proc, error) {
        proc.status = 'crashed';
        proc.lastCrash = Date.now();
        proc.restartCount++;
        proc.crashLog.push({
            time: new Date().toISOString(),
            message: error.message,
            attempt: proc.restartCount,
        });

        // Keep only last 10 crash logs
        if (proc.crashLog.length > 10) {
            proc.crashLog = proc.crashLog.slice(-10);
        }

        console.error(`💥 [PM:${proc.name}] Crashed (${proc.restartCount}/${proc.maxRestarts}): ${error.message}`);

        // Notify crash handler
        if (this._onCrash) {
            try {
                this._onCrash(proc.name, error, proc.restartCount);
            } catch (e) {
                // Don't let callback errors break the manager
            }
        }

        // Check if critical process
        if (proc.critical) {
            console.error(`🚨 [PM:${proc.name}] CRITICAL process died. Stopping all processes.`);
            await this.stopAll();
            return;
        }

        // Check restart limit
        if (proc.restartCount >= proc.maxRestarts) {
            proc.status = 'dead';
            console.error(`☠️ [PM:${proc.name}] Max restarts (${proc.maxRestarts}) reached. Giving up.`);
            return;
        }

        // Auto-restart after cooldown
        if (this._running) {
            const delay = proc.cooldown * Math.min(proc.restartCount, 5); // Linear backoff, capped at 5x
            console.log(`🔄 [PM:${proc.name}] Restarting in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));

            if (this._running && proc.status === 'crashed') {
                await this._startProcess(proc);
            }
        }
    }

    _setupHealthCheck(proc) {
        if (proc.healthTimer) clearInterval(proc.healthTimer);

        proc.healthTimer = setInterval(async () => {
            if (proc.status !== 'running') return;

            try {
                const healthy = await proc.healthCheck();
                if (!healthy) {
                    console.warn(`⚠️ [PM:${proc.name}] Health check failed`);
                    await this._handleCrash(proc, new Error('Health check failed'));
                }
            } catch (e) {
                console.warn(`⚠️ [PM:${proc.name}] Health check error: ${e.message}`);
                await this._handleCrash(proc, e);
            }
        }, proc.healthInterval);
    }
}

module.exports = ProcessManager;
