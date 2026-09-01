const { ProtocolFormatter } = require('../packages/protocol');
const ConfigManager = require('../src/config');

async function runTest() {
    console.log("🚀 Starting Verbose Response Word Limit Test...");
    
    // Case 1: No limit
    ConfigManager.CONFIG.MAX_RESPONSE_WORDS = 0;
    console.log("Setting MAX_RESPONSE_WORDS to:", ConfigManager.CONFIG.MAX_RESPONSE_WORDS);
    let envelope = ProtocolFormatter.buildEnvelope("Hello", "id1");
    if (!envelope.includes("10. LENGTH:")) {
        console.log("✅ Case 1 Passed: No limit injected.");
    } else {
        console.error("❌ Case 1 Failed: Limit injected.");
    }

    // Case 2: 50 words limit
    ConfigManager.CONFIG.MAX_RESPONSE_WORDS = 50;
    console.log("Setting MAX_RESPONSE_WORDS to:", ConfigManager.CONFIG.MAX_RESPONSE_WORDS);
    envelope = ProtocolFormatter.buildEnvelope("Hello", "id2");
    if (envelope.includes("10. LENGTH: 🚨 STRICT LIMIT 🚨 Keep your ENTIRE reply under 50 characters/words.")) {
        console.log("✅ Case 2 Passed: 50 words limit correctly injected.");
    } else {
        console.error("❌ Case 2 Failed: 50 words limit NOT correctly injected.");
        console.log("DEBUG Envelope snippet:", envelope.substring(envelope.indexOf("9. WORKSPACE"), envelope.indexOf("[USER INPUT")));
    }

    // Case 3: 100 words limit
    ConfigManager.CONFIG.MAX_RESPONSE_WORDS = 100;
    console.log("Setting MAX_RESPONSE_WORDS to:", ConfigManager.CONFIG.MAX_RESPONSE_WORDS);
    envelope = ProtocolFormatter.buildEnvelope("Hello", "id3");
    if (envelope.includes("10. LENGTH: 🚨 STRICT LIMIT 🚨 Keep your ENTIRE reply under 100 characters/words.")) {
        console.log("✅ Case 3 Passed: 100 words limit correctly injected.");
    } else {
        console.error("❌ Case 3 Failed: 100 words limit NOT correctly injected.");
        console.log("DEBUG Envelope snippet:", envelope.substring(envelope.indexOf("9. WORKSPACE"), envelope.indexOf("[USER INPUT")));
    }

    console.log("\n✅ Test sequence finished.");
}

runTest().catch(console.error);
