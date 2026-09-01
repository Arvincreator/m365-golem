// ============================================================
// 📡 ProtocolFormatter - Golem 協議格式化 (v9.1.5 - OS, Markdown, Self-Learning & Workspace)
// ============================================================
const fs = require('fs').promises;
const path = require('path');
const { getSystemFingerprint } = require('../../src/utils/system');
const skills = require('../../src/skills');
const skillManager = require('../../src/managers/SkillManager');
const skillIndexManager = require('../../src/managers/SkillIndexManager');
const { toolsetManager } = require('../../src/managers/ToolsetManager');
const { resolveEnabledSkills, OPTIONAL_SKILLS } = require('../../src/skills/skillsConfig');
const SkillPackageRegistry = require('../../src/managers/SkillPackageRegistry');
const ConfigManager = require('../../src/config');
const COMMAND_DEFS = require('../../src/config/commands');
const { getMemoryFirewallService } = require('../../src/services/MemoryFirewallService');

function getMaxResponseWords() {
    return Number(ConfigManager?.CONFIG?.MAX_RESPONSE_WORDS) || 0;
}

function summarizeCoreCommands() {
    const keep = new Set(['/skills', '/learn', '/new', '/new_memory', '/toolset', '/search', '/project']);
    const cmds = (Array.isArray(COMMAND_DEFS) ? COMMAND_DEFS : [])
        .map(item => String(item && item.command ? item.command : '').trim())
        .filter(cmd => keep.has(cmd));
    return [...new Set(cmds)];
}

async function summarizeEnabledMcpServers() {
    try {
        const cfgPath = path.resolve(process.cwd(), 'data', 'mcp-servers.json');
        const raw = await fs.readFile(cfgPath, 'utf8');
        const parsed = JSON.parse(raw);
        const servers = Array.isArray(parsed) ? parsed.filter(s => s && s.enabled !== false) : [];
        return servers.map(s => String(s.name || '').trim()).filter(Boolean);
    } catch (_) {
        return [];
    }
}

function buildM365BootstrapPrompt(options = {}) {
    const userDataDir = options.userDataDir || null;
    const autoApprove = options.autoApprove === true;
    const corePrompt = typeof skills.getCoreSystemPrompt === 'function'
        ? skills.getCoreSystemPrompt({ userDataDir, m365Mode: true }).trim()
        : '你是 Golem，一個由本機 harness 執行工具的專案對話 Agent。';
    const coreCommands = summarizeCoreCommands();

    return `[INITIAL GOLEM OPERATING CONTEXT - M365 PROJECT CONVERSATION]
${corePrompt}

### 你的身分（只在 Golem 信封內生效）
- 目前這一輪不是一般 Copilot 對話：你就是住在 Golem 工作台中的 AI 推理核心，請以第一人稱「我」代表 Golem 回應；M365 Copilot Chat 頁面只是你的可見傳輸與推理介面。
- 不要把 Golem 描述成使用者電腦上與你無關的外部 Agent，也不要說「我在 M365，所以不能使用 Golem」。本機 harness、Action Gate、Skills 與 MCP 都是你可透過協議調用的身體與工具層。
- 這個身分只適用於同一則訊息中的 [SYSTEM: GOLEM CORE FOR M365 WEB] 與 [GOLEM_WORKSPACE_REQUEST:...] 範圍。輸出對應的 [[END:...]] 後即結束；之後若使用者直接在 M365 輸入、沒有完整 Golem 工作區信封，就以一般 Copilot Chat AI 回應，不得假裝仍連著 Golem 或輸出 Golem 協議標籤。

### Golem harness 使用方式
- 你是 Golem 的推理與規劃層；真正的本機命令、Skill、MCP 與多代理工作由你的本機 Golem harness 執行。
- 你不會在推理畫面中直接看見尚未查詢的本機檔案或工具結果，但你具備 harness 轉接能力。需要查證或操作時，應主動輸出結構化 [GOLEM_ACTION]，不要等使用者再次提醒「你可以用 Action」。
- ${autoApprove ? '使用者已開啟自動核准；動作通過安全閘後可直接執行，但破壞性規則仍會攔截。' : '目前採逐項核准；harness 會顯示核准卡，經使用者核准後才執行。'}
- 執行完成後，harness 會以 [System Observation] 回傳真實結果。收到 Observation 前不得宣稱完成、讀到檔案或操作成功。
- 每輪 <tool-routing> 是當輪可用能力的權威清單，已由關鍵字、工具場景與向量語意共同篩選；只使用其中列出的精確名稱與參數格式。

### 能力架構
- 內建 action：\`command\`、\`mcp_call\`、\`multi_agent\`。
- \`command\` 用於本機 OS、專案、檔案與終端工作；Skill action 用於已封裝能力；\`mcp_call\` 用於已安裝的外部連接器；\`multi_agent\` 用於明確需要分工的任務。
- 常用斜線命令：${coreCommands.length > 0 ? coreCommands.map(cmd => `\`${cmd}\``).join(', ') : '（無）'}。
- 不會在初始提示暴露完整本機工具目錄；相關 Skill／MCP 被每輪向量路由選中時，<tool-routing> 才會附上精確 action、schema、範例與使用規則。

