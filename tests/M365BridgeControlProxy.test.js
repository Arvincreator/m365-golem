'use strict';

const http = require('http');
const {
    requestBridgeControl,
    resolveControlPort,
    sanitizeEntryPayload,
    sanitizeSettingsPayload,
} = require('../web-dashboard/server/m365BridgeControlProxy');

describe('M365 Bridge dashboard control proxy', () => {
    test('accepts only the fixed editable policy surface', () => {
        expect(sanitizeEntryPayload({ list: 'deniedHosts', value: 'blocked.sharepoint.com' }))
            .toEqual({ list: 'deniedHosts', value: 'blocked.sharepoint.com' });
        expect(() => sanitizeEntryPayload({ list: 'allowedHosts', value: 'tenant.sharepoint.com' })).toThrow('Invalid Bridge policy list');
        expect(() => sanitizeEntryPayload({ list: 'allowPermanentDelete', value: 'true' })).toThrow('Invalid Bridge policy list');
        expect(sanitizeSettingsPayload({ writeEnabled: true, allowOverwrite: false }))
            .toEqual({ writeEnabled: true, allowOverwrite: false });
        expect(() => sanitizeSettingsPayload({ allowPermanentDelete: true })).toThrow('Unsupported Bridge setting');
        expect(resolveControlPort('not-a-port')).toBe(43241);
    });

    test('proxies only to the loopback Bridge API with its exact local Origin', async () => {
        let observed = null;
        const bridge = http.createServer((req, res) => {
            let raw = '';
            req.setEncoding('utf8');
            req.on('data', (chunk) => { raw += chunk; });
            req.on('end', () => {
                observed = {
                    method: req.method,
                    url: req.url,
                    origin: req.headers.origin,
                    body: raw ? JSON.parse(raw) : null,
                };
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ writeEnabled: true }));
            });
        });
        await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
        const port = bridge.address().port;

        try {
            const result = await requestBridgeControl({
                method: 'PATCH',
                pathname: '/api/settings',
                body: { writeEnabled: true },
                port,
            });
            expect(result).toEqual({ status: 200, body: { writeEnabled: true } });
            expect(observed).toEqual({
                method: 'PATCH',
                url: '/api/settings',
                origin: `http://127.0.0.1:${port}`,
                body: { writeEnabled: true },
            });
            await expect(requestBridgeControl({ method: 'GET', pathname: '/not-allowed', port }))
                .rejects.toThrow('Unsupported Bridge control request');
        } finally {
            await new Promise((resolve) => bridge.close(resolve));
        }
    });
});
