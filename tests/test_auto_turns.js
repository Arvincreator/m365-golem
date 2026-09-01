const ConversationManager = require('../src/core/ConversationManager');
const ConfigManager = require('../src/config');

// Mock Brain
const mockBrain = {
    recall: async () => [],
    sendMessage: async (text) => {
        return { text: 'AI Response', attachments: [] };
    },
    _appendChatLog: () => {}
};

// Mock NeuroShunter
const mockNeuroShunter = {
    dispatch: async (ctx, raw, brain, controller, options) => {
        console.log(`[Mock NeuroShunter] Dispatched with options:`, options);
    }
};

// Mock Context
const createMockCtx = (id) => ({
    chatId: id,
    platform: 'test',
    sendTyping: async () => {},
    reply: async (text, options) => {
        console.log(`[Mock Ctx] Reply: ${text}`);
    }
});

async function runTest() {
    console.log("🚀 Starting Auto-Turn Limit Test...");
    
    // Set a low limit for testing
    process.env.GOLEM_MAX_AUTO_TURNS = "3";
    ConfigManager.CONFIG.MAX_AUTO_TURNS = 3;

    const manager = new ConversationManager(mockBrain, mockNeuroShunter, {}, { golemId: 'test_golem' });
    const ctx = createMockCtx('user_123');

    console.log("\n--- Turn 1: User Message (Reset) ---");
    await manager.enqueue(ctx, "Hello", { bypassDebounce: false });
    // Wait for debounce (since bypassDebounce is false)
    await new Promise(r => setTimeout(r, 2000));

    console.log("\n--- Turn 2: System Feedback (Increment) ---");
    await manager.enqueue(ctx, "[Observation] Result 1", { bypassDebounce: true, isSystemFeedback: true });
    await new Promise(r => setTimeout(r, 1000));

    console.log("\n--- Turn 3: System Feedback (Increment) ---");
    await manager.enqueue(ctx, "[Observation] Result 2", { bypassDebounce: true, isSystemFeedback: true });
    await new Promise(r => setTimeout(r, 1000));

    console.log("\n--- Turn 4: System Feedback (Should Trigger Limit) ---");
    await manager.enqueue(ctx, "[Observation] Result 3", { bypassDebounce: true, isSystemFeedback: true });
    await new Promise(r => setTimeout(r, 1000));

    console.log("\n--- Turn 5: User Message (Should Reset) ---");
    await manager.enqueue(ctx, "New User Message", { bypassDebounce: false });
    await new Promise(r => setTimeout(r, 2000));

    console.log("\n✅ Test sequence finished.");
}

runTest().catch(console.error);
