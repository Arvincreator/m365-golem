'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ProjectRuleVectorIndex = require('../managers/ProjectRuleVectorIndex');

const MAX_AGENTS_CHARS = 250000;
const MAX_MEMORY_ENTRIES = 200;
const MAX_MEMORY_CONTENT_CHARS = 2000;
const MAX_MEMORY_TAGS = 8;
const MAX_MEMORY_TAG_CHARS = 64;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const WORKSPACE_MODES = new Set(['managed', 'create', 'existing']);
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MEMORY_KINDS = new Set(['rule', 'context', 'decision', 'preference']);
const MEMORY_IMPORTANCE = new Set(['core', 'normal']);

function workspaceError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function normalizeWorkspaceMode(value) {
    const mode = String(value || 'managed').trim().toLowerCase();
    if (!WORKSPACE_MODES.has(mode)) {
        throw workspaceError(
            'M365_PROJECT_WORKSPACE_MODE_INVALID',
            'Workspace mode must be managed, create, or existing.'
        );
    }
    return mode;
}

function requireAbsoluteWorkspacePath(value, fieldName = 'workspacePath') {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 4096 || !path.isAbsolute(raw)) {
        throw workspaceError(
            'M365_PROJECT_WORKSPACE_PATH_INVALID',
            `${fieldName} must be an absolute local path.`
        );
    }
    const resolved = path.resolve(raw);
    if (resolved === path.parse(resolved).root || (process.platform === 'win32' && resolved.startsWith('\\\\'))) {
        throw workspaceError(
            'M365_PROJECT_WORKSPACE_PATH_INVALID',
            'A drive root or network path cannot be used as a project workspace.'
        );
    }
    return resolved;
}

function suggestedFolderName(value) {
    const normalized = String(value || '')
        .trim()
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
        .replace(/[. ]+$/g, '')
        .slice(0, 120);
    if (!normalized || WINDOWS_RESERVED_NAMES.test(normalized)) return 'M365-Golem-Project';
    return normalized;
}

function validateFolderName(value, fallback) {
    const name = String(value || suggestedFolderName(fallback)).trim();
    if (!name || name.length > 120 || name === '.' || name === '..'
        || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)
        || WINDOWS_RESERVED_NAMES.test(name)) {
        throw workspaceError(
            'M365_PROJECT_WORKSPACE_FOLDER_NAME_INVALID',
            'The new workspace folder name is not valid on this computer.'
        );
    }
    return name;
}

function containsSensitiveValue(value) {
    const text = String(value || '');
    return [
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
        /\b(?:password|passwd|pwd|client_secret|access_token|refresh_token|api[_-]?key)\s*[:=]\s*[^\s,;]{6,}/i,
        /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
        /\b(?:cookie|set-cookie)\s*[:=]\s*[^\r\n]{8,}/i,
    ].some((pattern) => pattern.test(text));
}

function normalizeTags(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .map((tag) => String(tag || '').trim().replace(/[\r\n]/g, ' '))
        .filter(Boolean)
        .map((tag) => tag.slice(0, MAX_MEMORY_TAG_CHARS)))]
        .slice(0, MAX_MEMORY_TAGS);
}

function memoryId(kind, content) {
    const digest = crypto.createHash('sha256')
        .update(`${kind}\n${String(content || '').trim().toLowerCase()}`)
        .digest('hex')
        .slice(0, 16);
    return `pm_${digest}`;
}

