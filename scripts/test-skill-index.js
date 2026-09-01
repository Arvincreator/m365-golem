const SkillIndexManager = require('../src/managers/SkillIndexManager');
const path = require('path');
const fs = require('fs');
const { MEMORY_BASE_DIR } = require('../src/config');

const skillIndexManager = new SkillIndexManager(MEMORY_BASE_DIR);

async function testIndex() {
    console.log('🧪 Starting Skill Index Test...');

    try {
        // 1. Sync
        await skillIndexManager.sync();

        // 2. Check DB file
        const dbPath = path.join(process.cwd(), 'golem_memory', 'skills.db');
        if (fs.existsSync(dbPath)) {
            console.log('✅ SQLite DB file created at:', dbPath);
        } else {
            throw new Error('❌ DB file not found!');
        }

        // 3. Search test
        const results = await skillIndexManager.searchSkills('memory');
        console.log('🔍 Search results for "memory":', results.length);
        if (results.length > 0) {
            console.log('✅ Found skill:', results[0].name);
        } else {
            console.warn('⚠️ No skills found matching "memory".');
        }

        // 4. Enabled skills test
        const enabled = await skillIndexManager.getEnabledSkills(['memory', 'chronos']);
        console.log('📚 Enabled skills retrieved:', enabled.length);
        if (enabled.length >= 1) {
            console.log('✅ Retrieved skill content for:', enabled.map(s => s.id).join(', '));
        } else {
            throw new Error('❌ Failed to retrieve enabled skills!');
        }

        // 5. Setup Guard Simulation
        console.log('🧪 Testing Setup Guard Simulation...');
        const mockUserDataDir = path.join(process.cwd(), 'temp_mock_user_data');
        if (fs.existsSync(mockUserDataDir)) fs.rmSync(mockUserDataDir, { recursive: true });

        // Use PersonaManager to check existence in non-existent dir
        const personaManager = require('../src/skills/core/persona');
        if (!personaManager.exists(mockUserDataDir)) {
            console.log('✅ Setup Guard successfully identifies unconfigured Golem.');
        } else {
            throw new Error('❌ Setup Guard failed to identify unconfigured Golem!');
        }

        // 6. Dashboard Simulation Test: Remove a skill
        console.log('🧪 Testing explicit removal...');
        await skillIndexManager.removeSkill('git');
        const afterRemove = await skillIndexManager.getEnabledSkills(['git']);
        if (afterRemove.length === 0) {
            console.log('✅ Skill "git" successfully removed from SQLite.');
        } else {
            throw new Error('❌ Skill "git" still exists in SQLite after removal!');
        }

        // 6. Dashboard Simulation Test: Add a skill
        console.log('🧪 Testing explicit addition...');
        await skillIndexManager.addSkill('git');
        const afterAdd = await skillIndexManager.getEnabledSkills(['git']);
        if (afterAdd.length === 1) {
            console.log('✅ Skill "git" successfully added back to SQLite.');
        } else {
            throw new Error('❌ Skill "git" failed to add to SQLite!');
        }

        console.log('\n✨ All integration tests passed!');
        process.exit(0);
    } catch (e) {
        console.error('❌ Test failed:', e);
        process.exit(1);
    }
}

testIndex();
