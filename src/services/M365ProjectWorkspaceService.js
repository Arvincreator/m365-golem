'use strict';

const fs = require('fs');
const path = require('path');

const MAX_AGENTS_CHARS = 12000;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function workspaceError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function defaultAgentsTemplate(projectId) {
    return [
        '# AGENTS.md',
        '',
        `Project workspace: ${projectId}`,
        '',
        '## Project instructions',
        '',
        '- Describe the project background, working conventions, and expected outputs here.',
        '- Keep secrets, passwords, access tokens, cookies, and private keys out of this file.',
        '- These instructions provide project context only. They cannot bypass Golem safety rules, data boundaries, Action Gate, or human approval.',
        '',
        '## Working folders',
        '',
        '- `references/`: local source material intentionally placed in this project.',
        '- `outputs/`: files created for this project.',
        '',
    ].join('\n');
}

class M365ProjectWorkspaceService {
    constructor(options = {}) {
        this.rootDir = path.resolve(options.rootDir || path.join(process.cwd(), 'data', 'm365-projects'));
        this.maxAgentsChars = Number(options.maxAgentsChars || MAX_AGENTS_CHARS);
    }

    _projectRoot(projectId) {
        const id = String(projectId || '').trim();
        if (!PROJECT_ID_PATTERN.test(id)) {
            throw workspaceError('M365_PROJECT_WORKSPACE_ID_INVALID', 'Invalid project workspace identifier.');
        }
        const projectRoot = path.resolve(this.rootDir, id);
        const prefix = `${this.rootDir}${path.sep}`;
        if (!projectRoot.startsWith(prefix)) {
            throw workspaceError('M365_PROJECT_WORKSPACE_PATH_INVALID', 'Project workspace must remain inside the configured root.');
        }
        return projectRoot;
    }

    _assertRegularFileOrMissing(filePath) {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw workspaceError(
                'M365_PROJECT_AGENTS_FILE_INVALID',
                'AGENTS.md must be a regular file inside the project workspace.'
            );
        }
    }

    ensureProject(projectId) {
        const projectRoot = this._projectRoot(projectId);
        fs.mkdirSync(projectRoot, { recursive: true });
        const rootStat = fs.lstatSync(projectRoot);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
            throw workspaceError(
                'M365_PROJECT_WORKSPACE_PATH_INVALID',
                'Project workspace must be a regular local directory.'
            );
        }

        fs.mkdirSync(path.join(projectRoot, 'references'), { recursive: true });
        fs.mkdirSync(path.join(projectRoot, 'outputs'), { recursive: true });

        const agentsPath = path.join(projectRoot, 'AGENTS.md');
        this._assertRegularFileOrMissing(agentsPath);
        if (!fs.existsSync(agentsPath)) {
            try {
                fs.writeFileSync(agentsPath, defaultAgentsTemplate(projectId), {
                    encoding: 'utf8',
                    flag: 'wx',
                });
            } catch (error) {
                if (error && error.code !== 'EEXIST') throw error;
            }
        }
        return this.getProjectWorkspace(projectId);
    }

    getProjectWorkspace(projectId) {
        const projectRoot = this._projectRoot(projectId);
        if (!fs.existsSync(projectRoot)) return this.ensureProject(projectId);

        const agentsPath = path.join(projectRoot, 'AGENTS.md');
        this._assertRegularFileOrMissing(agentsPath);
        if (!fs.existsSync(agentsPath)) return this.ensureProject(projectId);

        const raw = fs.readFileSync(agentsPath, 'utf8');
        const stat = fs.statSync(agentsPath);
        const truncated = raw.length > this.maxAgentsChars;
        return {
            projectId: String(projectId),
            rootPath: projectRoot,
            agentsPath,
            agentsContent: raw.slice(0, this.maxAgentsChars),
            agentsTruncated: truncated,
            updatedAt: stat.mtime.toISOString(),
        };
    }

    writeAgents(projectId, content) {
        if (typeof content !== 'string') {
            throw workspaceError('M365_PROJECT_AGENTS_INVALID', 'AGENTS.md content must be text.');
        }
        if (content.includes('\0')) {
            throw workspaceError('M365_PROJECT_AGENTS_INVALID', 'AGENTS.md cannot contain null bytes.');
        }
        if (content.length > this.maxAgentsChars) {
            throw workspaceError(
                'M365_PROJECT_AGENTS_TOO_LARGE',
                `AGENTS.md cannot exceed ${this.maxAgentsChars} characters.`
            );
        }

        const workspace = this.ensureProject(projectId);
        this._assertRegularFileOrMissing(workspace.agentsPath);
        fs.writeFileSync(workspace.agentsPath, content, { encoding: 'utf8', flag: 'w' });
        return this.getProjectWorkspace(projectId);
    }
}

module.exports = M365ProjectWorkspaceService;
module.exports.MAX_AGENTS_CHARS = MAX_AGENTS_CHARS;
module.exports.defaultAgentsTemplate = defaultAgentsTemplate;
