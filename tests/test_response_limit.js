const { ProtocolFormatter } = require('../packages/protocol');
const ConfigManager = require('../src/config');

async function runTest() {
    console.log("🚀 Starting Response Word Limit Test...");
    
    // Case 1: No limit
    ConfigManager.CONFIG.MAX_RESPONSE_WORDS = 0;
    let envelope = ProtocolFormatter.buildEnvelope("Hello", "id1");
    if (!envelope.includes("Length: 🚨 STRICT LIMIT 🚨")) {
        console.log("✅ Case 1 Passed: No limit injected when MAX_RESPONSE_WORDS is 0.");
    } else {
        console.error("❌ Case 1 Failed: Limit injected when MAX_RESPONSE_WORDS is 0.");
    }

    // Case 2: 50 words limit
    ConfigManager.CONFIG.MAX_RESPONSE_WORDS = 50;
    envelope = ProtocolFormatter.buildEnvelope("Hello", "id2");
    if (envelope.includes("Length: 🚨 STRICT LIMIT 🚨 Keep your ENTIRE reply under 50 characters/words.")) {
        console.log("✅ Case 2 Passed: 50 words limit correctly injected.");
    } else {
        console.error("❌ Case 2 Failed: 50 words limit NOT correctly injected.");
        console.debug("Envelope content:", envelope);
    }

    // Case 3: 100 words limit
    ConfigManager.CONFIG.MAX_RESPONSE_WORDS = 100;
    envelope = ProtocolFormatter.buildEnvelope("Hello", "id3");
    if (envelope.includes("Length: 🚨 STRICT LIMIT 🚨 Keep your ENTIRE reply under 100 characters/words.")) {
        console.log("✅ Case 3 Passed: 100 words limit correctly injected.");
    } else {
        console.error("❌ Case 3 Failed: 100 words limit NOT correctly injected.");
    }

    console.log("\n✅ Test sequence finished.");
}

runTest().catch(console.error);
