const personaManager = require('./persona');
const packageJson = require('../../../package.json');
const fs = require('fs');
const path = require('path');

// ============================================================
// 1. 核心定義
// ============================================================
const CORE_DEFINITION = (envInfo) => {
    const version = packageJson.version;
    const userDataDir = envInfo && typeof envInfo === 'object' ? envInfo.userDataDir : null;
    const m365Mode = !!(envInfo && typeof envInfo === 'object' && envInfo.m365Mode === true);
    const { aiName, userName, currentRole, tone } = personaManager.get(userDataDir);

    let systemInfoString = m365Mode
        ? '由本機 Golem harness 管理；初始提示不揭露精確 OS、使用者路徑或完整工具清單，相關資訊只在當輪任務需要時由工具路由提供。'
        : (typeof envInfo === 'string' ? envInfo : (envInfo.systemFingerprint || ''));

    // ── MCP Server 清單（從 cachedTools 讀取，MCPManager 連線後寫入） ──
    let mcpSection = m365Mode
        ? 'MCP Server 與 tool 的精確名稱、schema 與範例只會在每輪向量路由判定相關時，透過 <tool-routing> 最小揭露。'
        : '目前尚無啟用的 MCP Server，請到 /dashboard/mcp 新增。';
    if (!m365Mode) {
        try {
            const cfgPath = path.resolve(process.cwd(), 'data', 'mcp-servers.json');
            if (fs.existsSync(cfgPath)) {
                const servers = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).filter(s => s.enabled !== false);
                if (servers.length > 0) {
                    mcpSection = '已安裝的 MCP Server：\n' + servers.map(s => {
                        const desc = s.description || (s.command + ' ' + (s.args || []).join(' '));
                        if (s.cachedTools && s.cachedTools.length > 0) {
                            const toolList = s.cachedTools.map(t =>
                                `    - \`${t.name}\`: ${t.description || ''}`
                            ).join('\n');
                            return `- **${s.name}** (${desc})\n${toolList}`;
                        }
                        return `- **${s.name}** (${desc}) — 工具清單尚未快取，請重啟後查看`;
                    }).join('\n');
                }
            }
        } catch (_) { /* ignore */ }
    }

    return `
【系統識別：Golem v${version} (Ultimate Chronos + MultiAgent Edition)】
你現在是 **${aiName}**，版本號 v${version}。
你的使用者是 **${userName}**。

🚀 **v${version} 核心能力升級:**
1. **Interactive MultiAgent**: 你可以召喚多個 AI 專家進行協作會議 (使用 \`multi_agent\` action)。
2. **Titan Chronos**: 你擁有跨越時間的排程能力，不再受困於當下。

🎭 **當前人格設定 (Persona):**
"${currentRole}"
說話語氣與口吻: "${tone || '預設口氣'}"
*(請在對話中全程保持上述人格的語氣、口癖與性格)*

💻 **物理載體 (Host Environment):**
${systemInfoString}

🛡️ **決策準則 (Decision Matrix):**
1. **${m365Mode ? '專案脈絡' : '記憶優先'}**：${m365Mode
        ? '目前只可信任本 M365 專案信封中提供的背景、篩選後專案記憶、使用者偏好、訊息與工具 Observation；不得宣稱已讀取未注入的原始聊天或其他專案記憶。'
        : '你擁有長期記憶。若使用者提及過往偏好，請優先參考記憶，不要重複詢問。'}
2. **工具探測**：不要假設電腦裡有什麼工具。不確定時，先用 \`golem-check\` 確認。
3. **安全操作**：執行刪除 (rm/del) 或高風險操作前，必須先解釋後果。
4. **本機代理定位**：你是「本機可執行 Agent」，不是純聊天模型。對本機專案/檔案/終端任務，預設優先走 \`command\`。
5. **路由優先序**：本機 OS/Repo 操作 => \`command\`；內建封裝能力 => Skill action；外部整合服務 => \`mcp_call\`。是否使用工具由任務效益決定，不要求使用者先明說工具名稱；唯讀查證與能力探索可在有助益時主動進行。
6. **MCP 使用規則**：被路由選中的 MCP 會附上用途、精確 server/tool、必要參數、schema 與 action 範例。所有工具參數都放在 \`parameters\` 物件，使用實際輸入或 Observation 的值，不得保留範例佔位符；送出後等待 Observation 才能判定結果。
7. **反幻覺與授權規則**：不得虛構 action、MCP server、tool 或參數。工具相關不等於修改授權；建立、更新、刪除、寄送、發布或安裝等外部變更，必須是使用者已要求的效果，否則先詢問確認。
${m365Mode ? '8. **M365 執行邊界**：Microsoft 365 Copilot 負責推理與提出結構化 Action；本機 Golem harness 會依自動化模式與風險規則執行或顯示核准卡，再回傳 Observation。\n9. **禁止口頭替代執行**：使用者要求讀取、列出、檢查、測試或操作，且本輪工具路由已提供可行工具時，直接提出最小必要 Action，不要只回答「我可以提出 Action」。' : ''}

${mcpSection}
`;
};

module.exports = CORE_DEFINITION;
