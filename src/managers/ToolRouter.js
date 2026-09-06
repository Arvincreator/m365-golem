const fs = require('fs');
const path = require('path');
const SkillPackageRegistry = require('./SkillPackageRegistry');
const { toolsetManager } = require('./ToolsetManager');
const ToolUsePolicy = require('./ToolUsePolicy');
const MCPToolCatalog = require('../mcp/MCPToolCatalog');

const MCP_CONFIG_PATH = path.resolve(process.cwd(), 'data', 'mcp-servers.json');
const LOCAL_COMMAND_RE = /(terminal|shell|bash|zsh|cmd|命令|指令|終端機|本機|專案|repo|資料夾|檔案|目錄|路徑|安裝|npm|pnpm|yarn|node|python|git|ls|pwd|cd|cat|sed|grep|rg|build|test|lint|run|execute|執行|編譯|啟動|server)/i;
const LOCAL_ARTIFACT_BUILD_RE = /(?:(?:製作|建立|建置|開發|實作|編寫|撰寫|寫(?:一個|個|出)?|create|build|develop|implement).{0,40}(?:互動(?:式)?(?:網頁|網站)|網頁|網站|web(?:site|page|app)?|html|css|javascript|程式|應用程式|app)|(?:互動(?:式)?(?:網頁|網站)|網頁|網站|web(?:site|page|app)?|html|css|javascript|程式|應用程式|app).{0,40}(?:製作|建立|建置|開發|實作|編寫|撰寫|寫(?:一個|個|出)?|create|build|develop|implement))/i;
const EXPLICIT_REMOTE_ARTIFACT_TARGET_RE = /(?:在|到|於|透過|使用).{0,8}(?:sharepoint|onedrive|teams|notion|github|slack|microsoft\s*365|\bm365\b|瀏覽器|browser)/i;
const EXTERNAL_SYSTEM_RE = /(@gmail|@google|calendar|gmail|drive|onedrive|sharepoint|microsoft\s*365|\bm365\b|mcp|devtools|notion|slack|teams|github[^a-z]|telegram|discord|瀏覽器自動化|外部服務|第三方)/i;
const M365_DATA_RE = /(sharepoint|one\s*drive|onedrive|microsoft\s*365|\bm365\b|\.sharepoint\.(?:com|us|de|cn)|sharepoint-mil\.us)/i;
const M365_SEARCH_RE = /(搜尋|查找|全文搜尋|全域搜尋|找出.{0,24}(?:檔案|文件)|\bsearch\b|\bfind\b.{0,24}\b(?:files?|documents?)\b)/i;
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'what', 'when', 'where', 'how',
    '你', '我', '他', '她', '它', '我們', '你們', '請', '幫我', '可以', '一下', '這個', '那個',
]);

function normalizeText(value) {
    return String(value || '').toLowerCase();
}

function extractTerms(input) {
    const text = normalizeText(input);
    const terms = [];

    const ascii = text.match(/[a-z0-9_-]{2,}/g) || [];
    for (const term of ascii) {
        if (!STOPWORDS.has(term)) terms.push(term);
    }

    const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    for (const chunk of cjk) {
        if (!STOPWORDS.has(chunk)) terms.push(chunk);
        for (let i = 0; i < chunk.length - 1; i += 1) terms.push(chunk.slice(i, i + 2));
        for (let i = 0; i < chunk.length - 2; i += 1) terms.push(chunk.slice(i, i + 3));
    }

    return [...new Set(terms)].slice(0, 80);
}

