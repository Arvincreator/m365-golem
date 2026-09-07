const express = require('express');
const { buildOperationGuard } = require('../server/security');
const {
    requestBridgeControl,
    sanitizeEntryPayload,
    sanitizeSettingsPayload,
} = require('../server/m365BridgeControlProxy');

module.exports = function registerMcpRoutes(server) {
    const router = express.Router();
    const requireMcpWrite = buildOperationGuard(server, 'mcp_write');

    const sendBridgeResponse = (res, result) => {
        const status = Number.isInteger(result && result.status) ? result.status : 502;
        return res.status(status >= 200 && status <= 599 ? status : 502).json(result && result.body ? result.body : {});
    };

    const sendBridgeError = (res, error) => {
        const status = Number.isInteger(error && error.statusCode) ? error.statusCode : 400;
        return res.status(status).json({
            error: error && error.code ? error.code : 'M365_BRIDGE_POLICY_INVALID',
            message: error && error.message ? error.message : 'Bridge policy request failed',
        });
    };

    const sanitizeServerName = (name) => {
        const cleaned = String(name || '').trim();
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(cleaned)) {
            throw new Error('Invalid server name');
        }
        return cleaned;
    };

    const sanitizeServerPayload = (payload = {}) => {
        const defaultAllowed = process.platform === 'win32'
            ? 'npx,node,codex,uv,python3,python,bash,sh,cmd,cmd.exe'
            : 'npx,node,codex,uv,python3,python,bash,sh';
        const allowedCmdsRaw = String(
            process.env.MCP_ALLOWED_COMMANDS || defaultAllowed
        );
        const allowedCmds = new Set(
            allowedCmdsRaw
                .split(',')
                .map((x) => x.trim())
                .filter((x) => x)
        );

        const command = String(payload.command || '').trim();
        if (!allowedCmds.has(command)) {
            throw new Error(`Command not allowed: ${command || '(empty)'}`);
        }

        const args = Array.isArray(payload.args) ? payload.args.slice(0, 20).map((x) => String(x)) : [];
        const envRaw = payload.env && typeof payload.env === 'object' ? payload.env : {};
        const env = {};
        for (const [k, v] of Object.entries(envRaw)) {
            if (/^[A-Z_][A-Z0-9_]{0,63}$/.test(k)) {
                env[k] = String(v).slice(0, 2048);
            }
        }

        const timeoutRaw = Number(payload.timeout);
        const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0
            ? Math.min(Math.max(Math.round(timeoutRaw), 1000), 600000)
            : 30000;

        return {
            name: sanitizeServerName(payload.name),
            command,
            args,
            env,
            timeout,
            enabled: payload.enabled !== false,
            description: String(payload.description || '').slice(0, 500),
        };
    };

    const getMCPManager = async () => {
        const MCPManager = require('../../src/mcp/MCPManager');
        const mgr = MCPManager.getInstance();

        if (!mgr._loaded) {
            if (!mgr._broadcastWired) {
                mgr._broadcastWired = true;
                mgr.on('mcpLog', (entry) => {
                    const preview = entry.success
                        ? JSON.stringify(entry.result || '').slice(0, 120)
                        : `ERROR: ${entry.error}`;

                    server.broadcastLog({
                        time: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
                        msg: `[MCP] ${entry.server}/${entry.tool} (${entry.durationMs}ms) ${entry.success ? '✅' : '❌'} ${preview}`,
                        type: 'mcp',
                        raw: JSON.stringify(entry),
                        mcpEntry: entry
                    });
                });
            }
            await mgr.load();
        }

        return mgr;
    };

    const triggerToolVectorSync = async () => {
        const jobs = [];
        const seen = new Set();
        const enqueue = (brain) => {
            if (!brain || typeof brain._syncToolVectorIndex !== 'function') return;
            if (seen.has(brain)) return;
            seen.add(brain);
            jobs.push(
                Promise.resolve()
                    .then(() => brain._syncToolVectorIndex())
                    .catch((e) => console.warn('[MCP] ToolVector sync failed:', e.message))
            );
        };

        // Dashboard-managed contexts
        if (server && server.contexts && typeof server.contexts.values === 'function') {
            for (const instance of server.contexts.values()) {
                enqueue(instance && instance.brain ? instance.brain : null);
            }
        }

        // Runtime singleton (single-golem edition)
        try {
            const getOrCreate = (typeof global.getOrCreateGolem === 'function')
                ? global.getOrCreateGolem
                : require('../../apps/runtime/index').getOrCreateGolem;
            const singleton = typeof getOrCreate === 'function' ? getOrCreate() : null;
            enqueue(singleton && singleton.brain ? singleton.brain : null);
        } catch (_) { /* optional */ }

        await Promise.allSettled(jobs);
        return jobs.length;
    };

    router.get('/api/mcp/servers', async (req, res) => {
        try {
            const mgr = await getMCPManager();
            return res.json({ servers: mgr.getServers() });
        } catch (e) {
            console.error('[MCP] List servers error:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.get('/api/mcp/bridge/policy', async (req, res) => {
        try {
            return sendBridgeResponse(res, await requestBridgeControl({
                method: 'GET',
                pathname: '/api/policy',
            }));
        } catch (error) {
            return sendBridgeError(res, error);
        }
    });

    router.patch('/api/mcp/bridge/settings', requireMcpWrite, async (req, res) => {
        try {
            const body = sanitizeSettingsPayload(req.body);
            return sendBridgeResponse(res, await requestBridgeControl({
                method: 'PATCH',
                pathname: '/api/settings',
                body,
            }));
        } catch (error) {
            return sendBridgeError(res, error);
        }
    });

    router.post('/api/mcp/bridge/entries', requireMcpWrite, async (req, res) => {
        try {
            const body = sanitizeEntryPayload(req.body);
            return sendBridgeResponse(res, await requestBridgeControl({
                method: 'POST',
                pathname: '/api/entries',
                body,
            }));
        } catch (error) {
            return sendBridgeError(res, error);
        }
    });

    router.delete('/api/mcp/bridge/entries', requireMcpWrite, async (req, res) => {
        try {
            const body = sanitizeEntryPayload(req.body);
            return sendBridgeResponse(res, await requestBridgeControl({
                method: 'DELETE',
                pathname: '/api/entries',
                body,
            }));
        } catch (error) {
            return sendBridgeError(res, error);
        }
    });

    router.post('/api/mcp/servers', requireMcpWrite, async (req, res) => {
        try {
            const payload = sanitizeServerPayload(req.body);

            const mgr = await getMCPManager();
            const entry = await mgr.addServer(payload);
            void triggerToolVectorSync();
            console.log(`[MCP] Added server: ${payload.name}`);
            return res.json({ success: true, server: entry });
        } catch (e) {
            console.error('[MCP] Add server error:', e);
            const status = /Invalid|not allowed|Missing/i.test(e.message) ? 400 : 500;
            return res.status(status).json({ error: e.message });
        }
    });

    router.put('/api/mcp/servers/:name', requireMcpWrite, async (req, res) => {
        try {
            const name = sanitizeServerName(req.params.name);
            const mgr = await getMCPManager();
            const existing = mgr.getServer(name);
            if (!existing) {
                return res.status(404).json({ error: `MCP server "${name}" not found` });
            }

            const merged = sanitizeServerPayload({
                ...existing,
                ...req.body,
                name: req.body.name !== undefined ? req.body.name : existing.name,
            });

            const entry = await mgr.updateServer(name, merged);
            void triggerToolVectorSync();
            console.log(`[MCP] Updated server: ${name}`);
            return res.json({ success: true, server: entry });
        } catch (e) {
            console.error('[MCP] Update server error:', e);
            const status = /Invalid|not allowed|Missing/i.test(e.message) ? 400 : 500;
            return res.status(status).json({ error: e.message });
        }
    });

    router.delete('/api/mcp/servers/:name', requireMcpWrite, async (req, res) => {
        try {
            const name = sanitizeServerName(req.params.name);
            const mgr = await getMCPManager();
            await mgr.removeServer(name);
            void triggerToolVectorSync();
            console.log(`[MCP] Removed server: ${name}`);
            return res.json({ success: true });
        } catch (e) {
            console.error('[MCP] Remove server error:', e);
            const status = /Invalid/i.test(e.message) ? 400 : 500;
            return res.status(status).json({ error: e.message });
        }
    });

    router.post('/api/mcp/servers/:name/toggle', requireMcpWrite, async (req, res) => {
        try {
            const name = sanitizeServerName(req.params.name);
            const { enabled } = req.body;
            const mgr = await getMCPManager();
            const entry = await mgr.toggleServer(name, Boolean(enabled));
            void triggerToolVectorSync();
            return res.json({ success: true, server: entry });
        } catch (e) {
            console.error('[MCP] Toggle server error:', e);
            const status = /Invalid/i.test(e.message) ? 400 : 500;
            return res.status(status).json({ error: e.message });
        }
    });

    router.get('/api/mcp/servers/:name/tools', async (req, res) => {
        try {
            const name = sanitizeServerName(req.params.name);
            const mgr = await getMCPManager();
            const tools = await mgr.listTools(name);
            return res.json({ tools });
        } catch (e) {
            console.error('[MCP] List tools error:', e);
            const status = /Invalid/i.test(e.message) ? 400 : 500;
            return res.status(status).json({ error: e.message });
        }
    });

    router.get('/api/mcp/catalog', async (req, res) => {
        try {
            const mgr = await getMCPManager();
            return res.json(mgr.getToolCatalog());
        } catch (e) {
            console.error('[MCP] Catalog error:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/api/mcp/servers/:name/test', requireMcpWrite, async (req, res) => {
        try {
            const name = sanitizeServerName(req.params.name);
            const mgr = await getMCPManager();
            const result = await mgr.testServer(name);
            return res.json(result);
        } catch (e) {
            console.error('[MCP] Test server error:', e);
            const status = /Invalid/i.test(e.message) ? 400 : 500;
            return res.status(status).json({ success: false, error: e.message });
        }
    });

    router.get('/api/mcp/logs', async (req, res) => {
        try {
            const limit = Math.min(Number(req.query.limit) || 100, 500);
            const mgr = await getMCPManager();
            return res.json({ logs: mgr.getLogs(limit) });
        } catch (e) {
            console.error('[MCP] Get logs error:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    return router;
};
