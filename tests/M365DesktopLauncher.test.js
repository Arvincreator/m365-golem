const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('M365 Golem standalone Windows launcher', () => {
    test('starts the service invisibly and opens a dedicated Edge app window', () => {
        const vbs = read('Start-M365-Golem.vbs');
        const launcher = read('scripts/start-m365-golem.ps1');

        expect(vbs).toContain('shell.Run commandLine, 0, False');
        expect(vbs).toContain('-WindowStyle Hidden');
        expect(launcher).toContain("[Environment]::SetEnvironmentVariable('SKIP_BROWSER', '1', 'Process')");
        expect(launcher).toContain('-WindowStyle Hidden');
        expect(launcher).toContain('Find-GolemInstance');
        expect(launcher).toContain('foreach ($offset in 0..9)');
        expect(launcher).toContain("app -eq 'm365-golem'");
        expect(launcher).toContain('"--app=$appUrl"');
        expect(launcher).toContain('/dashboard/chat');
        expect(launcher).toContain("'--new-window'");

        const server = read('web-dashboard/server.js');
        expect(server).toContain('const maxAttempts = 10;');
        expect(server).toContain("err.code === 'EADDRINUSE'");
        expect(server).toContain('const nextPort = port + 1;');
    });

    test('keeps compatibility entry points and clean packages wired to the launcher', () => {
        const legacyLauncher = read('Start-Golem.bat');
        const installer = read('scripts/install-m365-golem.ps1');
        const releaseBuilder = read('scripts/build-m365-release.ps1');

        expect(legacyLauncher).toContain('Start-M365-Golem.vbs');
        expect(legacyLauncher).toContain('-CheckOnly');
        expect(installer).toContain("'M365 Golem.lnk'");
        expect(installer).toContain('Start-M365-Golem.vbs');
        expect(releaseBuilder).toContain("'Start-M365-Golem.vbs'");
        expect(releaseBuilder).toContain("'scripts/start-m365-golem.ps1'");
    });

    test('hides background MCP, action, picker, and fallback launcher processes', () => {
        const mcpClient = read('src/mcp/MCPClient.js');
        const executor = read('src/core/Executor.js');
        const picker = read('src/services/LocalWorkspacePicker.js');
        const fallbackLauncher = read('web-dashboard/src/app/api/system/launcher/start/route.ts');

        expect((mcpClient.match(/windowsHide:\s*true/g) || []).length).toBeGreaterThanOrEqual(2);
        expect(executor).toContain('windowsHide: true');
        expect(picker).toContain('windowsHide: true');
        expect(fallbackLauncher).toContain('windowsHide: true');
        expect(fallbackLauncher).toContain('SKIP_BROWSER: "1"');
    });
});
