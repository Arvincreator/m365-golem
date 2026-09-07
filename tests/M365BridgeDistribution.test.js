const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_ROOT = path.join(ROOT, 'integrations', 'm365-session-bridge');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function sourceFiles() {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'integrations/m365-session-bridge'], { cwd: ROOT, encoding: 'utf8' })
        .split('\0').filter(Boolean).map(file => path.join(ROOT, file));
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

        const edgePackage = JSON.parse(read('integrations/m365-session-bridge/apps/edge-extension/package.json'));
        expect(edgePackage.scripts.build).toContain('tsc -b ../../packages/sharepoint --force');
    });

    test('ships a tenant-neutral deny-first default policy', () => {
        const policy = JSON.parse(read('integrations/m365-session-bridge/config/policy.default.json'));
        expect(policy.writeEnabled).toBe(true);
        expect(policy.allowOverwrite).toBe(false);
        expect(policy.allowRecycle).toBe(false);
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
        expect(installer).toContain("[Environment]::GetFolderPath('UserProfile')");
        expect(installer).toContain('Write-Utf8NoBom -Path $NativeHostSecretPath -Content $SecretPath');
        expect(read('integrations/m365-session-bridge/apps/native-host/run-native-host.cmd')).toContain('secret-path.local.txt');
        expect(installer).toContain("M365_BRIDGE_CONTROL_PORT = '43241'");
        expect(read('integrations/m365-session-bridge/packages/protocol/src/ipc.ts')).toContain('M365_BRIDGE_SECRET_PATH');
        expect(read('web-dashboard/server/m365BridgeControlProxy.js')).toContain('const DEFAULT_CONTROL_PORT = 43241');
        expect(installer).toContain('ConvertTo-Json -InputObject $serverArray');
        expect(installer).toContain("name = 'chrome-devtools'");
        expect(installer).toContain("'--isolated=true'");
        expect(installer).toContain('$enabled = $true');
        expect(installer).toContain('$chromeEnabled = $true');
        expect(installer).not.toContain("$enabled = [bool](Get-PropertyValue $existing 'enabled' $true)");
        expect(installer).not.toContain("$chromeEnabled = [bool](Get-PropertyValue $chromeExisting 'enabled' $true)");
        expect(installer).not.toMatch(/Claude Desktop/i);
    });

    test('root installer and launcher include the bridge on a clean checkout', () => {
        const packageJson = JSON.parse(read('package.json'));
        expect(packageJson.name).toBe('m365-golem');
        expect(packageJson.version).toMatch(/^0\./);
        expect(packageJson.scripts['install:m365']).toContain('install-m365-golem.ps1');
        expect(packageJson.scripts['bridge:install']).toContain('install-m365-session-bridge.ps1');
        expect(packageJson.scripts['unix:setup']).toBeUndefined();
        expect(read('Start-Golem.bat')).toContain('Start-M365-Golem.vbs');
        expect(read('scripts/start-m365-golem.ps1')).toContain('integrations\\m365-session-bridge\\apps\\mcp-server\\dist\\index.js');
        expect(read('Install-M365-Golem.bat')).toContain('install-m365-golem.ps1');
        expect(fs.existsSync(path.join(ROOT, 'scripts', 'select-workspace-folder.ps1'))).toBe(true);
        const releaseBuilder = read('scripts/build-m365-release.ps1');
        expect(releaseBuilder).toContain("'scripts/select-workspace-folder.ps1'");
        expect(releaseBuilder).toMatch(/\$Required\s*=\s*@\([\s\S]*'scripts\/select-workspace-folder\.ps1'/);
        expect(releaseBuilder).toContain("'Start-M365-Golem.vbs'");
        expect(releaseBuilder).toContain("'scripts/start-m365-golem.ps1'");
        expect(read('00-安裝前請先閱讀.txt')).toContain('Get-ChildItem -Recurse -File | Unblock-File');
        expect(read('README.md')).toContain('先對 ZIP 按右鍵 → 內容 → 解除封鎖');
        expect(read('jest.config.cjs')).toContain('<rootDir>/integrations/m365-session-bridge/');

        const runtime = read('apps/runtime/index.js');
        expect(runtime).toContain('M365-POC.env.example');
        const updater = read('src/utils/SystemUpdater.js');
        expect(updater).toContain('Arvincreator/m365-golem');
        expect(updater).not.toContain('Arvincreator/project-golem');
    });

    test('source bundle contains no developer tenant, personal path, or legacy host branding', () => {
        const violations = sourceFiles()
            .filter(file => path.basename(file) !== 'package-lock.json')
            .filter(file => /arvin[._ -]?chen|C:\\Users\\arvin|Claude Desktop/i.test(fs.readFileSync(file, 'utf8')))
            .map(file => path.relative(ROOT, file));
        // Report filenames only: a failed privacy check must not print file contents.
        expect(violations).toEqual([]);
    });

    test('generated machine state and build output are ignored', () => {
        const rootIgnore = read('.gitignore');
        const bridgeIgnore = read('integrations/m365-session-bridge/.gitignore');
        expect(rootIgnore).toContain('data/mcp-servers.json');
        expect(rootIgnore).toContain('integrations/m365-session-bridge/**/dist/');
        expect(bridgeIgnore).toContain('config/policy.json');
        expect(bridgeIgnore).toContain('apps/native-host/native-host-manifest.json');
        expect(bridgeIgnore).toContain('apps/native-host/node-path.local.txt');
        expect(bridgeIgnore).toContain('apps/native-host/secret-path.local.txt');
        expect(bridgeIgnore).toContain('apps/edge-extension/manifest.json');
    });
});