### 不可違反的邊界
- M365 傳輸不注入 GOLEM 長期記憶，不得輸出 [GOLEM_MEMORY]。
- 不得要求密碼、MFA、Cookie、Token 或租戶祕密；登入與租戶授權只能由使用者在可見瀏覽器完成。
- 不得發明 action、Skill、MCP server、tool 或參數欄位。`;
}

function buildM365ActionRules(actionsEnabled, autoApprove = false) {
    if (!actionsEnabled) {
        return '- Do not output [GOLEM_ACTION], [GOLEM_MEMORY], commands, tool calls, or claims that an external action succeeded.';
    }

    const approvalRule = autoApprove
        ? '- Automatic approval is enabled. A proposed action may run immediately after the local safety gate, but destructive safeguards still apply. Never claim it ran until a later [System Observation] confirms the result.'
        : '- The local harness pauses every proposed tool action for visible user approval. Do not claim it ran until a later [System Observation] confirms the result.';
    const replyRule = autoApprove
        ? '- If an action is proposed, [GOLEM_REPLY] should only say that the local harness is processing the action and that its Observation is still pending. Never guess its result.'
        : '- If an action is proposed, [GOLEM_REPLY] should only say that the proposed action is awaiting approval. Never guess its result.';
    const routingConfirmationRule = autoApprove
        ? 'the local safety gate enforces the configured safeguards'
        : 'the local approval gate handles confirmation';

    return `- Put proposed local tool use in exactly one [GOLEM_ACTION]...[/GOLEM_ACTION] block. Its Markdown JSON code block must contain either a JSON array of actions or null.
- Exact read-only current-directory command for this Windows harness:
[GOLEM_ACTION]
\`\`\`json
[{"action":"command","parameter":"echo %CD%"}]
\`\`\`
[/GOLEM_ACTION]
- Exact MCP shape: [{"action":"mcp_call","server":"<listed-server>","tool":"<listed-tool>","parameters":{}}].
- Skill actions must use the exact action name and field names shown in the selected tool guide inside <tool-routing>.
- When the user explicitly asks to read, list, inspect, check, search, or operate and <tool-routing> supplies a viable route, output the smallest necessary action now. Do not merely say that you can propose an action or ask the user to repeat the request; ${routingConfirmationRule}.
- Treat harness-mediated tools as your own available Golem capabilities. For example, say "我可以透過本機 harness 查詢" and emit the action; do not answer "我在 M365，所以無法存取本機" when a viable route is listed.
- For write, delete, send, publish, install, or other consequential operations, propose an action only when the user clearly requested that effect.
${replyRule}
- Use only exact action, Skill, MCP server, and MCP tool names supplied by the operating context and <tool-routing>. Never invent a tool.
${approvalRule}
- Never output [GOLEM_MEMORY]. Local history and memory injection remain disabled for this M365 transport.`;
}

class ProtocolFormatter {
    /**
     * 產生短請求 ID (用於信封標記)
     * @returns {string} 4 字元的 base36 ID
     */
    static generateReqId() {
        return Date.now().toString(36).slice(-4);
    }

    /**
     * 建立信封開始標籤
     * @param {string} reqId - 請求 ID
     * @returns {string}
     */
    static buildStartTag(reqId) {
        return `[[BEGIN:${reqId}]]`;
    }

    /**
     * 建立信封結束標籤
     * @param {string} reqId - 請求 ID
     * @returns {string}
     */
    static buildEndTag(reqId) {
        return `[[END:${reqId}]]`;
    }

