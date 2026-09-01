const MultiAgentHandler = require('../src/core/action_handlers/MultiAgentHandler');

describe('MultiAgentHandler', () => {
    test('execute calls controller._handleMultiAgent', async () => {
        const mockCtx = { reply: jest.fn() };
        const mockAct = { action: 'multi_agent' };
        const mockController = {
            _handleMultiAgent: jest.fn().mockResolvedValue()
        };
        const mockBrain = {};

        await MultiAgentHandler.execute(mockCtx, mockAct, mockController, mockBrain);

        expect(mockController._handleMultiAgent).toHaveBeenCalledWith(mockCtx, mockAct, mockBrain);
    });
});
