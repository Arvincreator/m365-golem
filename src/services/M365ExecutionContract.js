'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const ToolUsePolicy = require('../managers/ToolUsePolicy');

const DEFERRED_EXECUTION_RE = /(?:尚未|還沒|沒有).{0,28}(?:能力|工具|執行結果|驗證|取得)|(?:不能|無法).{0,28}(?:建立|執行|確認|宣稱)|(?:建議|下一步|如果你希望|可以嘗試|可以試)/i;
const LOCAL_LIST_RE = /(?:(?:工作區|本機|資料夾|目錄).{0,18}(?:檔案|內容|清單)|(?:列出|列舉|查看|檢查|盤點).{0,18}(?:工作區|本機|資料夾|目錄))/i;
const LOCAL_TARGET_RE = /(?:工作區|專案資料夾|本機|本地|桌面|project\s+workspace|workspace|local|desktop)/i;
const ARTIFACT_TYPES = [
    { extension: '.docx', pattern: /(?:word|docx|word\s*文件|word\s*檔)/i },
    { extension: '.xlsx', pattern: /(?:excel|xlsx|試算表)/i },
    { extension: '.pptx', pattern: /(?:powerpoint|pptx|簡報)/i },
    { extension: '.pdf', pattern: /(?:pdf)/i },
    { extension: '.html', pattern: /(?:html|網頁|網站)/i },
];
const LIST_EXECUTABLES = new Set(['dir', 'ls', 'get-childitem', 'gci', 'cmd', 'powershell', 'powershell.exe', 'pwsh', 'python', 'python.exe', 'py']);
const SKIP_DIRS = new Set(['.git', '.golem', 'node_modules']);
const UNVERIFIED_CAPABILITY_STOP_RE = /(?:沒有|尚未|未取得|找不到|不能|無法).{0,36}(?:工具|能力|執行結果|驗證|建立|操作)|(?:工具|能力).{0,24}(?:不可用|不存在|不確定)/i;
const REPEATED_PERMISSION_RE = /(?:(?:是否|要不要|可不可以|同意|允許).{0,32}(?:嘗試|執行|繼續|檢查|建立|操作)|(?:if\s+you\s+want|would\s+you\s+like).{0,32}(?:try|continue|proceed))/i;
const EXECUTION_PROGRESS_SUFFIX = '，正在執行並確認中…';
const UNSAFE_PROGRESS_RE = /(?:https?:\/\/|[a-z]:\\|GOLEM_|Observation|harness|tool-routing|MCP|Skill|PowerShell|cmd(?:\.exe)?|python(?:\.exe)?|node(?:\.exe)?|已完成|成功|失敗|無法)/i;
const NATIVE_ATTACHMENT_ANALYSIS_RE = /(?:附件|attached\s+files?|files?\s+attached).{0,48}(?:讀|閱讀|查看|檢視|分析|比較|摘要|整理|說明|建議|歸納)|(?:讀|閱讀|查看|檢視|分析|比較|摘要|整理|說明|建議|歸納).{0,48}(?:附件|attached\s+files?|files?\s+attached)/i;
const ATTACHMENT_MUTATION_RE = /(?:修改|編輯|重寫|改寫|轉換|建立|產生|製作|儲存|下載|上傳|寄送|發送|刪除|重新命名|move|rename|delete|upload|download|create|generate|edit|rewrite|convert)/i;

function requiresLocalWorkspaceListing(text) {
    const value = String(text || '');
    return LOCAL_LIST_RE.test(value) && LOCAL_TARGET_RE.test(value);
}