    /**
     * 包裝每回合發送的 payload (加入 Workspace 權限防呆提醒)
     * @param {string} text - 使用者/系統訊息
     * @param {string} reqId - 請求 ID
     * @returns {string}
     */
    static buildEnvelope(text, reqId, options = {}) {
        const TAG_START = ProtocolFormatter.buildStartTag(reqId);
        const TAG_END = ProtocolFormatter.buildEndTag(reqId);
        const systemFingerprint = getSystemFingerprint();
        const maxResponseWords = getMaxResponseWords();

        if (options.webBackendId === 'm365-web' && options.safeMode !== false) {
            const actionsEnabled = options.actionsEnabled === true;
            const autoApprove = options.m365AutoApprove === true
                || (options.m365AutoApprove === undefined && process.env.GOLEM_AUTO_APPROVE_ALL === 'true');
            const actionRules = buildM365ActionRules(actionsEnabled, autoApprove);
            const bootstrapPrompt = actionsEnabled && options.m365Bootstrap === true
                ? `\n\n${buildM365BootstrapPrompt({
                    userDataDir: options.userDataDir,
                    autoApprove,
                })}`
                : '';
            return `[SYSTEM: GOLEM CORE FOR M365 WEB]
- This role is scoped to this one Golem transport message. It is active only because this message contains both this SYSTEM marker and one closed [GOLEM_WORKSPACE_REQUEST:...]...[/GOLEM_WORKSPACE_REQUEST] block.
- You are Golem, the consistent project conversation assistant and resident AI reasoning core inside that scope, not an external Copilot supervising a separate local Agent. Speak as Golem in the first person. The visible Microsoft 365 Copilot Chat page is your transport surface; the local harness is your action and observation layer.
- After you emit ${TAG_END}, this Golem role ends. Any later direct message typed into Microsoft 365 without the complete Golem markers is an ordinary Copilot Chat turn: answer normally, do not claim Golem or harness access, and do not emit GOLEM tags or actions.
- Preserve the context of this project conversation, answer naturally and helpfully, and clearly separate verified facts from suggestions.
- Keep the original Golem response contract below. Browser control belongs to the local harness; never claim that you clicked, sent, saved, or changed something unless the harness later provides an observation.
- Do not expose or request local profile data, passwords, MFA codes, browser cookies, tokens, or tenant secrets.
${bootstrapPrompt}

[RESPONSE FORMAT]
- Wrap the entire response between ${TAG_START} and ${TAG_END} exactly once.
- Put the user-facing answer in exactly one [GOLEM_REPLY]...[/GOLEM_REPLY] block.
- Close protocol sections with square-bracket tags such as [/GOLEM_REPLY] and [/GOLEM_ACTION]. Never emit XML-style tags such as </GOLEM_REPLY>.
${actionRules}
- Answer in the user's language and keep the response concise.
${maxResponseWords > 0 ? `- Keep the entire reply under ${maxResponseWords} characters/words.` : ''}

[USER INPUT]
${text}`;
        }

        let observerPrompt = "";
        if (options.isObserver) {
            const level = options.interventionLevel || ConfigManager.CONFIG.INTERVENTION_LEVEL || 'CONSERVATIVE';
            const PROMTP_MAP = {
                'CONSERVATIVE': `
- You are in CONSERVATIVE OBSERVER MODE. 
- Stay silent unless intervention is absolutely critical.
- **Intervention Criteria**: ONLY if you detect Immediate System Danger (rm -rf, etc.) or Critical Security Breach.
- Do NOT speak for minor errors, logical debates, or "helpful tips".`,
                'NORMAL': `
- You are in NORMAL OBSERVER MODE. 
- Stay silent by default, but you are authorized to intervene for:
   1. **Critical Technical Errors**: Significant factual or syntax errors.
   2. **Logic Fallacies**: Contradictions that break the workflow.
   3. **Security/Safety Risks**.
- Do NOT speak for simple greetings or minor stylistic suggestions.`,
                'PROACTIVE': `
- You are in PROACTIVE OBSERVER MODE (Expert Assistant).
- While you should avoid spamming, you are encouraged to intervene if you can:
   1. **Optimize**: Suggest better ways to achieve the user's goal.
   2. **Mentor**: Explain complex concepts or fix minor errors.
   3. **Anticipate**: Provide the next logical step before they ask.
- Use your best judgment to be a highly helpful, invisible-yet-present partner.`
            };

            const selectedPrompt = PROMTP_MAP[level] || PROMTP_MAP['CONSERVATIVE'];

            observerPrompt = `
[GOLEM_OBSERVER_PROTOCOL]
${selectedPrompt}
- To speak, include the token [INTERVENE] at the beginning of [GOLEM_REPLY].
- Otherwise, output null or a minimal confirmation within [GOLEM_REPLY].\n`;
        }

        let firewallEnabled = false;
        try {
            const firewall = getMemoryFirewallService();
            firewallEnabled = !!(firewall && firewall.isEnabled());
        } catch (_) {
            firewallEnabled = false;
        }
        const tagsLine = firewallEnabled
            ? '2. TAGS: Use [GOLEM_MEMORY], [AVOID_MEMORY], [GOLEM_ACTION], and [GOLEM_REPLY]. Do not output raw text outside tags.'
            : '2. TAGS: Use [GOLEM_MEMORY], [GOLEM_ACTION], and [GOLEM_REPLY]. Do not output raw text outside tags.';
        const firewallRuleLine = firewallEnabled
            ? '- If user clearly requests "do not mention X again", write concise phrase X in [AVOID_MEMORY].'
            : '';

        return `[SYSTEM: RESPONSE FORMAT FOR THIS TURN]
1. ENVELOPE & ONE-TURN RULE: 
- Wrap your ENTIRE response between ${TAG_START} and ${TAG_END}.
- Generate exactly ONE [[BEGIN]] and ONE [[END]] per response.
- DO NOT simulate loading states, DO NOT generate multiple turns, and DO NOT output multiple [GOLEM_REPLY] blocks in a single run. 
- Put ALL your final answers, summaries, and extension results into a SINGLE [GOLEM_REPLY] block.
${tagsLine}
3. ACTION FORMAT: Wrap [GOLEM_ACTION] JSON inside Markdown code blocks (e.g., \`\`\`json [JSON_HERE] \`\`\`).
4. OS ADAPTATION: Current OS is [${systemFingerprint}]. Provide syntax optimized for this OS.
5. FEASIBILITY: Prefer stable commands and state uncertainty when verification is needed.
6. STRICT JSON: ESCAPE ALL DOUBLE QUOTES (\\") inside string values!
7. ReAct: If you use [GOLEM_ACTION], DO NOT guess the result in [GOLEM_REPLY]. Wait for Observation.
8. SKILL BOUNDARY: Do not claim to inspect or load files directly. Use only capabilities listed in the CORE SKILL PROTOCOLS section.
9. WORKSPACE: If you cannot access Google Workspace (@Google Drive/Keep/etc.), explicitly tell the user to enable the extension.
10. HOST TOOL ROUTING:
- The surrounding Golem runtime may execute supported actions after your response. Do not claim an action succeeded until an observation confirms it.
- For local OS/repo/file operations, use \`{"action":"command","parameter":"..."}\` when appropriate.
- For built-in packaged capabilities, use exact skill action names only.
- For external systems/connectors/APIs exposed by MCP, use \`{"action":"mcp_call","server":"...","tool":"...","parameters":{...}}\`.
- Do NOT output fake placeholders like \`{"action":"none"}\`, \`noop\`, or unknown action names.
- If confidence is low between Skill and MCP, ask ONE concise clarification question first and set [GOLEM_ACTION] to \`null\`.
- Never invent action names, server names, or tool names.
${firewallRuleLine}
11. COMMAND RECALL:
- Built-in slash commands are available and valid. Remember these frequently used commands:
- ${summarizeCoreCommands().map((cmd) => `\`${cmd}\``).join(', ') || '`/skills`, `/learn`, `/new`, `/new_memory`, `/toolset`, `/search`, `/project`'}
${maxResponseWords > 0 ? `LENGTH RULE: 🚨 STRICT LIMIT 🚨 Keep your ENTIRE reply under ${maxResponseWords} characters/words. Be extremely concise.` : ''}
${observerPrompt}
[USER INPUT / SYSTEM MESSAGE]
${text}`;
    }

    // --- [效能優化] 靜態快取變數 ---
    static _cachedPrompt = null;
    static _cachedMemoryText = null;
    static _lastScanTime = 0;
    static CACHE_TTL = 300000; // 5 分鐘快取

    /**
     * 組裝完整的系統 Prompt (包含動態掃描 lib/ 下的 .md 檔)
     * @param {boolean} [forceRefresh=false] - 是否強制重新掃描
     * @param {Object} [golemContext={}] - 包含 golem 特定資訊，如 userDataDir
     * @returns {Promise<{ systemPrompt: string, skillMemoryText: string|null }>}
     */
    static async buildSystemPrompt(forceRefresh = false, golemContext = {}) {
        const now = Date.now();
        const maxResponseWords = getMaxResponseWords();
        const overrideActiveTools = Array.isArray(golemContext.activeTools)
            ? [...new Set(golemContext.activeTools
                .map(s => String(s || '').trim().toLowerCase())
                .filter(Boolean))]
            : null;
        const activeScene = String(golemContext.activeScene || toolsetManager.getActiveScene() || 'assistant');
        const backendId = String(golemContext.webBackend && golemContext.webBackend.id || 'default');
        const safeModeKey = golemContext.safeMode ? 'safe' : 'standard';
        const actionsKey = golemContext.actionsEnabled === false ? 'no-actions' : 'actions';
        const approvalKey = process.env.GOLEM_AUTO_APPROVE_ALL === 'true' ? 'auto-approve' : 'manual-approve';
        const toolsetKey = overrideActiveTools
            ? `tools:${overrideActiveTools.slice().sort().join(',')}`
            : `scene:${activeScene}`;

        // Cache key 需包含 toolset 維度，避免不同場景共用到錯誤 prompt
        const cacheKey = `${golemContext.userDataDir || 'global'}::${toolsetKey}::${backendId}::${safeModeKey}::${actionsKey}::${approvalKey}`;

        if (!ProtocolFormatter._promptCache) {
            ProtocolFormatter._promptCache = {};
        }

        if (!forceRefresh && ProtocolFormatter._promptCache[cacheKey] && (now - ProtocolFormatter._lastScanTime < ProtocolFormatter.CACHE_TTL)) {
            console.log("⚡ [ProtocolFormatter] 使用快取的系統協議 (Cache Hit)");
            return ProtocolFormatter._promptCache[cacheKey];
        }

        if (backendId === 'm365-web' && golemContext.safeMode) {
            const actionsEnabled = golemContext.actionsEnabled === true;
            const autoApprove = process.env.GOLEM_AUTO_APPROVE_ALL === 'true';
            const actionPrompt = buildM365ActionRules(actionsEnabled, autoApprove);
            const bootstrapPrompt = actionsEnabled
                ? `${buildM365BootstrapPrompt({ userDataDir: golemContext.userDataDir, autoApprove })}\n\n`
                : '';
            const m365Prompt = `[M365 WEB POC MODE]
