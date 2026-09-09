'use strict';

const http = require('http');

// Keep the integrated dashboard separate from the standalone Bridge panel.
const DEFAULT_CONTROL_PORT = 43241;
const MAX_RESPONSE_BYTES = 128 * 1024;
const EDITABLE_LISTS = new Set([
    'deniedHosts',
    'deniedSites',
    'allowedLocalPaths',
]);
const EDITABLE_SETTINGS = new Set([
    'writeEnabled',
    'allowOverwrite',
    'allowRecycle',
]);
const ALLOWED_REQUESTS = new Set([
    'GET /api/policy',
    'POST /api/entries',
    'DELETE /api/entries',
    'PATCH /api/settings',
]);

function resolveControlPort(value = process.env.M365_BRIDGE_CONTROL_PORT) {
    const parsed = Number(value ?? DEFAULT_CONTROL_PORT);
    return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535
        ? parsed
        : DEFAULT_CONTROL_PORT;
}

function sanitizeEntryPayload(payload = {}) {
    const list = String(payload.list || '').trim();
    const value = String(payload.value || '').trim();
    if (!EDITABLE_LISTS.has(list)) {
        throw new Error('Invalid Bridge policy list');
    }
    if (!value || value.length > 4096) {
        throw new Error('Bridge policy value is required and must be at most 4096 characters');
    }
    return { list, value };
}

function sanitizeSettingsPayload(payload = {}) {
    const updates = {};
    for (const [key, value] of Object.entries(payload || {})) {
        if (!EDITABLE_SETTINGS.has(key)) {
            throw new Error(`Unsupported Bridge setting: ${key}`);
        }
        if (typeof value !== 'boolean') {
            throw new Error(`${key} must be boolean`);
        }
        updates[key] = value;
    }
    if (Object.keys(updates).length === 0) {
        throw new Error('At least one Bridge setting is required');
    }
    return updates;
}

function bridgeUnavailable(error) {
    const wrapped = new Error(
        `M365 Session Bridge 管理服務尚未就緒：${error && error.message ? error.message : 'connection failed'}`
    );
    wrapped.code = 'M365_BRIDGE_CONTROL_UNAVAILABLE';
    wrapped.statusCode = 503;
    return wrapped;
}

function requestBridgeControl({ method = 'GET', pathname, body, port = resolveControlPort(), timeoutMs = 5000 }) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const normalizedPath = String(pathname || '');
    if (!ALLOWED_REQUESTS.has(`${normalizedMethod} ${normalizedPath}`)) {
        return Promise.reject(new Error('Unsupported Bridge control request'));
    }

    const encodedBody = body === undefined ? '' : JSON.stringify(body);
    const origin = `http://127.0.0.1:${port}`;

    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port,
            path: normalizedPath,
            method: normalizedMethod,
            headers: {
                accept: 'application/json',
                origin,
                ...(encodedBody ? {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(encodedBody, 'utf8'),
                } : {}),
            },
        }, (response) => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                raw += chunk;
                if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
                    response.destroy(new Error('Bridge control response is too large'));
                }
            });
            response.on('end', () => {
                let parsed = {};
                try {
                    parsed = raw ? JSON.parse(raw) : {};
                } catch {
                    reject(bridgeUnavailable(new Error('Bridge control returned invalid JSON')));
                    return;
                }
                resolve({
                    status: Number(response.statusCode) || 502,
                    body: parsed,
                });
            });
            response.on('error', (error) => reject(bridgeUnavailable(error)));
        });

        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error('Bridge control request timed out'));
        });
        request.on('error', (error) => reject(bridgeUnavailable(error)));
        if (encodedBody) request.write(encodedBody);
        request.end();
    });
}

module.exports = {
    requestBridgeControl,
    resolveControlPort,
    sanitizeEntryPayload,
    sanitizeSettingsPayload,
};
