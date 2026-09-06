'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const M365ProjectWorkspaceService = require('../src/services/M365ProjectWorkspaceService');
const ProjectRuleVectorIndex = require('../src/managers/ProjectRuleVectorIndex');

describe('M365 project memory', () => {
    let tempDir;
    let service;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-project-memory-'));
        service = new M365ProjectWorkspaceService({ rootDir: tempDir });
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('shares retained rules across conversations in one project without contaminating another project', async () => {
        service.ensureProject('project-a');
        service.ensureProject('project-b');

        const result = service.applyMemoryBlock('project-a', JSON.stringify([
            {
                operation: 'upsert',
                kind: 'rule',
                importance: 'core',
                content: 'Every deliverable must identify its evidence and human review gate.',
                tags: ['evidence', 'review'],
            },
            {
                operation: 'upsert',
                kind: 'context',
                importance: 'normal',
                content: 'The current workstream is validating invoice exceptions.',
                tags: ['invoice'],
            },
        ]), { conversationId: 'conversation-a1', requestId: 'request-1' });

        expect(result.workspace.memoryCount).toBe(2);
        expect(result.workspace.agentsContent).toContain('Every deliverable must identify its evidence');
        expect(service.ensureProject('project-a').memoryCount).toBe(2);
        expect(service.ensureProject('project-b').memoryCount).toBe(0);
        expect(service.ensureProject('project-b').agentsContent).not.toContain('invoice exceptions');

        const recalled = await service.getRelevantMemories('project-a', 'Please continue the invoice exception review.');
        expect(recalled.map((entry) => entry.content)).toEqual(expect.arrayContaining([
            'The current workstream is validating invoice exceptions.',
            'Every deliverable must identify its evidence and human review gate.',
        ]));
    });

    test('allows Copilot-scoped updates but rejects direct editing and secret material', () => {
        const added = service.applyMemoryOperations('project-a', [{
            operation: 'upsert',
            kind: 'preference',
            content: 'Use a concise decision table for option comparisons.',
            tags: ['format'],
        }]);
        const id = added.results[0].id;

        const updated = service.applyMemoryOperations('project-a', [{
            operation: 'update',
            id,
            kind: 'preference',
            importance: 'core',
            content: 'Use a concise decision table and lead with the recommendation.',
            tags: ['format'],
        }]);
        expect(updated.workspace.agentsContent).toContain('lead with the recommendation');
        expect(() => service.writeAgents('project-a', '# manual')).toThrow(expect.objectContaining({
            code: 'M365_PROJECT_AGENTS_MANAGED',
        }));
        expect(() => service.applyMemoryOperations('project-a', [{
            operation: 'upsert',
            kind: 'context',
            content: 'access_token=abcdefghijklmnop',
        }])).toThrow(expect.objectContaining({ code: 'M365_PROJECT_MEMORY_SENSITIVE' }));
    });

    test('creates and uses a user-selected project folder as the shell and memory workspace', () => {
        const selectedParent = path.join(tempDir, 'selected-parent');
        fs.mkdirSync(selectedParent);
        const plan = service.planProjectWorkspace('custom-project', {
            workspaceMode: 'create',
            workspacePath: selectedParent,
            workspaceFolderName: 'Annual Review',
            projectName: 'Annual Review',
        });

        expect(plan).toEqual(expect.objectContaining({
            mode: 'create',
            rootPath: path.join(selectedParent, 'Annual Review'),
            workspacePathForStorage: path.join(selectedParent, 'Annual Review'),
            rootExisted: false,
        }));

        const workspace = service.ensureProject('custom-project', {
            workspacePath: plan.rootPath,
            createWorkspaceRoot: true,
        });
        expect(workspace.rootPath).toBe(path.join(selectedParent, 'Annual Review'));
        expect(fs.existsSync(path.join(workspace.rootPath, 'AGENTS.md'))).toBe(true);
        expect(fs.existsSync(path.join(workspace.rootPath, '.golem', 'project-memory.json'))).toBe(true);
        expect(fs.existsSync(path.join(workspace.rootPath, 'references'))).toBe(true);
        expect(fs.existsSync(path.join(workspace.rootPath, 'outputs'))).toBe(true);

        service.applyMemoryOperations('custom-project', [{
            operation: 'upsert',
            kind: 'rule',
            content: 'Keep this rule inside the selected project folder.',
        }], { workspacePath: plan.rootPath });
        expect(fs.readFileSync(path.join(workspace.rootPath, 'AGENTS.md'), 'utf8'))
            .toContain('Keep this rule inside the selected project folder.');
        expect(fs.existsSync(path.join(tempDir, 'custom-project'))).toBe(false);
    });

    test('links an empty existing folder but never overwrites a foreign AGENTS.md', () => {
        const linkedFolder = path.join(tempDir, 'linked-folder');
        fs.mkdirSync(linkedFolder);
        const linkedPlan = service.planProjectWorkspace('linked-project', {
            workspaceMode: 'existing',
            workspacePath: linkedFolder,
        });
        service.ensureProject('linked-project', { workspacePath: linkedPlan.rootPath });
        expect(fs.readFileSync(path.join(linkedFolder, 'AGENTS.md'), 'utf8'))
            .toContain('Project workspace: linked-project');

        const protectedFolder = path.join(tempDir, 'protected-folder');
        fs.mkdirSync(protectedFolder);
        const originalAgents = '# Existing repository rules\n\nDo not overwrite this file.\n';
        fs.writeFileSync(path.join(protectedFolder, 'AGENTS.md'), originalAgents, 'utf8');

        expect(() => service.planProjectWorkspace('other-project', {
            workspaceMode: 'existing',
            workspacePath: protectedFolder,
        })).toThrow(expect.objectContaining({ code: 'M365_PROJECT_AGENTS_CONFLICT', statusCode: 409 }));
        expect(fs.readFileSync(path.join(protectedFolder, 'AGENTS.md'), 'utf8')).toBe(originalAgents);
        expect(fs.existsSync(path.join(protectedFolder, '.golem'))).toBe(false);
    });

    test('rejects a drive root as a project workspace', () => {
        expect(() => service.planProjectWorkspace('root-project', {
            workspaceMode: 'existing',
            workspacePath: path.parse(tempDir).root,
        })).toThrow(expect.objectContaining({ code: 'M365_PROJECT_WORKSPACE_PATH_INVALID' }));
    });

    test('does not silently recreate a custom workspace that was moved or deleted', () => {
        const missingRoot = path.join(tempDir, 'moved-workspace');
        expect(() => service.ensureProject('moved-project', { workspacePath: missingRoot }))
            .toThrow(expect.objectContaining({
                code: 'M365_PROJECT_WORKSPACE_NOT_FOUND',
                statusCode: 404,
            }));
        expect(fs.existsSync(missingRoot)).toBe(false);
    });

    test('uses a project-local LanceDB index for semantic retrieval when an embedder is available', async () => {
        const projectRoot = path.join(tempDir, 'vector-project');
        fs.mkdirSync(projectRoot, { recursive: true });
        const embedder = {
            embedQuery: jest.fn(async (text) => {
                const normalized = String(text).toLowerCase();
                if (normalized.includes('invoice')) return [1, 0, 0];
                if (normalized.includes('payroll')) return [0, 1, 0];
                return [0, 0, 1];
            }),
        };
        const index = new ProjectRuleVectorIndex(projectRoot, embedder);
        await index.sync([
            { id: 'pm_aaaaaaaaaaaaaaaa', kind: 'context', content: 'Invoice exception handling', tags: ['invoice'], updatedAt: '2026-09-01T00:00:00.000Z' },
            { id: 'pm_bbbbbbbbbbbbbbbb', kind: 'context', content: 'Payroll reconciliation', tags: ['payroll'], updatedAt: '2026-09-01T00:00:00.000Z' },
        ]);
        const matches = await index.search('invoice review', { limit: 1 });
        expect(matches[0].id).toBe('pm_aaaaaaaaaaaaaaaa');
        expect(fs.existsSync(path.join(projectRoot, '.golem', 'project-memory-index', 'lancedb'))).toBe(true);
    });

    test('ignores the old blank template but preserves meaningful legacy AGENTS content', () => {
        const blankProjectRoot = path.join(tempDir, 'blank-project');
        fs.mkdirSync(blankProjectRoot, { recursive: true });
        fs.writeFileSync(path.join(blankProjectRoot, 'AGENTS.md'), [
            '# AGENTS.md',
            '',
            'Project workspace: blank-project',
            '',
            '- Describe the project background, working conventions, and expected outputs here.',
        ].join('\n'), 'utf8');

        const blankWorkspace = service.ensureProject('blank-project');
        expect(blankWorkspace.memoryCount).toBe(0);
        expect(fs.existsSync(path.join(blankProjectRoot, 'AGENTS.legacy.md'))).toBe(false);

        const legacyProjectRoot = path.join(tempDir, 'legacy-project');
        fs.mkdirSync(legacyProjectRoot, { recursive: true });
        fs.writeFileSync(
            path.join(legacyProjectRoot, 'AGENTS.md'),
            '# Project rule\n\nAlways preserve the original source and show verification evidence.\n',
            'utf8'
        );

        const legacyWorkspace = service.ensureProject('legacy-project');
        expect(legacyWorkspace.memoryCount).toBe(1);
        expect(legacyWorkspace.memoryEntries[0]).toEqual(expect.objectContaining({
            kind: 'context',
            importance: 'core',
            tags: ['legacy-import'],
        }));
        expect(legacyWorkspace.agentsContent).toContain('Always preserve the original source');
        expect(fs.existsSync(path.join(legacyProjectRoot, 'AGENTS.legacy.md'))).toBe(true);
    });
});