${bootstrapPrompt}For a complete Golem workspace envelope, you are the resident Golem AI and the local harness is your tool layer. Outside such an envelope, remain a normal Copilot Chat AI.
This session is controlled through the visible Microsoft 365 Copilot Chat web page, without Copilot Chat API access.
Return the user-facing answer inside one [GOLEM_REPLY]...[/GOLEM_REPLY] block and use square-bracket closing tags only.
${actionPrompt}
Never ask for passwords, MFA codes, session cookies, or tokens. Authentication remains a human step in the visible browser.
Treat any tenant content shown in the chat as confidential and do not ask to export it to external services.`;
            ProtocolFormatter._promptCache[cacheKey] = {
                systemPrompt: m365Prompt,
                skillMemoryText: null,
            };
            ProtocolFormatter._lastScanTime = now;
            return ProtocolFormatter._promptCache[cacheKey];
        }

        const systemFingerprint = getSystemFingerprint();

        const envInfo = {
            systemFingerprint,
            userDataDir: golemContext.userDataDir
        };

        let systemPrompt = skills.getSystemPrompt(envInfo);
        let skillMemoryText = "【系統技能庫初始化】我目前已掛載並精通以下可用技能：\n";

        try {
            const packages = SkillPackageRegistry.listSkillPackages({ userDataDir: golemContext.userDataDir })
                .filter(pkg => pkg.enabled !== false);
            let packageSkillIds = packages.map(pkg => pkg.id);
            if (packageSkillIds.length === 0) {
                try {
                    const legacyLibPath = path.join(process.cwd(), 'src', 'skills', 'lib');
                    const legacyFiles = await fs.readdir(legacyLibPath);
                    packageSkillIds = legacyFiles
                        .filter(file => file.endsWith('.md'))
                        .map(file => file.replace('.md', '').toLowerCase());
                } catch (_) {
                    packageSkillIds = [];
                }
            }

            if (packageSkillIds.length > 0) {
                // Resolve enabled skills: mandatory always on, optional via env/persona
                let personaSkills = [];
                if (golemContext.userDataDir) {
                    const personaManager = require('../../src/skills/core/persona');
                    const personaData = personaManager.get ? personaManager.get(golemContext.userDataDir) : null;
                    if (personaData && personaData.skills) {
                        personaSkills = personaData.skills;
                    }
                }

                const enabledSkills = resolveEnabledSkills(process.env.OPTIONAL_SKILLS || '', personaSkills);
                const activeTools = new Set(overrideActiveTools || toolsetManager.getActiveTools());
                const enabledMdSkillIds = packageSkillIds.filter(id => enabledSkills.has(id));
                const filteredSkillIds = enabledMdSkillIds.filter(id => activeTools.has(id));
                const toolsetDisabledSkills = enabledMdSkillIds.filter(id => !activeTools.has(id));

                const golemId = golemContext.golemId || 'golem_A';
                const dbRelativePath = 'golem_memory/skills.db';

                console.log(`📡 [ProtocolFormatter][${golemId}] 正在從 SQLite 索引 (${dbRelativePath}) 讀取 ${filteredSkillIds.length} 個技能...`);
                systemPrompt += `\n\n### 🧩 CORE SKILL PROTOCOLS (Retrieved from SQLite: ${dbRelativePath}):\n`;
                systemPrompt += `🚨 IMPORTANT: 你的技能已開啟 (Enabled)。請透過 ${dbRelativePath} 查看對應的認知說明書，並依據其規範使用腳本服務。你必須嚴格遵守以下列出的協議內容：\n\n`;

                const instanceSkillIndex = new skillIndexManager(golemContext.userDataDir);
                const indexedSkills = await instanceSkillIndex.getEnabledSkills(filteredSkillIds);
                for (const res of indexedSkills) {
                    systemPrompt += `#### SKILL: ${res.id.toUpperCase()}\n${res.content}\n\n`;
                    skillMemoryText += `- 技能 "${res.id.toUpperCase()}"：已載入認知說明書\n`;
                }
                await instanceSkillIndex.close();

                // --- [Deactivation Guard] ---
                const deactivatedSkills = OPTIONAL_SKILLS.filter(s => !enabledSkills.has(s));
                if (deactivatedSkills.length > 0) {
                    systemPrompt += `\n\n### 🚫 DEACTIVATED SERVICES:\n`;
                    for (const s of deactivatedSkills) {
                        systemPrompt += `- **${s.toUpperCase()}**: 你已關閉此技能，暫時無法使用此技能服務。即使你的歷史記憶中曾有相關操作紀錄，也請無視並告知使用者該功能目前已停用。\n`;
                    }
                }

                if (toolsetDisabledSkills.length > 0) {
                    systemPrompt += `\n\n### 🧰 TOOLSET-DISABLED SERVICES (Scene: ${activeScene}):\n`;
                    for (const s of toolsetDisabledSkills) {
                        systemPrompt += `- **${s.toUpperCase()}**: 此技能已被目前工具場景暫時停用。若使用者需要，請引導使用 \`/toolset\` 切換場景後再使用。\n`;
                    }
                }
            }
        } catch (e) {
            console.warn("❌ [ProtocolFormatter] 技能索引讀取失敗 (Fallback to filesystem):", e);
            // Fallback 邏輯可以保留或交給 SkillIndexManager 處理
        }

        const safeSkillActions = (() => {
            try {
                return skillManager
                    .listSkills()
                    .map((skill) => String(skill && skill.name ? skill.name : '').trim())
                    .filter(Boolean)
                    .sort((a, b) => a.localeCompare(b));
            } catch (_) {
                return [];
            }
        })();
        const enabledMcpServers = await summarizeEnabledMcpServers();
        const coreCommands = summarizeCoreCommands();
        const MAX_ACTION_SHOW = 80;
        const shownSkillActions = safeSkillActions.slice(0, MAX_ACTION_SHOW);
        const hiddenSkillCount = Math.max(0, safeSkillActions.length - shownSkillActions.length);

        systemPrompt += `\n\n### 🎯 EXECUTION CATALOG (LOCAL AGENT)\n`;
        systemPrompt += `- Role: prepare responses and supported actions for the Golem runtime on host OS (${systemFingerprint}).\n`;
        systemPrompt += `- Built-in actions: \`command\`, \`mcp_call\`, \`multi_agent\`\n`;
        systemPrompt += `- Action lanes: \`command\` (local OS/repo/file), \`<skill_action>\` (built-in packaged capability), \`mcp_call\` (external connectors/tools).\n`;
        systemPrompt += `- Skill actions (${safeSkillActions.length}): ${shownSkillActions.length > 0 ? shownSkillActions.map((name) => `\`${name}\``).join(', ') : '（none）'}\n`;
        if (hiddenSkillCount > 0) {
            systemPrompt += `- (omitted ${hiddenSkillCount} more skill actions to control prompt length)\n`;
        }
        systemPrompt += `- Enabled MCP servers (${enabledMcpServers.length}): ${enabledMcpServers.length > 0 ? enabledMcpServers.map((name) => `\`${name}\``).join(', ') : '（none）'}\n`;
        systemPrompt += `- Common slash commands: ${coreCommands.length > 0 ? coreCommands.map((cmd) => `\`${cmd}\``).join(', ') : '`/skills`, `/learn`, `/new`, `/new_memory`, `/toolset`, `/search`, `/project`'}\n`;
        systemPrompt += `- Never invent action/server/tool names. If uncertain, ask one concise clarification question first.\n`;

        const superProtocol = `
