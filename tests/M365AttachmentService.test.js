'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const M365AttachmentService = require('../src/services/M365AttachmentService');

describe('M365AttachmentService', () => {
    let rootDir;
    let service;
    let binding;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-golem-attachments-'));
        service = new M365AttachmentService({
            rootDir,
            maxFiles: 2,
            maxFileBytes: 1024,
            maxTotalBytes: 1536,
        });
        binding = {
            projectId: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
        };
    });

    afterEach(() => {
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    test('stages a project-bound file and resolves a trusted upload manifest', () => {
        const batch = service.createBatch(binding);
        const staged = service.stageFile(batch.batchId, binding, {
            fileName: 'evidence.txt',
            base64Data: Buffer.from('verified evidence').toString('base64'),
        });
        const resolved = service.resolveBatch(batch.batchId, binding);

        expect(staged.file).toEqual(expect.objectContaining({
            name: 'evidence.txt',
            mimeType: 'text/plain',
            size: 17,
        }));
        expect(resolved).toEqual(expect.objectContaining({
            validatedByM365Harness: true,
            batchId: batch.batchId,
            totalBytes: 17,
        }));
        expect(resolved.files).toHaveLength(1);
        expect(fs.readFileSync(resolved.files[0].path, 'utf8')).toBe('verified evidence');
        expect(service.cleanupBatch(batch.batchId, binding)).toBe(true);
        expect(fs.existsSync(path.join(rootDir, batch.batchId))).toBe(false);
    });

    test('rejects cross-project access, unsafe names, unsupported types, and duplicates', () => {
        const batch = service.createBatch(binding);
        expect(() => service.stageFile(batch.batchId, {
            ...binding,
            conversationId: crypto.randomUUID(),
        }, {
            fileName: 'evidence.txt',
            base64Data: Buffer.from('x').toString('base64'),
        })).toThrow(expect.objectContaining({ code: 'M365_ATTACHMENT_BINDING_MISMATCH' }));

        expect(() => service.stageFile(batch.batchId, binding, {
            fileName: '../secret.txt',
            base64Data: Buffer.from('x').toString('base64'),
        })).toThrow(expect.objectContaining({ code: 'M365_ATTACHMENT_NAME_INVALID' }));

        expect(() => service.stageFile(batch.batchId, binding, {
            fileName: 'payload.exe',
            base64Data: Buffer.from('x').toString('base64'),
        })).toThrow(expect.objectContaining({ code: 'M365_ATTACHMENT_TYPE_UNSUPPORTED' }));

        service.stageFile(batch.batchId, binding, {
            fileName: 'same.txt',
            base64Data: Buffer.from('x').toString('base64'),
        });
        expect(() => service.stageFile(batch.batchId, binding, {
            fileName: 'SAME.TXT',
            base64Data: Buffer.from('y').toString('base64'),
        })).toThrow(expect.objectContaining({ code: 'M365_ATTACHMENT_DUPLICATE_NAME' }));
    });

    test('enforces per-file and per-turn size limits', () => {
        const batch = service.createBatch(binding);
        expect(() => service.stageFile(batch.batchId, binding, {
            fileName: 'large.txt',
            base64Data: Buffer.alloc(1025, 1).toString('base64'),
        })).toThrow(expect.objectContaining({ code: 'M365_ATTACHMENT_TOO_LARGE' }));

        service.stageFile(batch.batchId, binding, {
            fileName: 'one.txt',
            base64Data: Buffer.alloc(900, 1).toString('base64'),
        });
        expect(() => service.stageFile(batch.batchId, binding, {
            fileName: 'two.txt',
            base64Data: Buffer.alloc(700, 2).toString('base64'),
        })).toThrow(expect.objectContaining({ code: 'M365_ATTACHMENT_TOTAL_LIMIT' }));
    });

    test('rejects a staged file that was replaced with same-sized content', () => {
        const batch = service.createBatch(binding);
        service.stageFile(batch.batchId, binding, {
            fileName: 'evidence.txt',
            base64Data: Buffer.from('first').toString('base64'),
        });
        fs.writeFileSync(path.join(rootDir, batch.batchId, 'evidence.txt'), 'other', 'utf8');

        expect(() => service.resolveBatch(batch.batchId, binding))
            .toThrow(expect.objectContaining({ code: 'M365_ATTACHMENT_STAGE_INVALID' }));
    });
});
