'use strict';

const {
    captureM365ConversationBinding,
} = require('../src/services/M365WorkspaceService');

describe('M365WorkspaceService conversation binding', () => {
    const unboundConversation = {
        id: 'conversation-1',
        status: 'active',
        bindingState: 'unbound',
        remoteConversationId: null,
        remoteConversationUrl: null,
    };

    test('waits for a newly created M365 conversation URL to settle before binding', async () => {
        const stableSnapshot = {
            status: 'expected_host',
            isConversation: true,
            conversationId: 'remote-1',
            url: 'https://m365.cloud.microsoft/chat/conversation/remote-1',
        };
        const snapshots = [
            { status: 'expected_host', isConversation: false, conversationId: null, url: 'https://m365.cloud.microsoft/chat' },
            { status: 'expected_host', isConversation: false, conversationId: null, url: 'https://m365.cloud.microsoft/chat' },
            stableSnapshot,
        ];
        const brain = {
            getM365ConversationSnapshot: jest.fn(() => snapshots.shift() || stableSnapshot),
        };
        const boundConversation = {
            ...unboundConversation,
            bindingState: 'bound',
            remoteConversationId: 'remote-1',
            remoteConversationUrl: stableSnapshot.url,
        };
        const store = {
            setConversationBinding: jest.fn().mockResolvedValue(boundConversation),
        };

        await expect(captureM365ConversationBinding(
            store,
            'golem_A',
            unboundConversation,
            { brain, timeoutMs: 100, pollIntervalMs: 1 }
        )).resolves.toEqual(boundConversation);

        expect(brain.getM365ConversationSnapshot).toHaveBeenCalledTimes(3);
        expect(store.setConversationBinding).toHaveBeenCalledWith('conversation-1', {
            bindingState: 'bound',
            remoteConversationUrl: stableSnapshot.url,
            remoteConversationId: 'remote-1',
        });
    });

    test('keeps the conservative recovery boundary when no durable URL appears', async () => {
        const brain = {
            getM365ConversationSnapshot: jest.fn(() => ({
                status: 'expected_host',
                isConversation: false,
                conversationId: null,
                url: 'https://m365.cloud.microsoft/chat',
            })),
        };
        const store = {
            setConversationBinding: jest.fn(),
        };

        await expect(captureM365ConversationBinding(
            store,
            'golem_A',
            unboundConversation,
            { brain, timeoutMs: 0, pollIntervalMs: 1 }
        )).rejects.toMatchObject({ code: 'M365_CONVERSATION_BINDING_PENDING' });

        expect(brain.getM365ConversationSnapshot).toHaveBeenCalledTimes(1);
        expect(store.setConversationBinding).not.toHaveBeenCalled();
    });

    test('does not rewrite an already matching durable binding', async () => {
        const conversation = {
            ...unboundConversation,
            bindingState: 'bound',
            remoteConversationId: 'remote-1',
            remoteConversationUrl: 'https://m365.cloud.microsoft/chat/conversation/remote-1',
        };
        const brain = {
            getM365ConversationSnapshot: jest.fn(() => ({
                status: 'expected_host',
                isConversation: true,
                conversationId: 'remote-1',
                url: conversation.remoteConversationUrl,
            })),
        };
        const store = {
            setConversationBinding: jest.fn(),
        };

        await expect(captureM365ConversationBinding(
            store,
            'golem_A',
            conversation,
            { brain, timeoutMs: 0 }
        )).resolves.toBe(conversation);
        expect(store.setConversationBinding).not.toHaveBeenCalled();
    });
});
