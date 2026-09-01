const { parentPort, workerData } = require('worker_threads');

let pipelinePromise = null;

async function getPipeline() {
    if (!pipelinePromise) {
        pipelinePromise = (async () => {
            const { pipeline } = await import('@xenova/transformers');
            return await pipeline('feature-extraction', workerData.modelName);
        })();
    }
    return pipelinePromise;
}

parentPort.on('message', async (message) => {
    try {
        if (message.type === 'init') {
            await getPipeline();
            parentPort.postMessage({ id: message.id, success: true });
        } else if (message.type === 'embed') {
            const pipe = await getPipeline();
            const output = await pipe(message.text, { pooling: 'mean', normalize: true });
            parentPort.postMessage({ id: message.id, success: true, data: Array.from(output.data) });
        }
    } catch (e) {
        parentPort.postMessage({ id: message.id, success: false, error: e.message });
    }
});