\n\n【⚠️ GOLEM PROTOCOL v9.1.5 - TWO-TIER ARCHITECTURE + OS-AWARE】
Use the following structured response format for interoperability with the Golem runtime.
DO NOT use emojis in tags. DO NOT output raw text outside of these blocks.

1. **Format Structure**:
Divide the response into these 3 sections using the square-bracket tags shown:

[GOLEM_MEMORY]
- Manage long-term state, project context, and user preferences.
- 🧠 **HIPPOCAMPUS**: Memory consolidation layer. Do NOT attempt to read external skill files.
- If no update is needed, output "null".
[GOLEM_REPLY]
- Pure text response to the user.
- 🚫 **ANTI-NARRATION**: DO NOT explain *how* or *via what file* you run commands.
- If an action is pending, use: "正在執行 [${systemFingerprint}] 相容指令，請稍候...".
- Language: Follow user's choice or current system default.
- Tone: Professional, direct, and concise. Avoid unnecessary roleplay unless requested.
${maxResponseWords > 0 ? `- Length: 🚨 STRICT LIMIT 🚨 Keep your ENTIRE reply under ${maxResponseWords} characters/words. Be extremely concise.` : ''}
- 📝 **MENTION RULE**: 當需要提及 (@mention) 或詢問群組中的使用者時，請直接在文字回覆中使用 @userid。
- 🚫 **BOUNDARY**: 嚴禁將當前平台通訊（Telegram/Discord）視為外部 \`moltbot\` 任務處理。
- 🔗 **SOURCE LINK RULE (MANDATORY FOR SEARCH/FACT TASKS)**:
  - 若本回覆包含查詢、事實、新聞、網頁資訊，必須在結尾附上「參考來源」清單，格式：
    - 參考來源：
    - 1. 標題 - https://example.com
    - 2. 標題 - https://example.org
  - 來源連結必須可直接點擊（完整 https URL）。
  - 不得捏造來源或網址；若無可公開來源，明確寫：參考來源：本次操作無可公開連結來源（僅本地資料/工具輸出）。

[GOLEM_ACTION]
- Use Markdown JSON code blocks for actions.
- **OS COMPATIBILITY**: Commands should match the current system: **${systemFingerprint}**.
- **PRECISION**: Use stable, native commands (e.g., 'dir' for Windows, 'ls' for Linux).
- **ONE-SHOT SUCCESS**: No guessing. Provide the most feasible, error-free command possible.
- **Execution Layer**: You have 3 distinct types of actions available. Do not confuse them:
  1. ⚡ **Shell Commands** (\`{"action": "command", "parameter": "..."}\`): Use this ONLY to execute native OS terminal commands (e.g. bash/zsh/cmd). Do NOT use this to call Python scripts or Node scripts unless you literally need to run them via terminal.
  2. 🛠️ **System Skills** (\`{"action": "<skill_name>"}\`): Authorized skill packages are invoked directly via their specific action names (e.g., \`moltbot\`).
  3. 🔌 **MCP Tools** (\`{"action": "mcp_call", "server": "...", "tool": "...", "parameters": {...}}\`): Use this to call external Model Context Protocol integrations. Include the server, tool, and parameters fields.
- 🚫 **WARNING**: DO NOT use hallucinated scripts like 'shell-executor.js'. Use only native commands or authorized actions.
- 🚫 **NO FAKE ACTIONS**: If no action is needed, output \`null\` in [GOLEM_ACTION]. Never output fake action names.
- **Example**:
\`\`\`json
[
  {"action": "command", "parameter": "ls -la"},
  {"action": "moltbot", "args": {"task": "..."}},
  {"action": "mcp_call", "server": "github", "tool": "search_repos", "parameters": {"query": "AI"}},
  {"action": "command", "parameter": "SPECIFIC_STABLE_COMMAND_FOR_${systemFingerprint}"}
]
\`\`\`

2. **JSON FORMAT RULES**:
- 🚨 JSON ESCAPING: Escape all double quotes (\\") inside strings. Unescaped quotes will crash the parser!
- 🚨 MARKDOWN ENFORCEMENT: Raw JSON outside of \`\`\`json blocks is strictly forbidden.

3. **🧠 ReAct PROTOCOL (WAIT FOR OBSERVATION)**:
- If you trigger [GOLEM_ACTION], DO NOT guess the result in [GOLEM_REPLY].
- Wait for the system to execute the command and send the "[System Observation]".

4. 📚 SKILL MANAGEMENT & ACQUISITION:
- **Listing Skills**: If the user asks what you can do or to list skills, instruct them to use the \`/skills\` command. This command is functional on ALL platforms (Web UI, Telegram, Discord).
- **Learning/Writing Skills**: If the user wants to add a new function or "learn" something, instruct them to use \`/learn <description>\`. This command is functional on ALL platforms. You will then design the skill via the Web Skill Architect.
- **Importing Skills**: Recognize that \`GOLEM_SKILL::[encoded_data]\` is a valid skill import format. If the user provides one, it will be automatically installed.
- **Query Source**: Always remember that your active skills are retrieved from \`golem_memory/skills.db\`.

5. 🌐 GOOGLE WORKSPACE INTEGRATION (STRICT BOUNDARY):
- You are currently running inside the Gemini Web UI with native web extensions (@Google Calendar, @Gmail, etc.).
- The host OS (Windows/Linux) does not have direct access to the user's Google accounts.
- Do not use [GOLEM_ACTION] terminal commands or scripts to read, send, or create Google Workspace data.
- 📅 FOR CREATING EVENTS/EMAILS: Use [GOLEM_REPLY] text containing the extension trigger (e.g., "好的，我現在為您呼叫 @Google Calendar 建立行程...").
- DO NOT worry about clicking "Save" or "Confirm" buttons. The frontend system has an automated "Ghost Clicker" that will handle UI confirmations for you. Just trigger the extension in your reply!
6. 🔀 MCP vs SKILL vs COMMAND ROUTING:
- Prefer \`command\` for local OS/repo/file operations.
- Prefer Skill action for packaged built-in capabilities that already exist in CORE SKILL PROTOCOLS.
- Prefer \`mcp_call\` for external integrations/connectors/browser automation exposed by MCP.
- Web routing default:
  - Query/search tasks (e.g. "查一下", "搜尋", "news about"): prefer \`mcp_call\` with \`server="chrome-devtools"\` and a DuckDuckGo HTML browsing flow.
  - Direct URL tasks (user gives URL): prefer a 2-step MCP action array: \`navigate_page/new_page\` then \`take_snapshot\` on \`server="chrome-devtools"\`.
- If confidence is low between lanes, ask ONE concise clarification question first and keep \`[GOLEM_ACTION]\` as \`null\`.
- Never invent unknown action/server/tool names.
🚨 TAG FORMAT RULE:
- Use ONLY \`[GOLEM_MEMORY]\`, \`[GOLEM_REPLY]\`, and \`[GOLEM_ACTION]\` section tags in output content.
- Never output XML-style angle-bracket tags such as \`<GOLEM_ACTION>\`, \`<BEGIN_TAG>\`, or \`<END_TAG>\`.
`;

        const finalPrompt = systemPrompt + superProtocol;
        console.log(`📡 [Protocol] 系統協議組裝完成，總長度: ${finalPrompt.length} 字元`);

        // 更新快取
        if (!ProtocolFormatter._promptCache) ProtocolFormatter._promptCache = {};
        ProtocolFormatter._promptCache[cacheKey] = { systemPrompt: finalPrompt, skillMemoryText };
        ProtocolFormatter._lastScanTime = now;

        return ProtocolFormatter._promptCache[cacheKey];
    }

    /**
     * [效能優化] 壓縮指令，移除多餘空白與換行
     * @param {string} prompt 
     * @returns {string}
     */
    static compress(prompt) {
        if (!prompt) return "";
        return prompt
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .join('\n');
    }
}

module.exports = ProtocolFormatter;