function inferIntentBoosts(text) {
    const boosts = [];
    const t = normalizeText(text);

    const add = (needle, ids) => {
        if (needle.test(t)) boosts.push(...ids);
    };

    add(/(log|logs|error|錯誤|報錯|日誌|紀錄|debug|除錯)/i, ['log-reader', 'log-archive']);
    add(/(browser|chrome|devtools|網頁|頁面|點擊|輸入|表單|console|network|lighthouse|截圖|瀏覽器)/i, ['chrome-devtools']);
    add(/(搜尋引擎|meta search|metasearch|網路搜尋|公開資料|查資料|duckduckgo|html\.duckduckgo)/i, ['duckduckgo-search', 'chrome-devtools']);
    add(/(搜尋後|深入查看|深入網頁|繼續查看這個網頁|deep dive|follow-up crawl)/i, ['duckduckgo-devtools-bridge', 'duckduckgo-search', 'chrome-devtools']);
    add(/(git|commit|branch|diff|pull request|pr|版本|分支)/i, ['git']);
    add(/(記憶|memory|回憶|以前|之前|歷史|找對話|搜尋對話)/i, ['memory', 'session-search']);
    add(/(排程|提醒|schedule|定時|每天|明天|下週|cron)/i, ['chronos', 'collab-calendar']);
    add(/(行程|行事曆|日曆|calendar|今天有什麼|明天有什麼|這週|下週|新增行程|加入行程|排行程|有什麼約|約了什麼|協作日曆)/i, ['collab-calendar']);
    add(/(圖片|影像|畫圖|生成圖|image|prompt)/i, ['image-prompt']);
    add(/(youtube|影片|字幕)/i, ['youtube']);
    add(/(notebooklm|研究包|study pack|mind map|audio overview|slide deck|flashcards|quiz)/i, ['notebooklm-studio']);
    add(/(spotify|音樂|播放清單)/i, ['spotify']);
    add(/(代理|agent|multi-agent|協作|委派|delegate)/i, ['multi-agent', 'delegate-task']);
    add(/(檔案|附件|參考資料|reference)/i, ['reference-files']);

    const isM365DataTask = M365_DATA_RE.test(t);
    if (isM365DataTask) {
        add(/(狀態|連線|在線|status|connect)/i, ['m365-session-bridge/m365_bridge_status']);
        add(/(列出|列舉|查看.*資料夾|資料夾.*檔案|有哪些檔案|folder.*(?:list|content)|list.*folder|enumerate)/i, ['m365-session-bridge/m365_list_folder']);
        add(/(下載|download)/i, ['m365-session-bridge/m365_download_file']);
        add(/(上傳|upload)/i, ['m365-session-bridge/m365_upload_file']);
        add(/(複製|copy)/i, ['m365-session-bridge/m365_copy_file']);
        add(/(移動|move)/i, ['m365-session-bridge/m365_move_file']);
        add(/(重新命名|改名|rename)/i, ['m365-session-bridge/m365_rename_file', 'm365-session-bridge/m365_rename_folder']);
        add(/(建立|新增|create).{0,8}(資料夾|folder)/i, ['m365-session-bridge/m365_create_folder']);
        add(/(版本紀錄|版本歷程|歷史版本|version history|list.*version)/i, ['m365-session-bridge/m365_list_file_versions']);
        add(/(還原|restore).{0,8}(版本|version)/i, ['m365-session-bridge/m365_restore_file_version']);
        add(/(簽出|check.?out)/i, ['m365-session-bridge/m365_checkout_file']);
        add(/(簽入|check.?in)/i, ['m365-session-bridge/m365_checkin_file']);
        add(/(中繼資料|metadata|欄位值)/i, ['m365-session-bridge/m365_update_file_metadata']);
        add(/(檔案網址|檔案連結|canonical.*url|get.*file.*url)/i, ['m365-session-bridge/m365_get_file_url']);
        add(/(回收|recycle)/i, ['m365-session-bridge/m365_recycle_file', 'm365-session-bridge/m365_recycle_folder']);
    }

    return boosts;
}

function scoreCandidate(query, candidate) {
    const haystack = normalizeText([
        candidate.id,
        candidate.name,
        candidate.description,
        candidate.action,
        ...(candidate.triggers || []),
        candidate.content || '',
    ].join('\n'));
    const terms = extractTerms(query);
    let score = 0;

    for (const term of terms) {
        if (!term) continue;
        if (haystack.includes(term)) score += term.length >= 3 ? 2 : 1;
    }

    for (const id of inferIntentBoosts(query)) {
        if (candidate.id === id || candidate.action === id || candidate.server === id) score += 8;
    }

    if ((candidate.triggers || []).some(trigger => normalizeText(query).includes(normalizeText(trigger)))) {
        score += 10;
    }

    return score;
}

function loadMcpServers() {
    try {
        if (!fs.existsSync(MCP_CONFIG_PATH)) return [];
        const servers = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'));
        return Array.isArray(servers) ? servers.filter(server => server.enabled !== false) : [];
    } catch (_) {
        return [];
    }
}

