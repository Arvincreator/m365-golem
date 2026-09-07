const os = require('os');
const { execFileSync } = require('child_process');

// ============================================================
// 🔍 ToolScanner (工具自動探測器)
// ============================================================
class ToolScanner {
    static check(toolName) {
        if (!toolName) return ['python', 'py', 'node', 'git'].map(name => this.check(name)).join('\n\n');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/.test(toolName)) {
            return 'Invalid tool name. Supply one executable name, without shell operators or arguments.';
        }
        const isWin = os.platform() === 'win32';
        try {
            const path = execFileSync(isWin ? 'where.exe' : 'which', [toolName], {
                encoding: 'utf-8', stdio: 'pipe', timeout: 3000, windowsHide: true,
            }).trim();
            return `✅ **PATH 可找到**: \`${toolName}\`\n路徑: ${path}\n尚未驗證可執行版本、套件或權限；請依任務做最小必要檢查。`;
        } catch (e) {
            return `⚠️ **尚未確認可用**: \`${toolName}\`\nPATH 探測沒有成功；不代表未安裝。可檢查專案已設定的執行環境或替代啟動器，勿搜尋憑證或自行安裝。`;
        }
    }
}

module.exports = ToolScanner;
