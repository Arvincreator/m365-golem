jest.mock('../src/core/Executor', () => {
    return jest.fn().mockImplementation(() => ({
        run: jest.fn().mockResolvedValue('ok'),
    }));
});

const TaskController = require('../src/core/TaskController');

describe('TaskController', () => {
    test('tool discovery returns selected guides without invoking shell or executing discovered tools', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        const toolRouter = { buildRoutingHintAsync: jest.fn().mockResolvedValue('<tool-routing>selected guide</tool-routing>') };
        try {
            const result = await controller.runSequence({ brain: { toolRouter } }, [
                { action: 'command', parameter: 'golem_check tools create a local document' },
            ]);
            expect(toolRouter.buildRoutingHintAsync).toHaveBeenCalledWith('create a local document');
            expect(result).toContain('selected guide');
            expect(result).toContain('no proposed tool has been executed');
            expect(controller.internalExecutor).toBeFalsy();
        } finally { controller.destroy(); }
    });

    test('queries only the active project memory without invoking the shell', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        const projectMemoryService = {
            getRelevantMemories: jest.fn().mockResolvedValue([{
                id: 'pm_aaaaaaaaaaaaaaaa',
                kind: 'lesson',
                importance: 'core',
                content: 'Do not repeat a plan-only turn without its current action.',
                tags: ['pitfall'],
                updatedAt: '2026-09-07T00:00:00.000Z',
                retrievalReason: 'relevant',
            }]),
        };
        const ctx = {
            workspaceProjectId: 'project-1',
            workspaceRoot: 'C:\\local\\m365-projects\\project-1',
            m365ProjectWorkspaceService: projectMemoryService,
        };
        try {
            const result = await controller.runSequence(ctx, [
                { action: 'command', parameter: 'golem-memory 之前有哪些踩坑經驗' },
            ], 0, { _resolveToolVectorEmbedder: jest.fn(() => null) });
            expect(projectMemoryService.getRelevantMemories).toHaveBeenCalledWith(
                'project-1',
                '之前有哪些踩坑經驗',
                expect.objectContaining({ workspacePath: ctx.workspaceRoot, limit: 12, recentLimit: 4 })
            );
            expect(result).toContain('[ProjectMemoryQuery]');
            expect(result).toContain('plan-only turn');
            expect(controller.internalExecutor).toBeFalsy();
        } finally { controller.destroy(); }
    });

    test('returns recent project memory when no query is supplied', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        const projectMemoryService = {
            getRecentMemories: jest.fn().mockReturnValue([{
                id: 'pm_bbbbbbbbbbbbbbbb',
                kind: 'worklog',
                importance: 'normal',
                content: 'Verified the latest project output.',
                tags: ['verification'],
                updatedAt: '2026-09-07T01:00:00.000Z',
                retrievalReason: 'recent',
            }]),
        };
        const ctx = {
            workspaceProjectId: 'project-1',
            workspaceRoot: 'C:\\local\\m365-projects\\project-1',
            m365ProjectWorkspaceService: projectMemoryService,
        };
        try {
            const result = await controller.runSequence(ctx, [
                { action: 'command', parameter: 'golem-memory' },
            ]);
            expect(projectMemoryService.getRecentMemories).toHaveBeenCalledWith(
                'project-1',
                { workspacePath: ctx.workspaceRoot, limit: 12 }
            );
            expect(result).toContain('Verified the latest project output.');
            expect(controller.internalExecutor).toBeFalsy();
        } finally { controller.destroy(); }
    });

    test('refuses a project-memory query outside an active project without invoking the shell', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        try {
            const result = await controller.runSequence({}, [
                { action: 'command', parameter: 'golem-memory previous failures' },
            ]);
            expect(result).toContain('requires an active scoped project workspace');
            expect(controller.internalExecutor).toBeFalsy();
        } finally { controller.destroy(); }
    });
    beforeEach(() => {
        delete process.env.COMMAND_WHITELIST;
        delete process.env.GOLEM_TRUST_SYSTEM_COMMANDS;
        delete process.env.GOLEM_AUTO_APPROVE_ALL;
    });

    afterEach(() => {
        delete process.env.COMMAND_WHITELIST;
        delete process.env.GOLEM_TRUST_SYSTEM_COMMANDS;
        delete process.env.GOLEM_AUTO_APPROVE_ALL;
    });

    test('runSequence should execute basic ls command from GOLEM_ACTION without approval gate', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        const ctx = { reply: jest.fn().mockResolvedValue(undefined) };

        const result = await controller.runSequence(ctx, [
            { action: 'command', parameter: 'ls -laG' }
        ]);

        controller.destroy();

        expect(result).toContain('[Step 1 Success]');
        expect(result).toContain('cmd: ls -laG');
        expect(ctx.reply).not.toHaveBeenCalled();
        expect(controller.pendingTasks.size).toBe(0);
    });

    test('runSequence should execute command from parameters.command even when action is missing', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        const ctx = { reply: jest.fn().mockResolvedValue(undefined) };

        const result = await controller.runSequence(ctx, [
            { parameters: { command: 'pwd' } }
        ]);

        controller.destroy();

        expect(result).toContain('[Step 1 Success]');
        expect(result).toContain('cmd: pwd');
        expect(ctx.reply).not.toHaveBeenCalled();
    });

    test('runs native M365 commands in the assigned project workspace', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        const ctx = {
            reply: jest.fn().mockResolvedValue(undefined),
            workspaceRoot: 'C:\\local\\m365-projects\\project-1',
        };

        await controller.runSequence(ctx, [
            { action: 'command', parameter: 'pwd' },
        ]);

        expect(controller.internalExecutor.run).toHaveBeenCalledWith('pwd', {
            cwd: 'C:\\local\\m365-projects\\project-1',
        });
        controller.destroy();
    });

    test('runSequence should still require approval for complex command', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        const ctx = { reply: jest.fn().mockResolvedValue(undefined) };

        const result = await controller.runSequence(ctx, [
            { action: 'command', parameter: 'cat $(ls)' }
        ]);

        controller.destroy();

        expect(result).toBeNull();
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining('⚠️ 🟡 警告'),
            expect.any(Object)
        );
        expect(controller.pendingTasks.size).toBe(1);
    });

    test('a scoped M365 approval avoids a duplicate warning prompt', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        const ctx = { reply: jest.fn().mockResolvedValue(undefined) };

        const result = await controller.runSequence(
            ctx,
            [{ action: 'command', parameter: 'cat README.md' }],
            0,
            null,
            { approvalGranted: true }
        );

        controller.destroy();

        expect(result).toContain('[Step 1 Success]');
        expect(ctx.reply).not.toHaveBeenCalled();
        expect(controller.pendingTasks.size).toBe(0);
    });

    test('a scoped M365 approval never bypasses a destructive hard block', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        controller.security.evaluateCommandLevel = jest.fn(() => 0);
        const ctx = { reply: jest.fn().mockResolvedValue(undefined) };

        const result = await controller.runSequence(
            ctx,
            [{ action: 'command', parameter: 'rm -rf /' }],
            0,
            null,
            { approvalGranted: true }
        );

        controller.destroy();

        expect(result).toContain('指令被系統攔截');
        expect(controller.internalExecutor).toBeUndefined();
    });

    test('runSequence should assemble sys_admin through package runtime path', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        controller.security.assess = jest.fn(() => ({ level: 'SAFE', reason: '' }));
        controller.security.evaluateCommandLevel = jest.fn(() => 0);
        const ctx = {
            reply: jest.fn().mockResolvedValue(undefined),
            workspaceRoot: 'C:\\local\\m365-projects\\project-1',
        };

        const result = await controller.runSequence(ctx, [
            { action: 'sys_admin', parameters: { command: 'echo hello' } }
        ]);

        controller.destroy();

        expect(result).toContain('[Step 1 Success]');
        expect(result).toMatch(/src[\\/]skills[\\/]modules[\\/]sys-admin[\\/]index\.js/);
        expect(result).not.toMatch(/src[\\/]skills[\\/]core[\\/]sys-admin\.js/);
        expect(controller.internalExecutor.run).toHaveBeenCalledWith(
            expect.stringMatching(/src[\\/]skills[\\/]modules[\\/]sys-admin[\\/]index\.js/),
            {}
        );
    });

    test('runSequence should preserve complex sys_admin payload for approval', async () => {
        const controller = new TaskController({ golemId: 'test-golem' });
        const ctx = { reply: jest.fn().mockResolvedValue(undefined) };

        const result = await controller.runSequence(ctx, [
            { action: 'sys_admin', parameters: { command: 'ps -Aro %cpu,%mem,comm | grep -iE "node|zombie" | head -n 10' } }
        ]);

        controller.destroy();

        expect(result).toBeNull();
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/src[\\/]skills[\\/]modules[\\/]sys-admin[\\/]index\.js/), expect.any(Object));
        expect(ctx.reply.mock.calls[0][0]).toContain('node|zombie');
        expect(ctx.reply.mock.calls[0][0]).not.toMatch(/src[\\/]skills[\\/]core[\\/]sys-admin\.js/);
    });
});