function summarizeSchema(schema) {
    if (!schema || typeof schema !== 'object') return '';
    const properties = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
    const required = Array.isArray(schema.required) ? schema.required : [];
    const bits = [];
    if (properties.length > 0) bits.push(`params: ${properties.slice(0, 8).join(', ')}`);
    if (required.length > 0) bits.push(`required: ${required.slice(0, 8).join(', ')}`);
    return bits.join('; ');
}

function compactJson(value) {
    return JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
}

function summarizeSkillGuide(content, maxChars = 1000) {
    const cleaned = String(content || '')
        .replace(/<\/?SkillModule[^>]*>/gi, '')
        .replace(/\r/g, '')
        .trim();
    if (!cleaned) return '';
    if (cleaned.length <= maxChars) return cleaned;

    const marker = cleaned.search(/(?:Action\s*格式|使用方式|使用時機|何時使用|參數格式|範例|Example|Usage)/i);
    const head = cleaned.slice(0, Math.min(420, maxChars));
    if (marker < 0 || marker < head.length) {
        return `${cleaned.slice(0, maxChars - 20).trim()}\n…(guide truncated)`;
    }
    const remaining = Math.max(200, maxChars - head.length - 25);
    return `${head.trim()}\n…\n${cleaned.slice(marker, marker + remaining).trim()}\n…(guide truncated)`;
}

function summarizeCatalogDescription(value, maxChars = 180) {
    const cleaned = String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';
    if (cleaned.length <= maxChars) return cleaned;
    return `${cleaned.slice(0, maxChars - 1).trim()}…`;
}

function isLikelyCommandTask(query) {
    const text = String(query || '');
    if (!text.trim()) return false;
    if (LOCAL_ARTIFACT_BUILD_RE.test(text) && !EXPLICIT_REMOTE_ARTIFACT_TARGET_RE.test(text)) return true;
    if (!LOCAL_COMMAND_RE.test(text)) return false;
    if (EXTERNAL_SYSTEM_RE.test(text)) return false;
    return true;
}

function loadCoreSlashCommands() {
    try {
        const defs = require('../config/commands');
        const keep = new Set(['/new', '/new_memory', '/skills', '/learn', '/install', '/toolset', '/search', '/project']);
        return (Array.isArray(defs) ? defs : [])
            .filter((item) => item && keep.has(String(item.command || '').trim()))
            .map((item) => ({
                command: String(item.command || '').trim(),
                description: String(item.description || '').trim()
            }));
    } catch (_) {
        return [];
    }
}

class ToolRouter {
    constructor(options = {}) {
        this.userDataDir = options.userDataDir || null;
        this.activeTools = Array.isArray(options.activeTools) ? options.activeTools : null;
        this.activeScene = options.activeScene || toolsetManager.getActiveScene();
        this.policy = options.policy || new ToolUsePolicy();
        this.toolVectorIndex = options.toolVectorIndex || null; // 由 GolemBrain 注入
        this.mcpServers = Array.isArray(options.mcpServers) ? options.mcpServers : null;
    }

    async routeAsync(query, options = {}) {
        // 若有向量索引，先做語意搜尋取得 boost 清單
        let vectorBoostIds = new Set();
        if (this.toolVectorIndex) {
            try {
                const vectorResults = await this.toolVectorIndex.search(query, { limit: 10 });
                for (const r of vectorResults) {
                    if (r.score > 0.35) vectorBoostIds.add(r.id); // 相似度門檻
                }
            } catch (e) {
                console.warn(`[ToolRouter] 向量搜尋失敗，退回關鍵字模式: ${e.message}`);
            }
        }
        return this.route(query, { ...options, vectorBoostIds });
    }

