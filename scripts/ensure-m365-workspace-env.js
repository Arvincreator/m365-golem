'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseEnv(content) {
    const values = {};
    String(content || '').split(/\r\n|\n|\r/).forEach((line) => {
        const match = line.match(/^\s*([^#=\s]+)=(.*)$/);
        if (!match) return;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        values[match[1]] = value;
    });
    return values;
}

function upsertEnv(content, key, value) {
    const safeValue = String(value).replace(/[\r\n]/g, '');
    const newline = String(content).includes('\r\n') ? '\r\n' : '\n';
    const expression = new RegExp(`^\\s*${key}=.*$`, 'm');
    if (expression.test(content)) return content.replace(expression, `${key}=${safeValue}`);
    const separator = content && !content.endsWith('\n') && !content.endsWith('\r') ? newline : '';
    return `${content}${separator}${key}=${safeValue}${newline}`;
}

function isValidEncryptionKey(rawValue) {
    const value = String(rawValue || '').trim();
    if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
    try {
        return Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value;
    } catch (_) {
        return false;
    }
}

function ensureM365WorkspaceEnv(options = {}) {
    const rootDir = path.resolve(options.rootDir || process.cwd());
    const envPath = path.resolve(rootDir, options.envFile || '.env');
    const templatePath = path.resolve(rootDir, options.templateFile || 'M365-POC.env.example');

    if (!fs.existsSync(envPath)) {
        if (!fs.existsSync(templatePath)) throw new Error('M365_ENV_TEMPLATE_MISSING');
        fs.copyFileSync(templatePath, envPath);
    }

    let content = fs.readFileSync(envPath, 'utf8');
    let values = parseEnv(content);
    if (values.GOLEM_BACKEND !== 'm365-web') throw new Error('M365_BACKEND_REQUIRED');

    if (!Object.prototype.hasOwnProperty.call(values, 'M365_WORKSPACE_ENABLED')) {
        content = upsertEnv(content, 'M365_WORKSPACE_ENABLED', 'true');
    }
    if (!Object.prototype.hasOwnProperty.call(values, 'M365_RUNNER_ENABLED')) {
        content = upsertEnv(content, 'M365_RUNNER_ENABLED', 'true');
    }

    values = parseEnv(content);
    const existingKey = values.M365_DATA_ENCRYPTION_KEY || '';
    if (!existingKey) {
        const configuredDbPath = values.M365_WORKSPACE_DB_PATH || 'data/m365-workspace.sqlite';
        const resolvedDbPath = path.isAbsolute(configuredDbPath)
            ? configuredDbPath
            : path.resolve(rootDir, configuredDbPath);
        if (fs.existsSync(resolvedDbPath)) throw new Error('M365_ENCRYPTION_KEY_MISSING_FOR_EXISTING_DATABASE');
        content = upsertEnv(content, 'M365_DATA_ENCRYPTION_KEY', crypto.randomBytes(32).toString('base64'));
    } else if (!isValidEncryptionKey(existingKey)) {
        throw new Error('M365_ENCRYPTION_KEY_INVALID');
    }

    fs.writeFileSync(envPath, content, { encoding: 'utf8', flag: 'w' });
    return {
        envPath,
        workspaceEnabled: parseEnv(content).M365_WORKSPACE_ENABLED === 'true',
        runnerEnabled: parseEnv(content).M365_RUNNER_ENABLED === 'true',
        encryptionConfigured: true,
    };
}

if (require.main === module) {
    try {
        ensureM365WorkspaceEnv();
        console.log('[M365 Workspace] Secure local project storage is ready.');
    } catch (error) {
        console.error(`[M365 Workspace] Setup stopped: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    ensureM365WorkspaceEnv,
    isValidEncryptionKey,
    parseEnv,
    upsertEnv,
};
