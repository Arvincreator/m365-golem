const SkillHandler = require('../src/core/action_handlers/SkillHandler');
const SkillManager = require('../src/managers/SkillManager');

jest.mock('../src/managers/SkillManager', () => ({
    getSkill: jest.fn(),
    listSkills: jest.fn()
}));

jest.mock('../src/mcp/MCPManager', () => ({
    getInstance: jest.fn()
}));

describe('SkillHandler', () => {
    let mockCtx;
    let mockBrain;
    let mockAct;

    beforeEach(() => {
        jest.clearAllMocks();
        SkillManager.listSkills.mockReturnValue([{ name: 'reference-files' }]);
        mockCtx = {
            reply: jest.fn().mockResolvedValue()
        };
        mockBrain = {
            page: {},
            browser: {},
        };
        mockAct = { action: 'TestSkill', args: { foo: 'bar' } };
    });

    test('execute should handle an unknown skill with actionable help', async () => {
        SkillManager.getSkill.mockReturnValue(null);
        const result = await SkillHandler.execute(mockCtx, mockAct, mockBrain);
        expect(result).toBe(true);
        expect(mockCtx.reply).toHaveBeenCalledWith(expect.stringContaining('找不到技能 action'));
        expect(mockCtx.reply).toHaveBeenCalledWith(expect.stringContaining('/skills'));
    });

    test('classifies missing Chinese skill parameters as a failed Observation', () => {
        expect(SkillHandler._looksLikeFailure('錯誤：缺少 id 參數。')).toBe(true);
        expect(SkillHandler._looksLikeFailure('請提供 query 參數。')).toBe(true);
        expect(SkillHandler._looksLikeFailure('已讀取文件內容。')).toBe(false);
    });

    test('execute should run skill and return true', async () => {
        const mockSkill = {
            name: 'TestSkill',
            run: jest.fn().mockResolvedValue('Skill success')
        };
        SkillManager.getSkill.mockReturnValue(mockSkill);

        const result = await SkillHandler.execute(mockCtx, mockAct, mockBrain);
        
        expect(result).toBe(true);
        expect(mockCtx.reply).toHaveBeenCalledWith(expect.stringContaining('執行技能: **TestSkill**'));
        expect(mockSkill.run).toHaveBeenCalledWith(expect.objectContaining({
            brain: mockBrain,
            args: mockAct.args
        }));
        expect(mockCtx.reply).toHaveBeenCalledWith(expect.stringContaining('技能「TestSkill」已完成'));
        expect(mockCtx.reply).not.toHaveBeenCalledWith(expect.stringContaining('Skill success'));
    });

    test('execute should not expose long skill results to the user', async () => {
        const longResult = 'A'.repeat(4000);
        const mockSkill = {
            name: 'TestSkill',
            run: jest.fn().mockResolvedValue(longResult)
        };
        SkillManager.getSkill.mockReturnValue(mockSkill);

        await SkillHandler.execute(mockCtx, mockAct, mockBrain);

        expect(mockCtx.reply).toHaveBeenCalledWith(expect.stringContaining('技能「TestSkill」已完成'));
        expect(mockCtx.reply).not.toHaveBeenCalledWith(expect.stringContaining('...(已截斷)'));
        const lastReplyArg = mockCtx.reply.mock.calls[1][0];
        expect(lastReplyArg.length).toBeLessThan(4000);
    });

    test('execute should catch and reply errors', async () => {
        const mockSkill = {
            name: 'TestSkill',
            run: jest.fn().mockRejectedValue(new Error('Skill failed randomly'))
        };
        SkillManager.getSkill.mockReturnValue(mockSkill);

        await SkillHandler.execute(mockCtx, mockAct, mockBrain);
        
        expect(mockCtx.reply).toHaveBeenCalledWith(expect.stringContaining('技能執行錯誤: Skill failed randomly'));
    });

    test('execute should leave sys-admin actions to TaskController approval flow', async () => {
        SkillManager.getSkill.mockReturnValue({
            name: 'sys-admin',
            run: jest.fn().mockResolvedValue('should not run directly')
        });

        const result = await SkillHandler.execute(mockCtx, { action: 'sys_admin', parameters: { command: 'echo hello' } }, mockBrain);

        expect(result).toBe(false);
        expect(SkillManager.getSkill).not.toHaveBeenCalled();
        expect(mockCtx.reply).not.toHaveBeenCalled();
    });

    test('turns M365 connection diagnostics into a plain private summary', () => {
        const summary = SkillHandler._buildM365StatusFeedback(JSON.stringify({
            status: 'success',
            extensionOnline: false,
            m365SessionAvailable: false,
            replyErrorCode: 'FORBIDDEN_BY_POLICY',
            replyErrorMessage: 'Invalid IPC secret',
        }));

        expect(summary).toContain('Connection check: not ready.');
        expect(summary).toContain('reconnect Microsoft 365 from 「更多工具」');
        expect(summary).not.toContain('extensionOnline');
        expect(summary).not.toContain('FORBIDDEN_BY_POLICY');
        expect(summary).not.toContain('Invalid IPC secret');
    });

    test('keeps a ready M365 connection check scoped to a specific item', () => {
        const summary = SkillHandler._buildM365StatusFeedback(JSON.stringify({
            status: 'success',
            extensionOnline: true,
            m365SessionAvailable: true,
        }));

        expect(summary).toContain('Connection check: ready.');
        expect(summary).toContain('Do not claim that every file is visible.');
        expect(summary).not.toContain('m365SessionAvailable');
    });

    test('treats an online extension with no target probe as ready for an exact read', () => {
        const summary = SkillHandler._buildM365StatusFeedback(JSON.stringify({
            status: 'success',
            extensionOnline: true,
            m365SessionAvailable: false,
            probedSiteUrl: null,
        }));

        expect(summary).toContain('Connection check: ready.');
        expect(summary).not.toContain('reconnect Microsoft 365');
    });

    test('collects several plan MCP results and emits one combined Observation', async () => {
        const MCPManager = require('../src/mcp/MCPManager');
        const callTool = jest.fn()
            .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"status":"success","value":1}' }] })
            .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"status":"success","value":2}' }] });
        MCPManager.getInstance.mockReturnValue({
            load: jest.fn().mockResolvedValue(undefined),
            getServers: jest.fn().mockReturnValue([{
                name: 'test-server',
                enabled: true,
                connected: true,
                cachedTools: [{
                    name: 'read-value',
                    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                }],
            }]),
            callTool,
        });
        const collector = { entries: [] };
        const enqueue = jest.fn().mockResolvedValue(undefined);
        const onGolemObservation = jest.fn().mockResolvedValue({
            planId: 'plan-1',
            planRevision: 2,
            run: { status: 'RUNNING' },
        });
        const ctx = {
            ...mockCtx,
            workspaceConversationId: 'conversation-1',
            onGolemObservation,
        };
        const brain = { ...mockBrain, webBackend: { id: 'm365-web' } };
        const controller = { convoManager: { enqueue } };
        const dispatchOptions = {
            planMode: true,
            actionDepth: 1,
            maxActionDepth: 6,
            workspaceRunId: 'run-1',
            workspaceStepId: 'run-step-1',
            workspacePlanId: 'plan-1',
            workspacePlanRevision: 1,
            workspacePlanStepId: 'step-1',
            workspaceActionId: 'action-1',
            observationCollector: collector,
        };

        await SkillHandler.execute(ctx, {
            action: 'mcp_call', server: 'test-server', tool: 'read-value', parameters: {},
        }, brain, controller, dispatchOptions);
        await SkillHandler.execute(ctx, {
            action: 'mcp_call', server: 'test-server', tool: 'read-value', parameters: {},
        }, brain, controller, dispatchOptions);

        expect(collector.entries).toHaveLength(2);
        expect(onGolemObservation).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();

        await SkillHandler.flushObservationCollector(ctx, brain, controller, dispatchOptions, collector);

        expect(onGolemObservation).toHaveBeenCalledTimes(1);
        expect(onGolemObservation.mock.calls[0][0]).toEqual(expect.objectContaining({
            lane: 'action_batch',
            status: 'succeeded',
        }));
        expect(onGolemObservation.mock.calls[0][0].result).toContain('[Action 1/2: test-server/read-value]');
        expect(onGolemObservation.mock.calls[0][0].result).toContain('[Action 2/2: test-server/read-value]');
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue.mock.calls[0][1]).toContain('"lane": "action_batch"');
    });

    test('execute should validate mcp_call before calling tool', async () => {
        const MCPManager = require('../src/mcp/MCPManager');
        const callTool = jest.fn();
        MCPManager.getInstance.mockReturnValue({
            load: jest.fn().mockResolvedValue(undefined),
            getServers: jest.fn().mockReturnValue([
                {
                    name: 'github',
                    enabled: true,
                    connected: true,
                    cachedTools: [
                        {
                            name: 'create_issue',
                            inputSchema: {
                                type: 'object',
                                required: ['repository_full_name', 'title'],
                                properties: {
                                    repository_full_name: { type: 'string' },
                                    title: { type: 'string' },
                                },
                                additionalProperties: false,
                            },
                        },
                    ],
                },
            ]),
            callTool,
        });

        const result = await SkillHandler.execute(mockCtx, {
            action: 'mcp_call',
            server: 'github',
            tool: 'create_issue',
            parameters: { title: 'Bug' },
        }, mockBrain);

        expect(result).toBe(true);
        expect(callTool).not.toHaveBeenCalled();
        expect(mockCtx.reply).toHaveBeenCalledWith(expect.stringContaining('呼叫格式錯誤'));
    });

    test('does not expose connector validation details in an M365 workspace reply', async () => {
        const MCPManager = require('../src/mcp/MCPManager');
        const callTool = jest.fn();
        MCPManager.getInstance.mockReturnValue({
            load: jest.fn().mockResolvedValue(undefined),
            getServers: jest.fn().mockReturnValue([
                {
                    name: 'github',
                    enabled: true,
                    connected: true,
                    cachedTools: [{
                        name: 'create_issue',
                        inputSchema: {
                            type: 'object',
                            required: ['repository_full_name', 'title'],
                            properties: {
                                repository_full_name: { type: 'string' },
                                title: { type: 'string' },
                            },
                            additionalProperties: false,
                        },
                    }],
                },
            ]),
            callTool,
        });
        mockBrain.webBackend = { id: 'm365-web' };

        await SkillHandler.execute(mockCtx, {
            action: 'mcp_call',
            server: 'github',
            tool: 'create_issue',
            parameters: { title: 'Bug' },
        }, mockBrain);

        expect(callTool).not.toHaveBeenCalled();
        expect(mockCtx.reply).not.toHaveBeenCalled();
    });
});
