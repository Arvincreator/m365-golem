const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_ROOT = path.join(ROOT, 'integrations', 'm365-session-bridge');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function walkSourceFiles(directory) {
    const output = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        if (entry.name === 'manifest.json' || entry.name === 'native-host-manifest.json') continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) output.push(...walkSourceFiles(fullPath));
        else output.push(fullPath);
    }
    return output;
}

describe('built-in M365 Session Bridge distribution', () => {
    test('vendors reproducible source and locked dependencies', () => {
        expect(fs.existsSync(path.join(BRIDGE_ROOT, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(BRIDGE_ROOT, 'package-lock.json'))).toBe(true);
        expect(fs.existsSync(path.join(BRIDGE_ROOT, 'apps', 'mcp-server', 'src', 'index.ts'))).toBe(true);
        expect(fs.existsSync(path.join(BRIDGE_ROOT, 'apps', 'native-host', 'src', 'index.ts'))).toBe(true);
        expect(fs.existsSync(path.join(BRIDGE_ROOT, 'apps', 'edge-extension', 'src', 'background.ts'))).toBe(true);

        const bridgePackage = JSON.parse(read('integrations/m365-session-bridge/package.json'));
        expect(bridgePackage.private).toBe(true);
        expect(bridgePackage.workspaces).toEqual(['apps/*', 'packages/*']);
    });

    test('ships a tenant-neutral deny-first default policy', () => {
        const policy = JSON.parse(read('integrations/m365-session-bridge/config/policy.default.json'));
        expect(policy.writeEnabled).toBe(false);
        expect(policy.allowOverwrite).toBe(false);
        expect(policy.allowPermanentDelete).toBe(false);
        expect(policy.allowExternalSharing).toBe(false);
        expect(policy.allowPermissionChange).toBe(false);
        expect(policy.allowBulkDelete).toBe(false);
        expect(policy.allowArbitraryHttp).toBe(false);
        expect(policy.allowedHosts).toEqual([]);
        expect(policy.allowedSites).toEqual([]);
        expect(policy.allowedLibraries).toEqual([]);
        expect(policy.allowedLocalPaths).toEqual(['%M365_GOLEM_ROOT%']);
    });

    test('generates extension host permissions from the safe default when no local policy exists', () => {
        const generator = read('integrations/m365-session-bridge/apps/edge-extension/scripts/generate-manifest.mjs');
        expect(generator).toContain('policy.default.json');
        expect(generator).toContain('existsSync(localPolicyPath)');
        expect(generator).not.toContain('allowedHosts is empty');
        expect(generator).toContain('non-SharePoint hostname');
    });

    test('installs local state outside Git and registers only the current user', () => {
        const installer = read('scripts/install-m365-session-bridge.ps1');
        expect(installer).toContain("Join-Path $env:LOCALAPPDATA 'M365-Golem\\m365-session-bridge'");
        expect(installer).toContain("HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\m365_session_bridge");
        expect(installer).toContain("managedBy = 'm365-golem'");
        expect(installer).toContain('M365_BRIDGE_POLICY_PATH');
        expect(installer).toContain('ConvertTo-Json -InputObject $serverArray');
        expect(installer).not.toMatch(/Claude Desktop/i);
    });

    test('root installer and launcher include the bridge on a clean checkout', () => {
        const packageJson = JSON.parse(read('package.json'));
        expect(packageJson.name).toBe('m365-golem');
        expect(packageJson.version).toMatch(/^0\./);
        expect(packageJson.scripts['install:m365']).toContain('install-m365-golem.ps1');
        expect(packageJson.scripts['bridge:install']).toContain('install-m365-session-bridge.ps1');
        expect(packageJson.scripts['unix:setup']).toBeUndefined();
        expect(read('Start-M365-POC.bat')).toContain('integrations\\m365-session-bridge\\apps\\mcp-server\\dist\\index.js');
        expect(read('Install-M365-Golem.bat')).toContain('install-m365-golem.ps1');
        expect(read('jest.config.cjs')).toContain('<rootDir>/integrations/m365-session-bridge/');

        const runtime = read('apps/runtime/index.js');
        expect(runtime).toContain('M365-POC.env.example');
        const updater = read('src/utils/SystemUpdater.js');
        expect(updater).toContain('Arvincreator/m365-golem');
        expect(updater).not.toContain('Arvincreator/project-golem');
    });

    test('source bundle contains no developer tenant, personal path, or legacy host branding', () => {
        const combined = walkSourceFiles(BRIDGE_ROOT)
            .filter((file) => path.basename(file) !== 'package-lock.json')
            .map((file) => fs.readFileSync(file, 'utf8'))
            .join('\n');

        expect(combined).not.toMatch(/arvin[._ -]?chen/i);
        expect(combined).not.toMatch(/C:\\Users\\arvin/i);
        expect(combined).not.toMatch(/Claude Desktop/i);
    });

    test('generated machine state and build output are ignored', () => {
        const rootIgnore = read('.gitignore');
        const bridgeIgnore = read('integrations/m365-session-bridge/.gitignore');
        expect(rootIgnore).toContain('data/mcp-servers.json');
        expect(rootIgnore).toContain('integrations/m365-session-bridge/**/dist/');
        expect(bridgeIgnore).toContain('config/policy.json');
        expect(bridgeIgnore).toContain('apps/native-host/native-host-manifest.json');
        expect(bridgeIgnore).toContain('apps/native-host/node-path.local.txt');
        expect(bridgeIgnore).toContain('apps/edge-extension/manifest.json');
    });
});
