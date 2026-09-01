const { LanceDBProDriver } = require('../packages/memory');
const path = require('path');
const fs = require('fs');

async function testProDriver() {
    console.log("🧪 Starting LanceDBProDriver test...");
    const driver = new LanceDBProDriver();
    
    try {
        // 1. Init
        console.log("🎬 Initializing driver...");
        await driver.init();
        console.log("✅ Initialization successful");

        // 2. Memorize
        console.log("📝 Storing some memories...");
        await driver.memorize("My favorite color is blue.", { importance: 0.8, category: 'preference' });
        await driver.memorize("The capital of France is Paris.", { importance: 0.5, category: 'fact' });
        await driver.memorize("I am a software engineer.", { importance: 0.9, category: 'other' });

        // 3. Recall (Vector/Semantic)
        console.log("🔍 Testing recall (semantic)...");
        const results = await driver.recall("What do I do for work?");
        console.log("Recall results for 'What do I do for work?':");
        results.forEach((r, i) => console.log(`${i+1}. [Score: ${r.score.toFixed(4)}] ${r.text}`));

        if (results.length > 0 && results.some(r => r.text.includes("software engineer"))) {
            console.log("✅ Semantic recall match successful!");
        } else {
            console.log("❌ Semantic recall match failed.");
        }

        // 4. Recall (Keyword/BM25)
        console.log("🔍 Testing recall (keyword)...");
        const factResults = await driver.recall("France");
        console.log("Recall results for 'France':");
        factResults.forEach((r, i) => console.log(`${i+1}. [Score: ${r.score.toFixed(4)}] ${r.text}`));

        if (factResults.length > 0 && factResults.some(r => r.text.includes("France"))) {
            console.log("✅ Keyword recall successful!");
        } else {
            console.log("❌ Keyword recall failed.");
        }

        // 5. Clear
        console.log("🗑️ Testing clear...");
        await driver.clearMemory();
        await driver.init(); // Re-init
        const emptyResults = await driver.recall("France");
        if (emptyResults.length === 0) {
            console.log("✅ Memory clearing successful!");
        } else {
            console.log("❌ Memory clearing failed.");
        }

        // 6. Export/Import
        // (Skipping for brevity as it's just a wrapper)

    } catch (e) {
        console.error("❌ Test failed with error:", e);
    }
}

testProDriver();
