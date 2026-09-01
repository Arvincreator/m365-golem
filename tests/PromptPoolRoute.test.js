const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { installSecurityContext } = require('../web-dashboard/server/security');

async function startPromptPoolServer(registerPromptPoolRoutes) {
    const app = express();
    app.use(express.json());

    const serverContext = {
        app,
        allowRemote: false,
        contexts: new Map(),
    };
    installSecurityContext(serverContext);

    app.use(registerPromptPoolRoutes(serverContext));

    const httpServer = http.createServer(app);
    await new Promise((resolve) => {
        httpServer.listen(0, '127.0.0.1', resolve);
    });

    const addr = httpServer.address();
    return {
        httpServer,
        baseUrl: `http://127.0.0.1:${addr.port}`,
    };
}

async function stopServer(httpServer) {
    if (!httpServer) return;
    await new Promise((resolve) => {
        httpServer.close(() => resolve());
    });
}

async function requestJson(baseUrl, targetPath, init) {
    const response = await fetch(`${baseUrl}${targetPath}`, init);
    let body = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    return {
        status: response.status,
        body,
    };
}

describe('Prompt Pool routes', () => {
    const originalCwd = process.cwd();
    let tempCwd = '';
    let httpServer = null;
    let baseUrl = '';
    let warnSpy = null;

    beforeEach(async () => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-prompt-pool-'));
        process.chdir(tempCwd);

        jest.resetModules();
        const registerPromptPoolRoutes = require('../web-dashboard/routes/api.prompt-pool');
        const started = await startPromptPoolServer(registerPromptPoolRoutes);
        httpServer = started.httpServer;
        baseUrl = started.baseUrl;
    });

    afterEach(async () => {
        await stopServer(httpServer);
        httpServer = null;
        baseUrl = '';

        process.chdir(originalCwd);
        if (tempCwd) {
            fs.rmSync(tempCwd, { recursive: true, force: true });
        }
        tempCwd = '';
        if (warnSpy) {
            warnSpy.mockRestore();
            warnSpy = null;
        }
    });

    test('GET /api/prompt-pool initializes storage and returns empty list', async () => {
        const { status, body } = await requestJson(baseUrl, '/api/prompt-pool');

        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.items).toHaveLength(0);
        expect(Array.isArray(body.topUsedShortcuts)).toBe(true);
        expect(body.topUsedShortcuts).toHaveLength(0);
        expect(Array.isArray(body.topUsedShortcuts7d)).toBe(true);
        expect(body.topUsedShortcuts7d).toHaveLength(0);
        expect(Array.isArray(body.topUsedShortcuts30d)).toBe(true);
        expect(body.topUsedShortcuts30d).toHaveLength(0);
        expect(Array.isArray(body.usageTrend14d)).toBe(true);
        expect(body.usageTrend14d).toHaveLength(14);
        expect(body.usageTrend14d.every((item) => Number(item.count || 0) === 0)).toBe(true);
        expect(Array.isArray(body.legacyConflicts)).toBe(true);
        expect(body.legacyConflicts).toHaveLength(0);
        expect(body.hasLegacyConflicts).toBe(false);

        const promptPoolPath = path.join(tempCwd, 'data', 'dashboard', 'prompt-pool.json');
        expect(fs.existsSync(promptPoolPath)).toBe(true);
        expect(fs.readFileSync(promptPoolPath, 'utf8').trim()).toBe('[]');
    });

    test('supports create, update, and delete lifecycle', async () => {
        const createRes = await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/my_weekly',
                prompt: '請幫我產出本週重點摘要',
                note: '每週例行',
            }),
        });

        expect(createRes.status).toBe(200);
        expect(createRes.body.success).toBe(true);
        expect(createRes.body.item.shortcut).toBe('/my_weekly');
        const createdId = createRes.body.item.id;
        expect(typeof createdId).toBe('string');

        const updateRes = await requestJson(baseUrl, `/api/prompt-pool/${encodeURIComponent(createdId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/my_weekly_v2',
                prompt: '請幫我產出本週重點摘要並列出下週風險',
                note: '每週例行 v2',
            }),
        });

        expect(updateRes.status).toBe(200);
        expect(updateRes.body.success).toBe(true);
        expect(updateRes.body.item.shortcut).toBe('/my_weekly_v2');

        const deleteRes = await requestJson(baseUrl, `/api/prompt-pool/${encodeURIComponent(createdId)}`, {
            method: 'DELETE',
        });

        expect(deleteRes.status).toBe(200);
        expect(deleteRes.body.success).toBe(true);
        expect(Array.isArray(deleteRes.body.items)).toBe(true);
        expect(deleteRes.body.items).toHaveLength(0);

        const auditRes = await requestJson(baseUrl, '/api/prompt-pool/audit?limit=10');
        expect(auditRes.status).toBe(200);
        expect(auditRes.body.success).toBe(true);
        expect(Array.isArray(auditRes.body.records)).toBe(true);
        const events = auditRes.body.records.map((record) => record.event);
        expect(events).toContain('prompt_pool_create');
        expect(events).toContain('prompt_pool_update');
        expect(events).toContain('prompt_pool_delete');
    });

    test('rejects shortcuts that conflict with reserved system commands', async () => {
        const createRes = await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/new',
                prompt: '請清理並重置對話',
                note: '應該被拒絕',
            }),
        });

        expect(createRes.status).toBe(409);
        expect(createRes.body.error).toContain('系統指令');
    });

    test('rejects shortcuts that conflict with reserved system commands even without slash', async () => {
        const createRes = await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: 'new',
                prompt: '請清理並重置對話',
                note: '應該被拒絕',
            }),
        });

        expect(createRes.status).toBe(409);
        expect(createRes.body.error).toContain('系統指令');
    });

    test('treats /shortcut and shortcut as duplicate commands', async () => {
        const first = await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/weekly',
                prompt: 'first',
                note: '',
            }),
        });
        expect(first.status).toBe(200);

        const second = await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: 'weekly',
                prompt: 'second',
                note: '',
            }),
        });
        expect(second.status).toBe(409);
        expect(second.body.error).toContain('快捷指令已存在');
    });

    test('quarantines corrupted prompt pool file and self-heals to empty list', async () => {
        const poolDir = path.join(tempCwd, 'data', 'dashboard');
        const poolPath = path.join(poolDir, 'prompt-pool.json');
        fs.mkdirSync(poolDir, { recursive: true });
        fs.writeFileSync(poolPath, '{ invalid-json', 'utf8');

        const res = await requestJson(baseUrl, '/api/prompt-pool');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.items).toEqual([]);

        const files = fs.readdirSync(poolDir);
        const hasBackup = files.some((name) => name.startsWith('prompt-pool.json.corrupt.'));
        expect(hasBackup).toBe(true);
        expect(fs.readFileSync(poolPath, 'utf8').trim()).toBe('[]');
    });

    test('reports legacy conflicts for reserved shortcuts from old data', async () => {
        const poolDir = path.join(tempCwd, 'data', 'dashboard');
        const poolPath = path.join(poolDir, 'prompt-pool.json');
        fs.mkdirSync(poolDir, { recursive: true });
        fs.writeFileSync(poolPath, JSON.stringify([
            {
                id: 'legacy_1',
                shortcut: '/new',
                prompt: 'legacy prompt',
                note: 'legacy',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                id: 'legacy_2',
                shortcut: '/my_custom',
                prompt: 'ok',
                note: '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ], null, 2), 'utf8');

        const { status, body } = await requestJson(baseUrl, '/api/prompt-pool');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.hasLegacyConflicts).toBe(true);
        expect(Array.isArray(body.legacyConflicts)).toBe(true);
        expect(body.legacyConflicts).toHaveLength(1);
        expect(body.legacyConflicts[0]).toMatchObject({
            id: 'legacy_1',
            shortcut: '/new',
            reason: 'reserved_system_command',
        });
    });

    test('repair-conflicts endpoint fixes reserved and duplicate shortcuts', async () => {
        const poolDir = path.join(tempCwd, 'data', 'dashboard');
        const poolPath = path.join(poolDir, 'prompt-pool.json');
        fs.mkdirSync(poolDir, { recursive: true });
        fs.writeFileSync(poolPath, JSON.stringify([
            {
                id: 'legacy_reserved',
                shortcut: '/new',
                prompt: 'legacy reserved',
                note: '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                id: 'legacy_dup_1',
                shortcut: '/dupe',
                prompt: 'duplicate 1',
                note: '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                id: 'legacy_dup_2',
                shortcut: '/dupe',
                prompt: 'duplicate 2',
                note: '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ], null, 2), 'utf8');

        const repairRes = await requestJson(baseUrl, '/api/prompt-pool/repair-conflicts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });

        expect(repairRes.status).toBe(200);
        expect(repairRes.body.success).toBe(true);
        expect(repairRes.body.repairedCount).toBeGreaterThanOrEqual(2);
        expect(Array.isArray(repairRes.body.repaired)).toBe(true);
        expect(repairRes.body.hasLegacyConflicts).toBe(false);
        expect(repairRes.body.legacyConflicts).toEqual([]);

        const items = Array.isArray(repairRes.body.items) ? repairRes.body.items : [];
        const shortcuts = items.map((item) => item.shortcut);
        expect(shortcuts).not.toContain('/new');
        const uniqueShortcuts = new Set(shortcuts.map((shortcut) => String(shortcut).toLowerCase()));
        expect(uniqueShortcuts.size).toBe(shortcuts.length);

        const auditRes = await requestJson(baseUrl, '/api/prompt-pool/audit?limit=5');
        expect(auditRes.status).toBe(200);
        expect(auditRes.body.success).toBe(true);
        expect(Array.isArray(auditRes.body.records)).toBe(true);
        expect(auditRes.body.records[0].event).toBe('prompt_pool_repair_conflicts');
        expect(auditRes.body.records[0].details.repairedCount).toBeGreaterThanOrEqual(2);
    });

    test('tracks shortcut usage and exposes recent usage ranking', async () => {
        const createRes = await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/weekly',
                prompt: 'weekly prompt',
                note: '每週摘要',
            }),
        });
        expect(createRes.status).toBe(200);

        const track1 = await requestJson(baseUrl, '/api/prompt-pool/track-use', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/weekly',
                source: 'telegram',
                platform: 'telegram',
            }),
        });
        expect(track1.status).toBe(200);
        expect(track1.body.success).toBe(true);

        const track2 = await requestJson(baseUrl, '/api/prompt-pool/track-use', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/weekly@golem_a',
                source: 'web_dashboard',
                platform: 'web',
            }),
        });
        expect(track2.status).toBe(200);
        expect(track2.body.success).toBe(true);

        const poolRes = await requestJson(baseUrl, '/api/prompt-pool');
        expect(poolRes.status).toBe(200);
        expect(poolRes.body.success).toBe(true);
        expect(Array.isArray(poolRes.body.items)).toBe(true);
        expect(Array.isArray(poolRes.body.topUsedShortcuts)).toBe(true);
        expect(Array.isArray(poolRes.body.topUsedShortcuts7d)).toBe(true);
        expect(Array.isArray(poolRes.body.topUsedShortcuts30d)).toBe(true);
        expect(Array.isArray(poolRes.body.usageTrend14d)).toBe(true);
        expect(poolRes.body.usageTrend14d).toHaveLength(14);

        const weekly = poolRes.body.items.find((item) => item.shortcut === '/weekly');
        expect(weekly).toBeTruthy();
        expect(weekly.recentUseCount).toBe(2);
        expect(typeof weekly.lastUsedAt).toBe('string');
        expect(weekly.lastUsedAt.length).toBeGreaterThan(0);

        expect(poolRes.body.topUsedShortcuts[0]).toMatchObject({
            shortcut: '/weekly',
            recentUseCount: 2,
        });
        expect(poolRes.body.topUsedShortcuts7d[0]).toMatchObject({
            shortcut: '/weekly',
            recentUseCount: 2,
        });
        expect(poolRes.body.topUsedShortcuts30d[0]).toMatchObject({
            shortcut: '/weekly',
            recentUseCount: 2,
        });
        const trendTotal = poolRes.body.usageTrend14d.reduce((sum, item) => sum + Number(item.count || 0), 0);
        expect(trendTotal).toBeGreaterThanOrEqual(2);
    });

    test('windowed ranking excludes usage older than 7d and 30d', async () => {
        const now = Date.now();
        const oldTs = new Date(now - (45 * 24 * 60 * 60 * 1000)).toISOString();
        const ts10d = new Date(now - (10 * 24 * 60 * 60 * 1000)).toISOString();
        const ts2d = new Date(now - (2 * 24 * 60 * 60 * 1000)).toISOString();

        await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/old_cmd',
                prompt: 'old',
                note: 'old',
            }),
        });
        await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/mid_cmd',
                prompt: 'mid',
                note: 'mid',
            }),
        });
        await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/new_cmd',
                prompt: 'new',
                note: 'new',
            }),
        });

        const auditPath = path.join(tempCwd, 'logs', 'prompt-pool-audit.log');
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.appendFileSync(auditPath, `${JSON.stringify({
            ts: oldTs,
            event: 'prompt_pool_use',
            details: { shortcut: '/old_cmd', shortcutKey: 'old_cmd', source: 'test', platform: 'test' },
        })}\n`);
        fs.appendFileSync(auditPath, `${JSON.stringify({
            ts: ts10d,
            event: 'prompt_pool_use',
            details: { shortcut: '/mid_cmd', shortcutKey: 'mid_cmd', source: 'test', platform: 'test' },
        })}\n`);
        fs.appendFileSync(auditPath, `${JSON.stringify({
            ts: ts2d,
            event: 'prompt_pool_use',
            details: { shortcut: '/new_cmd', shortcutKey: 'new_cmd', source: 'test', platform: 'test' },
        })}\n`);

        const res = await requestJson(baseUrl, '/api/prompt-pool');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const allShortcuts = res.body.topUsedShortcuts.map((item) => item.shortcut);
        expect(allShortcuts).toEqual(expect.arrayContaining(['/old_cmd', '/mid_cmd', '/new_cmd']));

        const shortcuts30d = res.body.topUsedShortcuts30d.map((item) => item.shortcut);
        expect(shortcuts30d).toContain('/new_cmd');
        expect(shortcuts30d).toContain('/mid_cmd');
        expect(shortcuts30d).not.toContain('/old_cmd');

        const shortcuts7d = res.body.topUsedShortcuts7d.map((item) => item.shortcut);
        expect(shortcuts7d).toContain('/new_cmd');
        expect(shortcuts7d).not.toContain('/mid_cmd');
        expect(shortcuts7d).not.toContain('/old_cmd');

        expect(Array.isArray(res.body.usageTrend14d)).toBe(true);
        expect(res.body.usageTrend14d).toHaveLength(14);
        const trendTotal = res.body.usageTrend14d.reduce((sum, item) => sum + Number(item.count || 0), 0);
        expect(trendTotal).toBe(2);
    });

    test('usage-trend endpoint returns per-shortcut curve and validates unknown shortcut', async () => {
        await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/alpha',
                prompt: 'alpha',
                note: 'alpha',
            }),
        });
        await requestJson(baseUrl, '/api/prompt-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shortcut: '/beta',
                prompt: 'beta',
                note: 'beta',
            }),
        });

        const now = Date.now();
        const ts1 = new Date(now - (1 * 24 * 60 * 60 * 1000)).toISOString();
        const ts2 = new Date(now - (2 * 24 * 60 * 60 * 1000)).toISOString();
        const ts3 = new Date(now - (1 * 24 * 60 * 60 * 1000)).toISOString();
        const auditPath = path.join(tempCwd, 'logs', 'prompt-pool-audit.log');
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.appendFileSync(auditPath, `${JSON.stringify({
            ts: ts1,
            event: 'prompt_pool_use',
            details: { shortcut: '/alpha', shortcutKey: 'alpha', source: 'test', platform: 'test' },
        })}\n`);
        fs.appendFileSync(auditPath, `${JSON.stringify({
            ts: ts2,
            event: 'prompt_pool_use',
            details: { shortcut: '/alpha', shortcutKey: 'alpha', source: 'test', platform: 'test' },
        })}\n`);
        fs.appendFileSync(auditPath, `${JSON.stringify({
            ts: ts3,
            event: 'prompt_pool_use',
            details: { shortcut: '/beta', shortcutKey: 'beta', source: 'test', platform: 'test' },
        })}\n`);

        const alphaRes = await requestJson(baseUrl, `/api/prompt-pool/usage-trend?shortcut=${encodeURIComponent('/alpha')}&days=14`);
        expect(alphaRes.status).toBe(200);
        expect(alphaRes.body.success).toBe(true);
        expect(alphaRes.body.shortcut).toBe('/alpha');
        expect(alphaRes.body.days).toBe(14);
        expect(Array.isArray(alphaRes.body.trend)).toBe(true);
        expect(alphaRes.body.trend).toHaveLength(14);
        expect(alphaRes.body.totalUseCount).toBe(2);
        expect(alphaRes.body.peakDailyUse).toBeGreaterThanOrEqual(1);
        expect(alphaRes.body.averagePerDay).toBeGreaterThan(0);

        const unknownRes = await requestJson(baseUrl, `/api/prompt-pool/usage-trend?shortcut=${encodeURIComponent('/unknown')}&days=14`);
        expect(unknownRes.status).toBe(404);
        expect(unknownRes.body.error).toContain('not found');
    });
});
