'use strict';

// Synthetic, offline evaluation. Missing cached models are an explicit failure, never a download.
const assert = require('node:assert/strict');
const capabilities = require('../src/managers/ToolCapabilities');
const ToolRouter = require('../src/managers/ToolRouter');

async function main() {
    const { pipeline, env } = await import('@xenova/transformers');
    env.allowRemoteModels = false;
    const model = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { local_files_only: true });
    const embed = async text => Array.from((await model(text, { pooling: 'mean', normalize: true })).data);
    const entries = await Promise.all(capabilities.map(async item => ({
        id: item.id,
        vector: await embed([item.id, item.name, item.description, ...item.triggers].join(' | ')),
    })));
    const router = new ToolRouter({ activeTools: [], mcpServers: [], toolVectorIndex: {
        search: async text => {
            const vector = await embed(text);
            return entries.map(item => ({ id: item.id, score: item.vector.reduce((sum, value, index) => sum + value * vector[index], 0) }))
                .sort((a, b) => b.score - a.score);
        },
    } });
    const cases = [
        ['implicit-artifact', '把剛剛那些整理成一份可以帶走的成品', true],
        ['desktop-word', '幫我在桌面新增一個相關內容的word報告', true],
        ['local-inspection', '看看電腦裡有哪些檔案', true],
        ['native-research', '找公司裡相關文件', false],
        ['remote-destination', '請在 SharePoint 建立 Word 報告', false],
        ['explanation', '請解釋文件製作的原理', false],
        ['mixed-source', '根據已看到的 SharePoint 圖片，在桌面建立 Word 報告', true],
    ];
    try {
        for (const [id, query, expectedLocal] of cases) {
            const result = await router.routeAsync(query);
            assert.equal(result.diagnostics.mode, 'hybrid', `${id}: vector search unavailable`);
            assert.equal(result.commandLane.recommended, expectedLocal, `${id}: incorrect local route`);
            console.log(JSON.stringify({ id, local: result.commandLane.recommended, source: result.diagnostics.commandSource, rejected: result.diagnostics.commandRejected }));
        }
        console.log(`PASS: ${cases.length} synthetic routing cases with cached local embeddings. This is not Copilot execution or tenant validation.`);
    } finally { await model.dispose(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