function parseMemoryBlock(raw) {
    const text = String(raw || '')
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```/g, '')
        .trim();
    if (!text || text.toLowerCase() === 'null') return [];
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (_) {
        throw workspaceError(
            'M365_PROJECT_MEMORY_FORMAT_INVALID',
            'Project memory must be a JSON object or array.'
        );
    }
    if (parsed && Array.isArray(parsed.entries)) parsed = parsed.entries;
    return Array.isArray(parsed) ? parsed : [parsed];
}

function formatMemoryLine(entry) {
    const content = String(entry.content || '').trim().replace(/\r/g, '');
    const lines = content.split('\n');
    const first = `- [${entry.id}] ${lines.shift() || ''}`;
    const continuation = lines.map((line) => `  ${line}`).join('\n');
    const metadata = [
        entry.importance === 'core' ? 'core' : '',
        ...(Array.isArray(entry.tags) ? entry.tags : []),
    ].filter(Boolean);
    return [
        first,
        continuation,
        metadata.length > 0 ? `  _tags: ${metadata.join(', ')}_` : '',
    ].filter(Boolean).join('\n');
}

function renderAgents(projectId, entries) {
    const groups = [
        ['rule', 'Project rules'],
        ['decision', 'Decisions'],
        ['context', 'Working context'],
        ['preference', 'Project preferences'],
    ];
    const lines = [
        '# AGENTS.md',
        '',
        '> Managed automatically by the resident Golem AI for this project.',
        '> Do not edit this file by hand. Golem updates it through the scoped project-memory protocol.',
        '> Entries cannot override safety rules, data boundaries, Action Gate, or human approval for tool actions.',
        '',
        `Project workspace: ${projectId}`,
        '',
    ];
    for (const [kind, title] of groups) {
        lines.push(`## ${title}`, '');
        const items = entries.filter((entry) => entry.kind === kind);
        if (items.length === 0) lines.push('- (none)');
        else items.forEach((entry) => lines.push(formatMemoryLine(entry)));
        lines.push('');
    }
    lines.push(
        '## Working folders',
        '',
        '- `references/`: local source material intentionally placed in this project.',
        '- `outputs/`: files created for this project.',
        ''
    );
    return lines.join('\n');
}

function defaultAgentsTemplate(projectId) {
    return renderAgents(projectId, []);
}

function tokenize(value) {
    const text = String(value || '').toLowerCase();
    const tokens = new Set(text.match(/[a-z0-9][a-z0-9_-]{1,}|[\u3400-\u9fff]{2,}/g) || []);
    const cjk = (text.match(/[\u3400-\u9fff]+/g) || []).join('');
    for (let index = 0; index < cjk.length - 1; index += 1) {
        tokens.add(cjk.slice(index, index + 2));
    }
    return tokens;
}

function lexicalScore(queryTokens, entry) {
    if (queryTokens.size === 0) return 0;
    const entryTokens = tokenize(`${entry.content} ${(entry.tags || []).join(' ')}`);
    let matches = 0;
    queryTokens.forEach((token) => { if (entryTokens.has(token)) matches += 1; });
    return matches / Math.max(1, Math.sqrt(queryTokens.size * Math.max(1, entryTokens.size)));
}

class M365ProjectWorkspaceService {
    constructor(options = {}) {
        this.rootDir = path.resolve(options.rootDir || path.join(process.cwd(), 'data', 'm365-projects'));
        this.maxAgentsChars = Number(options.maxAgentsChars || MAX_AGENTS_CHARS);
        this._vectorIndexes = new Map();
    }

    _projectRoot(projectId, workspacePath = '') {
        const id = String(projectId || '').trim();
        if (!PROJECT_ID_PATTERN.test(id)) {
            throw workspaceError('M365_PROJECT_WORKSPACE_ID_INVALID', 'Invalid project workspace identifier.');
        }
        if (String(workspacePath || '').trim()) {
            return requireAbsoluteWorkspacePath(workspacePath);
        }
        const projectRoot = path.resolve(this.rootDir, id);
        const prefix = `${this.rootDir}${path.sep}`;
        if (!projectRoot.startsWith(prefix)) {
            throw workspaceError('M365_PROJECT_WORKSPACE_PATH_INVALID', 'Project workspace must remain inside the configured root.');
        }
        return projectRoot;
    }

