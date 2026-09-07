'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Store = require('../src/managers/M365WorkspaceStore');
const { isLocalUxRequest, normalizeDraft } = require('../src/services/M365UxDraft');

describe('encrypted UX drafts', () => {
    let dir, store, project, conversation;
    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-draft-'));
        store = new Store({ dbPath: path.join(dir, 'test.sqlite'), encryptionKey: Buffer.alloc(32, 17).toString('base64') });
        project = await store.createProject({ name: 'Synthetic project' });
        conversation = await store.createConversation(project.id, { title: 'Synthetic conversation' });
    });
    afterEach(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    test('CAS conflicts and tombstones reject old autosaves, including another connection', async () => {
        const a = await store.saveDraft(project.id, conversation.id, 0, { text: 'A' });
        expect(a.revision).toBe(1);
        const other = new Store({ dbPath: path.join(dir, 'test.sqlite'), encryptionKey: Buffer.alloc(32, 17).toString('base64') });
        try {
            await expect(other.saveDraft(project.id, conversation.id, 0, { text: 'B' })).rejects.toMatchObject({ statusCode: 409 });
            await store.saveDraft(project.id, conversation.id, 1, {});
            await expect(other.saveDraft(project.id, conversation.id, 1, { text: 'resurrected' })).rejects.toMatchObject({ statusCode: 409 });
            expect(await other.getDraft(project.id, conversation.id)).toMatchObject({ text: '', revision: 2 });
        } finally { await other.close(); }
    });
    test('scope is enforced and reference bindings are deny-first', async () => {
        const b = await store.createProject({ name: 'Other synthetic project' });
        await expect(store.saveDraft(b.id, conversation.id, 0, { text: 'wrong' })).rejects.toMatchObject({ statusCode: 403 });
        await expect(store.getDraft(b.id, conversation.id)).rejects.toMatchObject({ statusCode: 403 });
        expect(await store.listProjectReferences(project.id)).toEqual([]);
        await store.bindProjectReference(project.id, 'synthetic-ref');
        expect(await store.listProjectReferences(project.id)).toEqual(['synthetic-ref']);
        expect(await store.listProjectReferences(b.id)).toEqual([]);
    });
    test('text, quote, names and selections are encrypted in DB and WAL; File is not restored', async () => {
        const secret = 'SYNTHETIC-PRIVATE-UX-SECRET';
        await store.saveDraft(project.id, conversation.id, 0, { text: secret, referenceFileIds: [secret],
            quote: { messageId: 'message-id', excerpt: secret }, attachmentDescriptors: [{ id: 'file', fileName: secret, size: 10, lastModified: 1, state: 'local_selected' }] });
        for (const file of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, file)).includes(Buffer.from(secret))).toBe(false);
        await store.close();
        store = new Store({ dbPath: path.join(dir, 'test.sqlite'), encryptionKey: Buffer.alloc(32, 17).toString('base64') });
        const restored = await store.getDraft(project.id, conversation.id);
        expect(restored.text).toBe(secret);
        expect(restored.attachmentDescriptors[0].state).toBe('needs_reselect');
        const wrong = new Store({ dbPath: path.join(dir, 'test.sqlite'), encryptionKey: Buffer.alloc(32, 18).toString('base64') });
        try {
            await expect(wrong.getDraft(project.id, conversation.id)).rejects.toMatchObject({ code: 'M365_DATA_DECRYPT_FAILED' });
            await expect(wrong.saveDraft(project.id, conversation.id, 1, {})).rejects.toMatchObject({ code: 'M365_DATA_DECRYPT_FAILED' });
        } finally { await wrong.close(); }
    });
});

test('UX local origin guard rejects forged proxy headers, nonlocal peer, Host and Origin', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000', origin: 'http://localhost:3001' } };
    expect(isLocalUxRequest(req)).toBe(true);
    for (const headers of [{ 'x-forwarded-for': '127.0.0.1' }, { 'x-forwarded-host': 'localhost:3000' }, { origin: 'https://evil.example' }, { host: 'evil.example:3000' }]) expect(isLocalUxRequest({ ...req, headers: { ...req.headers, ...headers } })).toBe(false);
    expect(isLocalUxRequest({ ...req, socket: { remoteAddress: '203.0.113.7' } })).toBe(false);
});

test('descriptor and content limits fail closed', () => {
    expect(() => normalizeDraft({ text: 'a'.repeat(100001) })).toThrow();
    expect(() => normalizeDraft({ attachmentDescriptors: [{ id: 'x', fileName: 'x', size: 26 * 1024 * 1024, lastModified: 1 }] })).toThrow();
    expect(() => normalizeDraft({ mcpServerNames: ['a', 'b', 'c', 'd'] })).toThrow();
});
