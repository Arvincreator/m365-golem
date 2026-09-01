const { LanceDBProDriver } = require('../packages/memory');
const ConfigManager = require('../src/config/index');
const path = require('path');
const fs = require('fs');

async function testEmbeddingSelection() {
    console.log("🧪 Starting Embedding Model Selection test...");

    // Test 1: Local Model Initialization (Transformers)
    console.log("\n--- Test 1: Local Transformers Provider ---");
    process.env.GOLEM_EMBEDDING_PROVIDER = 'local';
    process.env.GOLEM_LOCAL_EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5';
    ConfigManager.reloadConfig();

    const localDriver = new LanceDBProDriver();
    console.log(`Table Name: ${localDriver.tableName}`);
    
    try {
        await localDriver.init();
        console.log("✅ Local initialization successful");

        console.log("📝 Memorizing a Chinese sentence...");
        await localDriver.memorize("你好，這是一個測試。", { importance: 0.9 });
        
        console.log("🔍 Recalling...");
        const results = await localDriver.recall("你好");
        console.log("Recall results:");
        results.forEach((r, i) => console.log(`${i+1}. [Score: ${r.score.toFixed(4)}] ${r.text}`));
        
        if (results.length > 0 && results[0].text.includes("測試")) {
            console.log("✅ Local BGE recall successful!");
        }
    } catch (e) {
        console.error("❌ Local test failed:", e);
    }

    // Test 2: Table Isolation (Gemini vs Local)
    console.log("\n--- Test 2: Table Isolation ---");
    process.env.GOLEM_EMBEDDING_PROVIDER = 'gemini';
    ConfigManager.reloadConfig();
    const geminiDriver = new LanceDBProDriver();
    await geminiDriver.init();
    console.log(`Gemini DB Path: ${geminiDriver.dbPath}`);
    
    if (geminiDriver.dbPath !== localDriver.dbPath) {
        console.log("✅ Table isolation logic confirmed (Different paths for different dimensions/providers)");
    } else {
        console.log("❌ Table isolation logic failed (Same path used!)");
    }

    console.log("\n🧪 Tests completed.");
}

testEmbeddingSelection();
