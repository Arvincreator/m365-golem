const GolemBrain = require('../src/core/GolemBrain');
const ConfigManager = require('../src/config');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

async function verifyFullRestart() {
    console.log('🧪 Starting Verification: Complete Restart Flow...');

    const envPath = path.resolve(__dirname, '../.env');
    const originalEnv = fs.readFileSync(envPath, 'utf8');
    const TEST_KEY = 'GOLEM_VERIFICATION_TEST';
    const TEST_VALUE = 'RESTARTED_' + Date.now();

    try {
        // 1. Setup mock brain
        console.log('--- 1. Initializing Brain ---');
        const brain = new GolemBrain({ golemId: 'test_golem', userDataDir: './golem_memory/test_golem' });
        
        // 2. Modify .env manually (simulate dashboard change)
        console.log(`--- 2. Simulating .env change: ${TEST_KEY}=${TEST_VALUE} ---`);
        fs.appendFileSync(envPath, `\n${TEST_KEY}=${TEST_VALUE}\n`);
        
        // 3. Trigger reloadSkills
        console.log('--- 3. Triggering brain.reloadSkills() ---');
        // Note: We don't want it to actually try to navigate Gemini in this test context if we can avoid it,
        // but reloadSkills() now has that logic. We'll mock page.goto if needed or just catch the error if no browser.
        brain.page = {
            goto: async (url) => { console.log(`   [Mock Browser] Navigating to ${url}`); return; },
            waitForSelector: async () => {},
            evaluate: async () => {},
            type: async () => {},
            click: async () => {}
        };
        brain.sendMessage = async (text) => { console.log(`   [Mock Brain] Injection Prompt Sent.`); return "OK"; };

        await brain.reloadSkills();

        // 4. Verify Config Reload
        console.log('--- 4. Verifying Config Reload ---');
        if (process.env[TEST_KEY] === TEST_VALUE) {
            console.log(`✅ Config Reloaded: process.env.${TEST_KEY} is correct.`);
        } else {
            throw new Error(`❌ Config NOT reloaded! Expected ${TEST_VALUE}, got ${process.env[TEST_KEY]}`);
        }

        // 5. Verify Protocol Cache Clear (it should be updated recently)
        const { ProtocolFormatter } = require('../packages/protocol');
        const now = Date.now();
        if (ProtocolFormatter._lastScanTime > now - 5000) {
            console.log(`✅ Protocol Cache Refreshed (lastScanTime is recent: ${ProtocolFormatter._lastScanTime}).`);
        } else {
            throw new Error(`❌ Protocol Cache NOT refreshed! lastScanTime is ${ProtocolFormatter._lastScanTime}`);
        }

        console.log('\n✨ [SUCCESS] Full Restart Flow Verified: Config, Protocol, and Workflow synced.');

    } catch (e) {
        console.error('\n❌ [FAILURE] Verification failed:', e.message);
        process.exit(1);
    } finally {
        // Cleanup
        console.log('🧹 Cleaning up .env...');
        fs.writeFileSync(envPath, originalEnv);
    }
}

verifyFullRestart();
