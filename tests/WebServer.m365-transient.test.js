jest.mock('../web-dashboard/routes/api.calendar', () => () => require('express').Router());

const WebServer = require('../web-dashboard/server');
const ConfigManager = require('../src/config');

function createServerShell() {
    const server = Object.create(WebServer.prototype);
    server.logBuffer = [];
    server.chatHistory = new Map();
    server.io = { emit: jest.fn() };
    return server;
}

describe('WebServer M365 transient chat events', () => {
    const originalBackend = ConfigManager.CONFIG.GOLEM_BACKEND;

    afterEach(() => {
        ConfigManager.CONFIG.GOLEM_BACKEND = originalBackend;
    });

    test('emits transient chat events without retaining them locally', () => {
        const server = createServerShell();
        const event = {
            msg: '[User] POC secret',
            raw: '[User] POC secret',
            type: 'agent',
            golemId: 'golem_A',
            transient: true,
        };

        server.broadcastLog(event);

        expect(server.io.emit).toHaveBeenCalledWith('log', event);
        expect(server.logBuffer).toEqual([]);
        expect(server.chatHistory.size).toBe(0);
    });

    test('preserves the existing retained-log behavior for normal backends', () => {
        ConfigManager.CONFIG.GOLEM_BACKEND = 'gemini';
        const server = createServerShell();
        const event = {
            msg: '[User] normal prompt',
            type: 'agent',
            golemId: 'golem_A',
        };

        server.broadcastLog(event);

        expect(server.logBuffer).toEqual([event]);
        expect(server.chatHistory.get('golem_A')).toEqual([event]);
    });

    test('emits only a content-free update signal for encrypted workspace conversations', () => {
        ConfigManager.CONFIG.GOLEM_BACKEND = 'm365-web';
        const server = createServerShell();
        const event = {
            msg: '[golem_A] confidential client response',
            raw: 'confidential client response',
            type: 'agent',
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            requestId: 'request-1',
        };

        server.broadcastLog(event);

        expect(server.logBuffer).toEqual([]);
        expect(server.chatHistory.size).toBe(0);
        expect(server.io.emit).toHaveBeenCalledWith('log', {
            time: undefined,
            type: 'agent',
            golemId: 'golem_A',
            projectId: 'project-1',
            conversationId: 'conversation-1',
            requestId: 'request-1',
            transient: true,
        });
        expect(JSON.stringify(server.io.emit.mock.calls)).not.toContain('confidential client response');
    });
});