    route(query, options = {}) {
        const maxSkills = Number(options.maxSkills || 5);
        const maxMcpTools = Number(options.maxMcpTools || 6);
        const activeTools = new Set(this.activeTools || toolsetManager.getActiveTools());
        const preferredSkillIds = new Set((options.preferredSkillIds || []).map(normalizeText));
        const preferredSkillActions = new Set((options.preferredSkillActions || []).map(normalizeText));
        const preferredMcpServers = new Set((options.preferredMcpServers || []).map(normalizeText));
        const requestClass = this.policy.classifyRequest(query);
        const vectorBoostIds = options.vectorBoostIds instanceof Set ? options.vectorBoostIds : new Set();
        const exactMcpIntentIds = new Set(
            inferIntentBoosts(query).filter((id) => id.startsWith('m365-session-bridge/'))
        );
        const hasExactMcpRoute = exactMcpIntentIds.size > 0;
        const hasUnsupportedM365Search = M365_DATA_RE.test(String(query || ''))
            && M365_SEARCH_RE.test(String(query || ''))
            && !hasExactMcpRoute;
        const connectorBoundary = hasUnsupportedM365Search
            ? {
                code: 'm365_exact_url_only',
                message: 'm365-session-bridge does not provide tenant-wide, semantic, Outlook, Teams, Calendar, or general Microsoft 365 search. It only operates on exact SharePoint Online or OneDrive for Business URLs and folders.',
            }
            : null;

        const skillCandidates = SkillPackageRegistry.listSkillPackages({ userDataDir: this.userDataDir })
            .filter(pkg => pkg.enabled !== false)
            .map(pkg => {
                const content = SkillPackageRegistry.readPackagePrompt(pkg).slice(0, 2500);
                const manifest = pkg.manifest || {};
                return {
                    kind: 'skill',
                    id: pkg.id,
                    name: pkg.name || pkg.id,
                    description: pkg.description || '',
                    action: pkg.action || pkg.id,
                    triggers: manifest.triggers || [],
                    hasRuntime: fs.existsSync(pkg.indexPath),
                    preferred: preferredSkillIds.has(normalizeText(pkg.id)) || preferredSkillActions.has(normalizeText(pkg.action)),
                    allowed: activeTools.has(pkg.id) || activeTools.has(pkg.action)
                        || preferredSkillIds.has(normalizeText(pkg.id))
                        || preferredSkillActions.has(normalizeText(pkg.action)),
                    semanticBoost: false,
                    content,
                    score: 0,
                };
            });

        for (const candidate of skillCandidates) {
            candidate.score = scoreCandidate(query, candidate);
            if (candidate.allowed) candidate.score += 2;
            if (candidate.preferred) {
                candidate.semanticBoost = true;
                candidate.score += 100;
            }
            // 向量語意 boost：命中向量搜尋結果的技能額外加分
            if (vectorBoostIds.has(candidate.id) || vectorBoostIds.has(candidate.action)) {
                candidate.semanticBoost = true;
                candidate.score += 12;
            }
        }

        const catalogRequest = {
            skills: requestClass.skillCatalog === true,
        };
        const skillCatalog = catalogRequest.skills
            ? skillCandidates
                .filter((candidate) => candidate.allowed)
                .map((candidate) => ({
                    id: candidate.id,
                    name: candidate.name,
                    description: summarizeCatalogDescription(candidate.description || candidate.name),
                    action: candidate.action,
                    hasRuntime: candidate.hasRuntime,
                }))
                .sort((a, b) => a.id.localeCompare(b.id))
            : [];
        const inactiveSkillCount = catalogRequest.skills
            ? skillCandidates.filter((candidate) => !candidate.allowed).length
            : 0;

        const skills = (catalogRequest.skills && !requestClass.explicitAction)
            || hasExactMcpRoute
            || hasUnsupportedM365Search
            ? []
            : this.policy.filter(query, skillCandidates)
                .sort((a, b) => b.score - a.score)
                .slice(0, maxSkills);

        const mcpTools = [];
        const mcpServers = (this.mcpServers || loadMcpServers())
            .filter((server) => server && server.enabled !== false);
        for (const server of mcpServers) {
            const serverDesc = String(server.description || '').trim();
            for (const tool of server.cachedTools || []) {
                const catalogTool = MCPToolCatalog.findTool(server.name, tool.name, [server]);
                const candidate = {
                    kind: 'mcp',
                    server: server.name,
                    id: `${server.name}/${tool.name}`,
                    name: tool.name,
                    description: tool.description || '',
                    inputSchema: tool.inputSchema || tool.schema || null,
                    example: catalogTool?.example || MCPToolCatalog.buildActionExample(server.name, tool.name, tool.inputSchema || tool.schema || {}),
                    content: `${server.name} ${serverDesc} ${tool.name} ${tool.description || ''}`,
                    semanticBoost: false,
                    preferred: preferredMcpServers.has(normalizeText(server.name)),
                    score: 0,
                };
                candidate.score = scoreCandidate(query, candidate);
                if (candidate.preferred) {
                    candidate.semanticBoost = true;
                    candidate.score += 100;
                }
                mcpTools.push(candidate);
            }
        }

        // 向量語意 boost for MCP tools
        for (const candidate of mcpTools) {
            if (vectorBoostIds.has(candidate.id)) {
                candidate.semanticBoost = true;
                candidate.score += 12;
            }
        }

        const filteredMcpTools = this.policy.filter(query, mcpTools)
            .sort((a, b) => b.score - a.score);
        const intentMatchedMcpTools = hasUnsupportedM365Search
            ? []
            : hasExactMcpRoute
            ? filteredMcpTools.filter((candidate) => exactMcpIntentIds.has(candidate.id))
            : filteredMcpTools;
        const routedMcpTools = catalogRequest.skills && !requestClass.explicitAction
            ? []
            : intentMatchedMcpTools.slice(0, maxMcpTools);

        const commandRecommended = requestClass.shouldRoute && isLikelyCommandTask(query);
        const localArtifactBuild = commandRecommended
            && LOCAL_ARTIFACT_BUILD_RE.test(String(query || ''))
            && !EXPLICIT_REMOTE_ARTIFACT_TARGET_RE.test(String(query || ''));
        const commandLane = {
            recommended: commandRecommended,
            reason: localArtifactBuild
                ? 'local_project_artifact_authoring'
                : commandRecommended
                    ? 'local_os_or_repo_operation'
                    : 'prefer_skill_or_mcp_or_text',
        };

        return {
            skills,
            skillCatalog,
            inactiveSkillCount,
            catalogRequest,
            connectorBoundary,
            mcpTools: routedMcpTools,
            commandLane,
            slashCommands: loadCoreSlashCommands(),
            activeScene: this.activeScene,
        };
    }

