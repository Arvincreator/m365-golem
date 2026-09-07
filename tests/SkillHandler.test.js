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
