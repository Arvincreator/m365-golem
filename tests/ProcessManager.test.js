const ProcessManager = require('../src/utils/ProcessManager');

describe('ProcessManager', () => {
    let pm;

    beforeEach(() => {
        pm = new ProcessManager();
    });

    afterEach(async () => {
        await pm.stopAll();
    });

    describe('register()', () => {
        test('registers a process', () => {
            pm.register('test', async () => {});
            const status = pm.status();
            expect(status.test).toBeDefined();
            expect(status.test.status).toBe('registered');
        });
    });

    describe('startAll()', () => {
        test('starts all registered processes', async () => {
            pm.register('a', async () => {});
            pm.register('b', async () => {});
            const results = await pm.startAll();
            expect(results.a).toBe('started');
            expect(results.b).toBe('started');
        });

        test('marks failed processes', async () => {
            pm.register('fail', async () => { throw new Error('boot error'); }, { maxRestarts: 0 });
            const results = await pm.startAll();
            expect(results.fail).toContain('failed');
        });
    });

    describe('status()', () => {
        test('returns status for all processes', async () => {
            pm.register('proc', async () => {});
            await pm.startAll();
            const status = pm.status();
            expect(status.proc.status).toBe('running');
            expect(status.proc.restarts).toBe(0);
            expect(status.proc.uptime).toBeGreaterThanOrEqual(0);
        });
    });

    describe('crash recovery', () => {
        test('auto-restarts on crash', async () => {
            let starts = 0;
            pm.register('crasher', async () => {
                starts++;
                if (starts <= 2) throw new Error('transient');
            }, { maxRestarts: 5, cooldown: 10 });

            await pm.startAll();
            // Wait for restarts
            await new Promise(r => setTimeout(r, 200));
            expect(starts).toBeGreaterThanOrEqual(3);
            expect(pm.status().crasher.status).toBe('running');
        });

        test('gives up after max restarts', async () => {
            pm.register('permanent-fail', async () => {
                throw new Error('always fails');
            }, { maxRestarts: 2, cooldown: 10 });

            await pm.startAll();
            await new Promise(r => setTimeout(r, 200));
            expect(pm.status()['permanent-fail'].status).toBe('dead');
        });
    });

    describe('critical process', () => {
        test('stops all when critical dies', async () => {
            pm.register('important', async () => { throw new Error('fatal'); }, {
                critical: true, maxRestarts: 0, cooldown: 10
            });
            pm.register('helper', async () => {});

            await pm.startAll();
            await new Promise(r => setTimeout(r, 100));

            // Both should be stopped
            const status = pm.status();
            expect(status.helper.status).toBe('stopped');
        });
    });

    describe('onCrash callback', () => {
        test('calls onCrash on failure', async () => {
            const crashes = [];
            pm = new ProcessManager({
                onCrash: (name, error, count) => crashes.push({ name, msg: error.message, count })
            });
            pm.register('notifier', async () => { throw new Error('oops'); }, {
                maxRestarts: 1, cooldown: 10
            });

            await pm.startAll();
            await new Promise(r => setTimeout(r, 100));
            expect(crashes.length).toBeGreaterThan(0);
            expect(crashes[0].name).toBe('notifier');
        });
    });

    describe('restart()', () => {
        test('manually restarts a process', async () => {
            let count = 0;
            pm.register('manual', async () => { count++; });
            await pm.startAll();
            expect(count).toBe(1);
            await pm.restart('manual');
            expect(count).toBe(2);
        });

        test('throws for unknown process', async () => {
            await expect(pm.restart('nonexistent')).rejects.toThrow('not found');
        });
    });
});
