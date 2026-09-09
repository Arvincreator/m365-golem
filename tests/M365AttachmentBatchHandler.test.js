'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AttachmentBatchHandler = require('../src/core/action_handlers/AttachmentBatchHandler');
const M365AttachmentService = require('../src/services/M365AttachmentService');
const M365LocalFolderService = require('../src/services/M365LocalFolderService');

describe('M365 attachment batch workflow', () => {
    let root;
    let stagingRoot;
    let originalGetOrCreate;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-batch-source-'));
        stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-batch-stage-'));
        originalGetOrCreate = global.getOrCreateGolem;
    });

    afterEach(() => {
        global.getOrCreateGolem = originalGetOrCreate;
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stagingRoot, { recursive: true, force: true });
    });

    test('uploads 11 originals as 10 plus 1, hides receipts, then sends one combined Observation', async () => {
        const relativePaths = Array.from({ length: 11 }, (_, index) => `file-${String(index + 1).padStart(2, '0')}.txt`);
        relativePaths.forEach((name) => fs.writeFileSync(path.join(root, name), `content ${name}`, 'utf8'));
        const attachmentService = new M365AttachmentService({ rootDir: stagingRoot });
        const progress = [];
        const receiptCalls = [];
        const convoManager = {
            enqueue: jest.fn(async (_ctx, prompt, options) => {
                if (options.batchIngestMode) {
                    receiptCalls.push(options.attachment.files.map((file) => file.name));
                    const match = prompt.match(/Job: ([^;]+); batch (\d+)\/(\d+)/);
                    const names = options.attachment.files.map((file) => file.name);
                    return {
                        text: `[GOLEM_BATCH_RECEIPT]\n${JSON.stringify({
                            schema_version: 'golem_attachment_batch/1',
                            job_id: match[1],
                            batch_index: Number(match[2]),
                            batch_count: Number(match[3]),
                            files: names.map((name) => ({ source_name: name, status: 'read', note: 'ok' })),
                            batch_summary: `Read ${names.length} files`,
                        })}\n[/GOLEM_BATCH_RECEIPT]`,
                    };
                }
                return undefined;
            }),
        };
        const actionQueue = { enqueue: jest.fn(async (_ctx, task) => { await task(); return 'task-1'; }) };
        global.getOrCreateGolem = () => ({ actionQueue, convoManager });
        const ctx = {
            workspaceProjectId: crypto.randomUUID(),
            workspaceConversationId: crypto.randomUUID(),
            workspaceLocalFolders: [{ id: 'folder_test', path: root }],
            m365LocalFolderService: new M365LocalFolderService(),
            m365AttachmentService: attachmentService,
            onAttachmentBatchProgress: jest.fn(async (value) => progress.push(value)),
            onGolemObservation: jest.fn(async () => ({ planId: 'plan-1', planRevision: 2 })),
        };

        const handled = await AttachmentBatchHandler.execute(ctx, {
            action: 'attach_local_files', folder_id: 'folder_test', relative_paths: relativePaths,
            purpose: 'Read original files.',
        }, { webBackend: { id: 'm365-web' } }, { golemId: 'default', convoManager }, {
            planMode: true, workspaceRunId: 'run-1', workspaceStepId: 'step-1',
            workspacePlanId: 'plan-1', workspacePlanRevision: 1, maxActionDepth: 5,
        });

        expect(handled).toBe(true);
        expect(receiptCalls.map((batch) => batch.length)).toEqual([10, 1]);
        expect(progress.at(-1)).toEqual(expect.objectContaining({ status: 'completed', completedFiles: 11, batchCount: 2 }));
        expect(ctx.onGolemObservation).toHaveBeenCalledTimes(1);
        expect(convoManager.enqueue).toHaveBeenCalledTimes(3);
        expect(fs.readdirSync(stagingRoot)).toEqual([]);
    });

    test('rejects a receipt with missing file coverage', () => {
        expect(() => AttachmentBatchHandler.parseReceipt(
            `[GOLEM_BATCH_RECEIPT]${JSON.stringify({
                schema_version: 'golem_attachment_batch/1', job_id: 'job', batch_index: 1, batch_count: 1,
                files: [], batch_summary: 'empty',
            })}[/GOLEM_BATCH_RECEIPT]`,
            { jobId: 'job', batchIndex: 1, batchCount: 1, names: ['expected.pdf'] }
        )).toThrow(expect.objectContaining({ code: 'M365_ATTACHMENT_RECEIPT_COVERAGE_INVALID' }));
    });

    test('uploads 100 image originals in ten silent batches before one combined Observation', async () => {
        const relativePaths = Array.from({ length: 100 }, (_, index) => `image-${String(index + 1).padStart(3, '0')}.png`);
        relativePaths.forEach((name) => fs.writeFileSync(path.join(root, name), Buffer.from([0x89, 0x50, 0x4e, 0x47])));
        const attachmentService = new M365AttachmentService({ rootDir: stagingRoot });
        const receiptCalls = [];
        const convoManager = {
            enqueue: jest.fn(async (_ctx, prompt, options) => {
                if (!options.batchIngestMode) return undefined;
                const match = prompt.match(/Job: ([^;]+); batch (\d+)\/(\d+)/);
                const names = options.attachment.files.map((file) => file.name);
                receiptCalls.push(names);
                return {
                    text: `[GOLEM_BATCH_RECEIPT]${JSON.stringify({
                        schema_version: 'golem_attachment_batch/1',
                        job_id: match[1],
                        batch_index: Number(match[2]),
                        batch_count: Number(match[3]),
                        files: names.map((name) => ({ source_name: name, status: 'read', note: 'visible' })),
                        batch_summary: `Read ${names.length} images`,
                    })}[/GOLEM_BATCH_RECEIPT]`,
                };
            }),
        };
        global.getOrCreateGolem = () => ({
            actionQueue: { enqueue: jest.fn(async (_ctx, task) => { await task(); return 'batch-task'; }) },
            convoManager,
        });
        const ctx = {
            workspaceProjectId: crypto.randomUUID(),
            workspaceConversationId: crypto.randomUUID(),
            workspaceLocalFolders: [{ id: 'folder_images', path: root }],
            m365LocalFolderService: new M365LocalFolderService(),
            m365AttachmentService: attachmentService,
            onAttachmentBatchProgress: jest.fn(async () => undefined),
            onGolemObservation: jest.fn(async () => ({ planId: 'plan-images', planRevision: 2 })),
        };

        expect(await AttachmentBatchHandler.execute(ctx, {
            action: 'attach_local_files',
            folder_id: 'folder_images',
            relative_paths: relativePaths,
            purpose: 'Inspect every original image.',
        }, { webBackend: { id: 'm365-web' } }, { golemId: 'default', convoManager }, {
            planMode: true,
            workspaceRunId: 'run-images',
            workspaceStepId: 'step-images',
            workspacePlanId: 'plan-images',
            workspacePlanRevision: 1,
            maxActionDepth: 12,
        })).toBe(true);

        expect(receiptCalls).toHaveLength(10);
        expect(receiptCalls.every((batch) => batch.length === 10)).toBe(true);
        expect(ctx.onGolemObservation).toHaveBeenCalledTimes(1);
        expect(convoManager.enqueue).toHaveBeenCalledTimes(11);
        expect(ctx.onAttachmentBatchProgress).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'completed',
            completedFiles: 100,
            batchCount: 10,
        }));
        expect(fs.readdirSync(stagingRoot)).toEqual([]);
    });
});