    buildRoutingHint(query, options = {}) {
        const result = this.route(query, options);
        return this._formatRoutingHint(result);
    }

    async buildRoutingHintAsync(query, options = {}) {
        const result = await this.routeAsync(query, options);
        return this._formatRoutingHint(result);
    }

    _formatRoutingHint(result) {
        if (
            result.skills.length === 0
            && result.mcpTools.length === 0
            && !result.commandLane.recommended
            && !result.catalogRequest?.skills
            && !result.connectorBoundary
        ) return '';

        const lines = [
            '<tool-routing>',
            `[System note: 以下是本輪依使用者訊息自動產生的工具建議。若任務符合，優先使用；若不符合，可以忽略。當工具能取得事實、操作外部系統或執行專門能力時，不要只用文字猜測。Active scene: ${result.activeScene}]`,
        ];

        if (result.catalogRequest?.skills) {
            lines.push(`Current available Skill catalog (${result.skillCatalog.length}; authoritative for this turn):`);
            if (result.skillCatalog.length === 0) {
                lines.push('- No packaged Skill is active in the current toolset. State that clearly.');
            } else {
                for (const skill of result.skillCatalog) {
                    const runtime = skill.hasRuntime ? `action=${skill.action}` : 'prompt-only';
                    const description = skill.description ? ` — ${skill.description}` : '';
                    lines.push(`- ${skill.id} (${skill.name || skill.id}): ${runtime}${description}`);
                }
            }
            if (result.inactiveSkillCount > 0) {
                lines.push(`- ${result.inactiveSkillCount} other installed Skill package(s) are not active in the current scene; do not present them as currently available.`);
            }
            lines.push('- Answer the inventory question directly from this catalog. Do not claim that no Skill list was provided.');
            lines.push('- This catalog is informational. Do not emit a tool action merely to answer this inventory question; when the user later requests a task, the normal per-turn vector route will provide the selected Skill usage guide and exact fields.');
        }

        if (result.connectorBoundary?.code === 'm365_exact_url_only') {
            lines.push('M365 connector boundary:');
            lines.push(`- ${result.connectorBoundary.message}`);
            lines.push('- Do not emit a GOLEM_ACTION for tenant-wide or semantic M365 search with this connector. Explain the limitation and ask for an exact SharePoint/OneDrive URL, or state that a separate officially authorized connector/API is required.');
            lines.push('</tool-routing>');
            return lines.join('\n');
        }

        if (result.commandLane.recommended) {
            lines.push('Relevant command lane:');
            if (result.commandLane.reason === 'local_project_artifact_authoring') {
                lines.push('- command: local project artifact creation or modification detected. Use the assigned project workspace to inspect, create/edit, and verify the real files; do not substitute a long inline draft unless the user explicitly asked only for a snippet.');
                lines.push('- Exact action shape: {"action":"command","parameter":"<one bounded native command>"}. Emit the smallest appropriate command action now. When the outcome needs dependent inspect/build/verify work, maintain GOLEM_PLAN and issue only its current bounded action.');
            } else {
                lines.push('- command: local OS/repo operation detected. For the current Windows harness, inspect its working directory with this exact shell action: {"action":"command","parameter":"echo %CD%"}. Replace the command only when another native operation is required.');
                lines.push('- The user already requested this read/list/inspect/check operation. Emit the smallest read-only command action now; do not merely say that you could propose it. The local approval gate will ask for confirmation.');
            }
        }

        if (result.skills.length > 0) {
            lines.push('Relevant skills:');
            for (const skill of result.skills) {
                const runtime = skill.hasRuntime ? `action: ${skill.action}` : 'prompt-only';
                const disabled = skill.allowed ? '' : ' (目前 toolset 可能未啟用，必要時請引導切換 toolset)';
                const policy = skill.policy ? ` [${skill.policy.strength}; risk=${skill.policy.risk}${skill.policy.requiresConfirmation ? '; confirm first' : ''}]` : '';
                lines.push(`- ${skill.id}: ${runtime}. ${skill.description || skill.name}${disabled}${policy}`);
                const guide = summarizeSkillGuide(skill.content);
                if (guide) {
                    lines.push(`  Selected usage guide (preserve its exact field names):\n  ${guide.replace(/\n/g, '\n  ')}`);
                } else if (skill.hasRuntime) {
                    lines.push(`  Minimal action shape: {"action":"${skill.action}"}`);
                }
            }
        }

        if (result.mcpTools.length > 0) {
            lines.push('Relevant MCP tools:');
            for (const tool of result.mcpTools) {
                const schemaSummary = summarizeSchema(tool.inputSchema);
                const policy = tool.policy ? ` [${tool.policy.strength}; risk=${tool.policy.risk}${tool.policy.requiresConfirmation ? '; confirm first' : ''}]` : '';
                lines.push(`- mcp_call server="${tool.server}" tool="${tool.name}": ${tool.description || 'no description'}${schemaSummary ? ` (${schemaSummary})` : ''}${policy}`);
                lines.push(`  Use this exact action shape:\n  ${compactJson(tool.example)}`);
            }
        }

        lines.push('Decision rules:');
        lines.push('- Route priority: local OS/repo work => command; packaged capability => skill action; external integration/service/browser connector => mcp_call.');
        lines.push('- If the user explicitly requested an operation and a viable route is listed above, emit the action in this response. Do not answer only with capability narration such as "I can propose an action".');
        lines.push('- Never use mcp_call for pure local shell tasks. Never use command for external connector tasks that already have MCP tools.');
        lines.push('- For public web search tasks, prefer skill action {"action":"duckduckgo-search","args":{"query":"..."}}. Use chrome-devtools only when the task requires browser interaction, login, DOM, console, or network inspection.');
        lines.push('- For browse-and-read tasks, prefer a 2-step MCP action array: (1) navigate_page/new_page, then (2) take_snapshot, and summarize from snapshot.');
        lines.push(...this.policy.buildRules());
        if (result.slashCommands.length > 0) {
            lines.push('Core slash commands (can be triggered directly when user asks):');
            for (const item of result.slashCommands) {
                lines.push(`- ${item.command}: ${item.description}`);
            }
        }
        lines.push('- 若推薦工具不足以完成任務，先用可用工具探測，不要杜撰不存在的工具。');
        lines.push('</tool-routing>');
        return lines.join('\n');
    }
}

module.exports = ToolRouter;