    _assertUsableDirectory(directoryPath, fieldName) {
        const stat = fs.lstatSync(directoryPath);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw workspaceError(
                'M365_PROJECT_WORKSPACE_PATH_INVALID',
                `${fieldName} must be a regular local directory.`
            );
        }
        try {
            fs.accessSync(directoryPath, fs.constants.R_OK | fs.constants.W_OK);
        } catch (_) {
            throw workspaceError(
                'M365_PROJECT_WORKSPACE_ACCESS_DENIED',
                `${fieldName} is not readable and writable by M365 Golem.`
            );
        }
    }

    _assertCustomWorkspaceAvailable(projectId, projectRoot) {
        if (!fs.existsSync(projectRoot)) return;
        this._assertUsableDirectory(projectRoot, 'workspacePath');
        const agentsPath = path.join(projectRoot, 'AGENTS.md');
        const rulesPath = this._rulesPath(projectRoot);
        if (fs.existsSync(agentsPath)) {
            const agentsStat = this._assertRegularFileOrMissing(agentsPath, 'M365_PROJECT_AGENTS_FILE_INVALID');
            if (agentsStat.size > this.maxAgentsChars * 4) {
                throw workspaceError(
                    'M365_PROJECT_AGENTS_CONFLICT',
                    'This folder contains an AGENTS.md that is too large for M365 Golem to verify safely.',
                    409
                );
            }
            const content = fs.readFileSync(agentsPath, 'utf8');
            if (content.length > this.maxAgentsChars) {
                throw workspaceError(
                    'M365_PROJECT_AGENTS_CONFLICT',
                    'This folder contains an AGENTS.md that is too large for M365 Golem to verify safely.',
                    409
                );
            }
            const managedForThisProject = content.includes('Managed automatically by the resident Golem AI')
                && content.includes(`Project workspace: ${projectId}`);
            if (!managedForThisProject) {
                throw workspaceError(
                    'M365_PROJECT_AGENTS_CONFLICT',
                    'This folder already contains an AGENTS.md that M365 Golem will not overwrite.',
                    409
                );
            }
        } else if (fs.existsSync(rulesPath)) {
            throw workspaceError(
                'M365_PROJECT_WORKSPACE_ALREADY_MANAGED',
                'This folder already contains another Golem project memory store.',
                409
            );
        }
    }

    planProjectWorkspace(projectId, input = {}) {
        const mode = normalizeWorkspaceMode(input.workspaceMode);
        if (mode === 'managed') {
            return {
                mode,
                rootPath: this._projectRoot(projectId),
                workspacePathForStorage: null,
                rootExisted: fs.existsSync(this._projectRoot(projectId)),
            };
        }

        if (mode === 'existing') {
            const rootPath = requireAbsoluteWorkspacePath(input.workspacePath);
            if (!fs.existsSync(rootPath)) {
                throw workspaceError(
                    'M365_PROJECT_WORKSPACE_NOT_FOUND',
                    'The selected existing workspace folder does not exist.',
                    404
                );
            }
            this._assertCustomWorkspaceAvailable(projectId, rootPath);
            return { mode, rootPath, workspacePathForStorage: rootPath, rootExisted: true };
        }

        const parentPath = requireAbsoluteWorkspacePath(input.workspacePath, 'workspaceParentPath');
        if (!fs.existsSync(parentPath)) {
            throw workspaceError(
                'M365_PROJECT_WORKSPACE_PARENT_NOT_FOUND',
                'The selected parent folder does not exist.',
                404
            );
        }
        this._assertUsableDirectory(parentPath, 'workspaceParentPath');
        const folderName = validateFolderName(input.workspaceFolderName, input.projectName);
        const rootPath = path.resolve(parentPath, folderName);
        const prefix = `${parentPath}${path.sep}`;
        if (!rootPath.startsWith(prefix)) {
            throw workspaceError('M365_PROJECT_WORKSPACE_PATH_INVALID', 'The new workspace must remain inside the selected parent folder.');
        }
        if (fs.existsSync(rootPath)) {
            throw workspaceError(
                'M365_PROJECT_WORKSPACE_EXISTS',
                'The new workspace folder already exists. Choose “Use existing folder” instead.',
                409
            );
        }
        return { mode, rootPath, workspacePathForStorage: rootPath, rootExisted: false };
    }

    _assertRegularFileOrMissing(filePath, code = 'M365_PROJECT_WORKSPACE_FILE_INVALID') {
        if (!fs.existsSync(filePath)) return null;
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw workspaceError(code, 'Managed project files must be regular files inside the project workspace.');
        }
        return stat;
    }

    _rulesPath(projectRoot) {
        return path.join(projectRoot, '.golem', 'project-memory.json');
    }

    _readEntries(projectRoot) {
        const rulesPath = this._rulesPath(projectRoot);
        this._assertRegularFileOrMissing(rulesPath, 'M365_PROJECT_MEMORY_FILE_INVALID');
        if (!fs.existsSync(rulesPath)) return [];
        try {
            const parsed = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
            return Array.isArray(parsed.entries) ? parsed.entries : [];
        } catch (_) {
            throw workspaceError('M365_PROJECT_MEMORY_FILE_INVALID', 'Project memory file is invalid.', 500);
        }
    }

    _writeEntries(projectRoot, entries) {
        const rulesPath = this._rulesPath(projectRoot);
        fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
        this._assertRegularFileOrMissing(rulesPath, 'M365_PROJECT_MEMORY_FILE_INVALID');
        const payload = {
            version: 1,
            updatedAt: new Date().toISOString(),
            entries,
        };
        const temporaryPath = `${rulesPath}.${process.pid}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        try {
            fs.renameSync(temporaryPath, rulesPath);
        } catch (error) {
            // Windows can reject rename-over-existing even when both files are local.
            // Keep the old file intact until the complete temporary file is copied.
            if (!error || !['EEXIST', 'EPERM'].includes(error.code)) {
                try { fs.unlinkSync(temporaryPath); } catch (_) { /* best effort */ }
                throw error;
            }
            fs.copyFileSync(temporaryPath, rulesPath);
            fs.unlinkSync(temporaryPath);
        }
    }

    _writeAgents(projectId, projectRoot, entries) {
        const agentsPath = path.join(projectRoot, 'AGENTS.md');
        this._assertRegularFileOrMissing(agentsPath, 'M365_PROJECT_AGENTS_FILE_INVALID');
        const content = renderAgents(projectId, entries);
        if (content.length > this.maxAgentsChars) {
            throw workspaceError('M365_PROJECT_AGENTS_TOO_LARGE', 'Managed AGENTS.md exceeded its local size limit.');
        }
        if (!fs.existsSync(agentsPath) || fs.readFileSync(agentsPath, 'utf8') !== content) {
            fs.writeFileSync(agentsPath, content, 'utf8');
        }
    }

    _migrateLegacyAgents(projectId, projectRoot) {
        const agentsPath = path.join(projectRoot, 'AGENTS.md');
        const entries = [];
        if (fs.existsSync(agentsPath)) {
            this._assertRegularFileOrMissing(agentsPath, 'M365_PROJECT_AGENTS_FILE_INVALID');
            const raw = fs.readFileSync(agentsPath, 'utf8').trim();
            const looksLikeOldDefault = raw.includes(`Project workspace: ${projectId}`)
                && raw.includes('Describe the project background, working conventions');
            const alreadyManaged = raw.includes('Managed automatically by the resident Golem AI');
            if (raw && !looksLikeOldDefault && !alreadyManaged) {
                const now = new Date().toISOString();
                const content = raw.slice(0, MAX_MEMORY_CONTENT_CHARS);
                entries.push({
                    id: memoryId('context', content),
                    kind: 'context',
                    importance: 'core',
                    content,
                    tags: ['legacy-import'],
                    createdAt: now,
                    updatedAt: now,
                    source: { type: 'legacy-agents-import' },
                });
                const backupPath = path.join(projectRoot, 'AGENTS.legacy.md');
                if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, `${raw}\n`, 'utf8');
            }
        }
        this._writeEntries(projectRoot, entries);
        return entries;
    }

    ensureProject(projectId, options = {}) {
        const workspacePath = String(options.workspacePath || '').trim();
        const projectRoot = this._projectRoot(projectId, workspacePath);
        if (workspacePath) this._assertCustomWorkspaceAvailable(projectId, projectRoot);
        if (!fs.existsSync(projectRoot)) {
            if (workspacePath && options.createWorkspaceRoot !== true) {
                throw workspaceError(
                    'M365_PROJECT_WORKSPACE_NOT_FOUND',
                    'The project workspace folder no longer exists. Restore it at the saved location or create a new project.',
                    404
                );
            }
            if (workspacePath) fs.mkdirSync(projectRoot);
            else fs.mkdirSync(projectRoot, { recursive: true });
        }
        const rootStat = fs.lstatSync(projectRoot);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
            throw workspaceError('M365_PROJECT_WORKSPACE_PATH_INVALID', 'Project workspace must be a regular local directory.');
        }

        fs.mkdirSync(path.join(projectRoot, 'references'), { recursive: true });
        fs.mkdirSync(path.join(projectRoot, 'outputs'), { recursive: true });
        fs.mkdirSync(path.join(projectRoot, '.golem'), { recursive: true });

        const rulesPath = this._rulesPath(projectRoot);
        let entries;
        if (fs.existsSync(rulesPath)) {
            entries = this._readEntries(projectRoot);
        } else if (workspacePath) {
            entries = [];
            this._writeEntries(projectRoot, entries);
        } else {
            entries = this._migrateLegacyAgents(projectId, projectRoot);
        }
        this._writeAgents(projectId, projectRoot, entries);
        return this.getProjectWorkspace(projectId, { ensure: false, workspacePath });
    }

    getProjectWorkspace(projectId, options = {}) {
        const workspacePath = String(options.workspacePath || '').trim();
        const projectRoot = this._projectRoot(projectId, workspacePath);
        if (options.ensure !== false && !fs.existsSync(this._rulesPath(projectRoot))) {
            return this.ensureProject(projectId, { workspacePath });
        }
        const agentsPath = path.join(projectRoot, 'AGENTS.md');
        const rulesPath = this._rulesPath(projectRoot);
        const entries = this._readEntries(projectRoot);
        this._assertRegularFileOrMissing(agentsPath, 'M365_PROJECT_AGENTS_FILE_INVALID');
        const raw = fs.readFileSync(agentsPath, 'utf8');
        const stat = fs.statSync(rulesPath);
        return {
            projectId: String(projectId),
            rootPath: projectRoot,
            agentsPath,
            agentsContent: raw.slice(0, this.maxAgentsChars),
            agentsTruncated: raw.length > this.maxAgentsChars,
            memoryEntries: entries,
            memoryCount: entries.length,
            managedBy: 'golem',
            updatedAt: stat.mtime.toISOString(),
        };
    }

    writeAgents() {
        throw workspaceError(
            'M365_PROJECT_AGENTS_MANAGED',
            'AGENTS.md is managed by the resident Golem project-memory protocol and cannot be edited directly.',
            409
        );
    }

    applyMemoryBlock(projectId, rawBlock, metadata = {}) {
        return this.applyMemoryOperations(projectId, parseMemoryBlock(rawBlock), metadata);
    }

    applyMemoryOperations(projectId, operations, metadata = {}) {
        const workspacePath = String(metadata.workspacePath || '').trim();
        const workspace = this.ensureProject(projectId, { workspacePath });
        let entries = [...workspace.memoryEntries];
        const now = new Date().toISOString();
        const results = [];

        for (const rawOperation of (Array.isArray(operations) ? operations : [])) {
            if (!rawOperation || typeof rawOperation !== 'object') {
                throw workspaceError('M365_PROJECT_MEMORY_ENTRY_INVALID', 'Project memory entries must be objects.');
            }
            const operation = String(rawOperation.operation || 'upsert').trim().toLowerCase();
            if (!['add', 'upsert', 'update', 'remove'].includes(operation)) {
                throw workspaceError('M365_PROJECT_MEMORY_OPERATION_INVALID', `Unsupported project memory operation: ${operation}`);
            }
            const requestedId = String(rawOperation.id || '').trim();
            if (operation === 'remove') {
                if (!/^pm_[a-f0-9]{16}$/.test(requestedId)) {
                    throw workspaceError('M365_PROJECT_MEMORY_ID_INVALID', 'Removing project memory requires a valid injected memory id.');
                }
                const before = entries.length;
                entries = entries.filter((entry) => entry.id !== requestedId);
                results.push({ operation, id: requestedId, changed: entries.length !== before });
                continue;
            }

            const kind = String(rawOperation.kind || 'context').trim().toLowerCase();
            const importance = String(rawOperation.importance || 'normal').trim().toLowerCase();
            const content = String(rawOperation.content || '').trim().replace(/\0/g, '');
            if (!MEMORY_KINDS.has(kind)) {
                throw workspaceError('M365_PROJECT_MEMORY_KIND_INVALID', `Unsupported project memory kind: ${kind}`);
            }
            if (!MEMORY_IMPORTANCE.has(importance)) {
                throw workspaceError('M365_PROJECT_MEMORY_IMPORTANCE_INVALID', 'Project memory importance must be core or normal.');
            }
            if (!content || content.length > MAX_MEMORY_CONTENT_CHARS) {
                throw workspaceError('M365_PROJECT_MEMORY_CONTENT_INVALID', `Project memory content must be 1-${MAX_MEMORY_CONTENT_CHARS} characters.`);
            }
            if (containsSensitiveValue(content)) {
                throw workspaceError('M365_PROJECT_MEMORY_SENSITIVE', 'Secrets and authentication material cannot be stored in project memory.');
            }
            const tags = normalizeTags(rawOperation.tags);
            const id = requestedId || memoryId(kind, content);
            if (!/^pm_[a-f0-9]{16}$/.test(id)) {
                throw workspaceError('M365_PROJECT_MEMORY_ID_INVALID', 'Project memory id is invalid.');
            }
            const existingIndex = entries.findIndex((entry) => entry.id === id);
            if (operation === 'add' && requestedId) {
                throw workspaceError('M365_PROJECT_MEMORY_ID_INVALID', 'New project memory must omit id; ids are assigned by the host.');
            }
            if (requestedId && existingIndex < 0) {
                throw workspaceError('M365_PROJECT_MEMORY_NOT_FOUND', 'The injected project memory id was not found.', 404);
            }
            if (operation === 'update' && existingIndex < 0) {
                throw workspaceError('M365_PROJECT_MEMORY_NOT_FOUND', 'The project memory entry to update was not found.', 404);
            }
            const existing = existingIndex >= 0 ? entries[existingIndex] : null;
            const next = {
                id,
                kind,
                importance,
                content,
                tags,
                createdAt: existing?.createdAt || now,
                updatedAt: now,
                source: {
                    type: 'copilot-project-memory',
                    conversationId: String(metadata.conversationId || existing?.source?.conversationId || ''),
                    requestId: String(metadata.requestId || ''),
                },
            };
            if (existingIndex >= 0) entries[existingIndex] = next;
            else entries.push(next);
            results.push({ operation: existingIndex >= 0 ? 'update' : 'add', id, changed: true });
        }

        if (entries.length > MAX_MEMORY_ENTRIES) {
            throw workspaceError('M365_PROJECT_MEMORY_LIMIT', `A project can retain at most ${MAX_MEMORY_ENTRIES} memory entries.`);
        }
        entries.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        this._writeEntries(workspace.rootPath, entries);
        this._writeAgents(projectId, workspace.rootPath, entries);
        return {
            workspace: this.getProjectWorkspace(projectId, { ensure: false, workspacePath }),
            results,
        };
    }

    async getRelevantMemories(projectId, query, options = {}) {
        const workspacePath = String(options.workspacePath || '').trim();
        const workspace = this.ensureProject(projectId, { workspacePath });
        const entries = workspace.memoryEntries;
        if (entries.length === 0) return [];
        const limit = Math.max(1, Math.min(20, Number(options.limit || 8)));
        const queryTokens = tokenize(query);
        const vectorScores = new Map();

        if (options.embedder && typeof options.embedder.embedQuery === 'function') {
            try {
                const indexKey = `${projectId}:${workspace.rootPath}`;
                let index = this._vectorIndexes.get(indexKey);
                if (!index || index.embedder !== options.embedder) {
                    index = new ProjectRuleVectorIndex(workspace.rootPath, options.embedder);
                    this._vectorIndexes.set(indexKey, index);
                }
                await index.sync(entries);
                const matches = await index.search(query, { limit: Math.max(limit * 2, 10) });
                matches.forEach((match) => vectorScores.set(match.id, Number(match.score || 0)));
            } catch (error) {
                console.warn(`[ProjectMemory] Vector retrieval unavailable; using lexical fallback: ${error.message}`);
            }
        }

        const now = Date.now();
        const ranked = entries.map((entry) => {
            const lexical = lexicalScore(queryTokens, entry);
            const vector = vectorScores.get(entry.id) || 0;
            const ageDays = Math.max(0, (now - Date.parse(entry.updatedAt || entry.createdAt || 0)) / 86400000);
            const recency = Number.isFinite(ageDays) ? Math.max(0, 0.08 - Math.min(0.08, ageDays / 3650)) : 0;
            const core = entry.importance === 'core' ? 1 : 0;
            const rule = entry.kind === 'rule' ? 0.2 : 0;
            return { entry, score: (vector * 0.65) + (lexical * 0.35) + core + rule + recency };
        }).sort((a, b) => b.score - a.score);

        return ranked
            .filter((item, index) => item.entry.importance === 'core' || item.score > 0.08 || index < 3)
            .slice(0, limit)
            .map((item) => ({ ...item.entry, relevanceScore: Number(item.score.toFixed(4)) }));
    }
}

module.exports = M365ProjectWorkspaceService;
module.exports.MAX_AGENTS_CHARS = MAX_AGENTS_CHARS;
module.exports.MAX_MEMORY_CONTENT_CHARS = MAX_MEMORY_CONTENT_CHARS;
module.exports.defaultAgentsTemplate = defaultAgentsTemplate;
module.exports.parseMemoryBlock = parseMemoryBlock;
module.exports.renderAgents = renderAgents;
module.exports.containsSensitiveValue = containsSensitiveValue;
module.exports.normalizeWorkspaceMode = normalizeWorkspaceMode;
module.exports.requireAbsoluteWorkspacePath = requireAbsoluteWorkspacePath;
module.exports.suggestedFolderName = suggestedFolderName;