function cleanProgressLabel(value) {
    const rawLabel = String(value || '');
    const cleanLabel = rawLabel
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/[a-z]:\\[^\s]+/gi, '')
        .replace(/\[[^\]\r\n]{0,120}\]/g, '')
        .replace(/[`*_#{}<>]/g, '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[\s,，.。:：;；…]+$/g, '')
        .trim();
    if (!cleanLabel || UNSAFE_PROGRESS_RE.test(cleanLabel)) return '';
    return cleanLabel;
}

function inferActionProgressLabel(action = {}) {
    const supplied = cleanProgressLabel(action.progress || action.progressText || action.description);
    if (supplied) return supplied;

    const actionName = String(action.action || '').trim().toLowerCase().replace(/_/g, '-');
    const command = String(action.parameter || action.command || action.parameters?.command || '');
    const searchable = `${actionName} ${command} ${action.server || ''} ${action.tool || ''}`.toLowerCase();
    const artifactName = /(?:docx|python-docx|word\/document\.xml)/i.test(searchable) ? 'Word 文件'
        : /(?:xlsx|spreadsheet|workbook|xl\/workbook\.xml)/i.test(searchable) ? 'Excel 文件'
            : /(?:pptx|powerpoint|presentation|ppt\/presentation\.xml)/i.test(searchable) ? '簡報'
                : /(?:pdf)/i.test(searchable) ? 'PDF 文件'
                    : /(?:html|webpage)/i.test(searchable) ? '網頁文件'
                        : '';
    if (/(?:test-path|exists|testzip|assert|document\.xml|workbook\.xml|presentation\.xml|validate|verify|驗證|核對)/i.test(searchable)) {
        return artifactName ? `驗證${artifactName}的存在、格式與內容` : '核對實際結果與完成條件';
    }
    if (/(?:golem-check|\bwhere(?:\.exe)?\b|get-command|import\s+\w+|importlib|--version|capabilit)/i.test(searchable)) {
        return '檢查可用執行環境與所需能力';
    }
    if (/(?:get-childitem|\bdir\b|\bls\b|readdir|list(?:files?|folder)?)/i.test(searchable)) {
        return '讀取工作區並核對實際檔案清單';
    }
    if (/(?:mkdir|new-item.{0,24}(?:directory|folder)|create.?folder)/i.test(searchable)) {
        return '建立指定資料夾並確認實際位置';
    }
    if (artifactName && /(?:save\s*\(|write(?:file|zip)?|document\s*\(|workbook\s*\(|presentation\s*\(|create|建立)/i.test(searchable)) {
        return `建立${artifactName}並寫入指定內容`;
    }
    if (actionName === 'mcp-call' || /(?:search|find|query)/i.test(searchable)) {
        return '查詢指定資料並核對實際結果';
    }
    if (/(?:read|get|fetch|inspect|check)/i.test(searchable)) return '讀取指定資料並確認實際內容';
    if (/(?:copy|move|rename|upload|download|create|write|update)/i.test(searchable)) return '執行指定操作並確認實際結果';
    return actionName === 'command' || actionName === 'sys-admin'
        ? '執行本機操作並確認實際結果'
        : '執行目前操作並確認實際結果';
}

function buildExecutionProgressText(action, fallback = '執行目前操作並確認實際結果') {
    const cleanLabel = inferActionProgressLabel(action) || cleanProgressLabel(fallback) || '執行目前操作並確認實際結果';
    const maxLabelLength = Math.max(1, 50 - Array.from(EXECUTION_PROGRESS_SUFFIX).length);
    const label = Array.from(cleanLabel).slice(0, maxLabelLength).join('');
    return `${label}${EXECUTION_PROGRESS_SUFFIX}`;
}

function classifyExecutionExpectation(query, route, reply = '', context = {}) {
    const request = new ToolUsePolicy().classifyRequest(query);
    const queryText = String(query || '');
    const local = route?.commandLane?.recommended === true;
    const routedTools = [...(route?.skills || []), ...(route?.mcpTools || [])];
    const routedTool = routedTools.length > 0;
    const hasReadOnlyRoute = routedTools.some((tool) => tool?.policy?.risk === 'read');

    // Explicit tests and capability checks must produce evidence when a safe
    // read-only route was selected. General explanation/advice may still use
    // tools autonomously, but remains optional rather than contract-enforced.
    if ((request.verificationIntent || request.capabilityProbe) && hasReadOnlyRoute) {
        return { required: true, reason: 'read_only_verification', local: false };
    }
    // Files already attached to the current Copilot turn are a native M365
    // input. Reading, comparing, or summarizing them does not require a fake
    // local command merely to manufacture a host Observation.
    if (Number(context.nativeAttachmentCount || 0) > 0
        && NATIVE_ATTACHMENT_ANALYSIS_RE.test(queryText)
        && !ATTACHMENT_MUTATION_RE.test(queryText)) {
        return { required: false, reason: 'native_attachment_analysis', local: false };
    }
    if (!request.explicitAction || request.passive) return { required: false, reason: 'optional_or_non_execution' };
    if (local) return { required: true, reason: route.commandLane.reason || 'local_execution', local: true };
    // Route metadata is advisory. Explicit local work must remain actionable
    // even if a concurrent catalog refresh replaced the active router.
    if (LOCAL_TARGET_RE.test(queryText)) {
        return { required: true, reason: 'explicit_local_execution', local: true };
    }
    if (routedTool && DEFERRED_EXECUTION_RE.test(String(reply || ''))) {
        return { required: true, reason: 'routed_tool_deferred', local: false };
    }
    return { required: false, reason: 'native_or_answerable_without_host_action' };
}

function inferVerification(query, route) {
    const text = String(query || '');
    const artifact = ARTIFACT_TYPES.find((item) => item.pattern.test(text));
    if (artifact) {
        return `A host Observation and an independent workspace check prove that a newly created ${artifact.extension} file exists inside the assigned project workspace and has a valid real file format and requested content.`;
    }
    if (requiresLocalWorkspaceListing(text)) {
        return 'A host Observation from a local directory-listing operation contains the actual workspace entries, or explicitly proves that the directory is empty.';
    }
    return route?.commandLane?.recommended
        ? 'A host Observation proves the requested local operation completed and its result was verified.'
        : 'A host Observation or visible native result proves the user-requested outcome.';
}

function describeAction(action = {}) {
    const name = String(action.action || '').trim().toLowerCase();
    if (name === 'command' || name === 'sys-admin') {
        const command = String(action.parameter || action.command || action.parameters?.command || '').trim();
        const first = command.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
        const executable = path.basename(String(first?.[1] || first?.[2] || first?.[3] || '')).toLowerCase();
        return { kind: 'command', executable: executable.slice(0, 120) };
    }
    if (name === 'mcp_call') {
        return {
            kind: 'mcp',
            server: String(action.server || '').trim().slice(0, 120),
            tool: String(action.tool || '').trim().slice(0, 120),
        };
    }
    return { kind: name === 'plan_checkpoint' ? 'native' : 'skill', action: name.slice(0, 120) };
}

function classifyUnverifiedStop(plan, events = []) {
    if (!['blocked', 'wait_user'].includes(plan?.status)) return null;
    const observations = events.filter((event) => event.eventType === 'autonomous_observation_recorded');
    const hasFailedEvidence = observations.some((event) => ['failed', 'denied'].includes(event.payload?.status));
    const question = String(plan.question || '');
    if (!hasFailedEvidence && UNVERIFIED_CAPABILITY_STOP_RE.test(question)) return 'unverified_capability_blocker';
    if (!hasFailedEvidence && REPEATED_PERMISSION_RE.test(question)) return 'repeated_permission_request';
    return null;
}

function isValidPackage(filePath, extension) {
    try {
        if (extension === '.pdf' || extension === '.html') {
            const length = extension === '.pdf' ? 5 : 4096;
            const handle = fs.openSync(filePath, 'r');
            try {
                const buffer = Buffer.alloc(length);
                const bytesRead = fs.readSync(handle, buffer, 0, length, 0);
                const header = buffer.subarray(0, bytesRead);
                if (extension === '.pdf') return header.toString() === '%PDF-';
                return /<(?:!doctype\s+html|html)\b/i.test(header.toString('utf8'));
            } finally {
                fs.closeSync(handle);
            }
        }
        const archive = new AdmZip(filePath);
        const required = {
            '.docx': ['[Content_Types].xml', 'word/document.xml'],
            '.xlsx': ['[Content_Types].xml', 'xl/workbook.xml'],
            '.pptx': ['[Content_Types].xml', 'ppt/presentation.xml'],
        }[extension] || [];
        return required.every((entry) => Boolean(archive.getEntry(entry)));
    } catch (_) {
        return false;
    }
}

function findRecentValidArtifacts(rootPath, extension, startedAt, options = {}) {
    const root = path.resolve(String(rootPath || ''));
    if (!rootPath || root === path.parse(root).root || !fs.existsSync(root)) return [];
    const since = Math.max(0, Date.parse(startedAt || '') - 5000) || 0;
    const maxEntries = Math.max(1, Math.min(Number(options.maxEntries || 5000), 10000));
    const matches = [];
    let visited = 0;
    const walk = (directory, depth) => {
        if (depth > 8 || visited >= maxEntries) return;
        let entries;
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
            if (visited++ >= maxEntries) return;
            if (entry.isSymbolicLink()) continue;
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) walk(target, depth + 1);
                continue;
            }
            if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== extension) continue;
            try {
                const stat = fs.statSync(target);
                if (stat.mtimeMs >= since && stat.size > 0 && isValidPackage(target, extension)) {
                    matches.push(path.relative(root, target));
                }
            } catch (_) { }
        }
    };
    walk(root, 0);
    return matches;
}

function decodeOfficeXml(xml) {
    return String(xml || '')
        .replace(/<w:tab\s*\/>/gi, '\t')
        .replace(/<(?:w:br|a:br)\s*\/>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
        .replace(/&#([0-9]+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function readArtifactText(rootPath, relativePath, extension) {
    try {
        const root = path.resolve(String(rootPath || ''));
        const target = path.resolve(root, String(relativePath || ''));
        if (!target.startsWith(`${root}${path.sep}`)) return '';
        if (extension === '.html') {
            const handle = fs.openSync(target, 'r');
            try {
                const buffer = Buffer.alloc(1024 * 1024);
                const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
                return decodeOfficeXml(buffer.subarray(0, bytesRead).toString('utf8'));
            } finally {
                fs.closeSync(handle);
            }
        }
        const archive = new AdmZip(target);
        const patterns = {
            '.docx': [/^word\/document\.xml$/i],
            '.xlsx': [/^xl\/sharedStrings\.xml$/i, /^xl\/worksheets\/sheet\d+\.xml$/i],
            '.pptx': [/^ppt\/slides\/slide\d+\.xml$/i],
        }[extension];
        if (!patterns) return '';
        const parts = [];
        let totalBytes = 0;
        for (const entry of archive.getEntries()) {
            if (!patterns.some((pattern) => pattern.test(entry.entryName))) continue;
            const declaredBytes = Number(entry?.header?.size || 0);
            if (declaredBytes > 4 * 1024 * 1024 || totalBytes + declaredBytes > 8 * 1024 * 1024) return '';
            const value = archive.readAsText(entry);
            totalBytes += Buffer.byteLength(value, 'utf8');
            if (totalBytes > 8 * 1024 * 1024) return '';
            parts.push(decodeOfficeXml(value));
        }
        return parts.join('\n');
    } catch (_) {
        return '';
    }
}

function extractArtifactRequirements(text, extension) {
    const objective = String(text || '');
    const escapedExtension = extension.replace('.', '\\.');
    const filePattern = new RegExp(
        `(?:檔名|文件名|file\\s*name)\\s*(?:為|是|[:：])?\\s*[「“\"']?([^「」“”\"'\\r\\n<>\\/\\\\|?*]{1,180}${escapedExtension})[」”\"']?`,
        'i'
    );
    const fileName = String(objective.match(filePattern)?.[1] || '').trim();
    const phrases = [];
    const title = objective.match(/(?:標題|title)\s*(?:為|是|[:：])?\s*[「“"']([^」”"'\r\n]{1,200})[」”"']/i)?.[1];
    if (title) phrases.push(title.trim());
    const list = objective.match(/(?:三點|三項|要點|項目)\s*[:：]\s*([^。\r\n]{1,300})/i)?.[1];
    if (list) {
        for (const item of list.split(/[、,，;；]/)) {
            const phrase = item.replace(/[「」“”"']/g, '').trim();
            if (phrase) phrases.push(phrase);
        }
    }
    return { fileName, phrases: [...new Set(phrases)] };
}

function validatePlanCompletion({ plan, run, events = [], workspaceRoot = '' }) {
    const issues = [];
    const observations = events.filter((event) => event.eventType === 'autonomous_observation_recorded'
        && event.payload?.status === 'succeeded');
    const planned = events.filter((event) => event.eventType === 'autonomous_action_planned');
    const completedSteps = plan.steps.filter((step) => step.status === 'completed');
    for (const step of completedSteps) {
        if (!observations.some((event) => event.payload?.planStepId === step.id)) {
            issues.push(`step_without_host_observation:${step.id}`);
        }
    }
    if (completedSteps.length === 0 || observations.length === 0) issues.push('no_successful_host_observation');

    const objectiveText = String(run.objective || '');
    const goalText = `${objectiveText} ${plan.goal || ''} ${plan.completionCriteria || ''}`;
    if (requiresLocalWorkspaceListing(goalText)) {
        const successfulIds = new Set(observations.map((event) => event.payload?.actionId));
        const hasLocalListing = planned.some((event) => successfulIds.has(event.payload?.actionId)
            && event.payload?.actionDescriptor?.kind === 'command'
            && LIST_EXECUTABLES.has(event.payload?.actionDescriptor?.executable));
        if (!hasLocalListing) issues.push('workspace_listing_not_observed');
    }

    const artifact = ARTIFACT_TYPES.find((item) => item.pattern.test(goalText));
    let artifacts = [];
    if (artifact) {
        artifacts = findRecentValidArtifacts(workspaceRoot, artifact.extension, run.startedAt || run.createdAt);
        if (artifacts.length === 0) issues.push(`valid_artifact_not_found:${artifact.extension}`);
        const requirements = extractArtifactRequirements(objectiveText, artifact.extension);
        let requestedArtifacts = artifacts;
        if (requirements.fileName) {
            requestedArtifacts = artifacts.filter((item) => path.basename(item).toLowerCase() === requirements.fileName.toLowerCase());
            if (requestedArtifacts.length === 0) issues.push(`requested_artifact_filename_not_found:${artifact.extension}`);
        }
        if (requirements.phrases.length > 0 && ['.docx', '.xlsx', '.pptx', '.html'].includes(artifact.extension)) {
            const contentMatches = requestedArtifacts.some((item) => {
                const artifactText = readArtifactText(workspaceRoot, item, artifact.extension);
                return artifactText && requirements.phrases.every((phrase) => artifactText.includes(phrase));
            });
            if (!contentMatches) issues.push(`requested_artifact_content_not_found:${artifact.extension}`);
        }
    }
    return { ok: issues.length === 0, issues: [...new Set(issues)], artifacts };
}

module.exports = {
    buildExecutionProgressText,
    classifyUnverifiedStop,
    classifyExecutionExpectation,
    describeAction,
    findRecentValidArtifacts,
    extractArtifactRequirements,
    inferActionProgressLabel,
    inferVerification,
    validatePlanCompletion,
};
