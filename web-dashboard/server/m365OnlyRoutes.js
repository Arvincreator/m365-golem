'use strict';

const ConfigManager = require('../../src/config');

function isM365OnlyMode() {
    return ConfigManager.CONFIG.GOLEM_BACKEND === 'm365-web';
}

const RETIRED_M365_API_PREFIXES = Object.freeze([
    '/api/rpg',
    '/api/stocks',
    '/api/crypto',
    '/api/diary',
]);

function isRetiredM365ApiRequest(pathValue) {
    const requestPath = String(pathValue || '').replace(/\/+$/, '') || '/';
    return RETIRED_M365_API_PREFIXES.some((prefix) => (
        requestPath === prefix || requestPath.startsWith(`${prefix}/`)
    ));
}

function isAllowedM365ApiRequest(methodValue, pathValue) {
    void methodValue;
    return !isRetiredM365ApiRequest(pathValue);
}

function buildM365OnlyApiGuard() {
    return (req, res, next) => {
        if (!isM365OnlyMode() || !String(req.path || '').startsWith('/api/')) return next();
        if (req.method === 'OPTIONS' || isAllowedM365ApiRequest(req.method, req.path)) return next();
        return res.status(404).json({
            success: false,
            error: 'M365_FEATURE_DISABLED',
            message: 'This retired module is not available in the M365 edition.',
        });
    };
}

module.exports = {
    buildM365OnlyApiGuard,
    isAllowedM365ApiRequest,
    isM365OnlyMode,
    isRetiredM365ApiRequest,
    RETIRED_M365_API_PREFIXES,
};
