'use strict';
const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const { DraftController, emptyDraft } = jiti('../web-dashboard/src/features/m365-workspace/lib/draft-controller.ts');
const { shouldSubmit } = jiti('../web-dashboard/src/features/m365-workspace/lib/composer-input.ts');
const { LatestQuery } = jiti('../web-dashboard/src/features/m365-workspace/lib/latest-query.ts');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
    let server = emptyDraft();
    const transport = { read: jest.fn(async () => structuredClone(server)), write: jest.fn(async (draft, revision) => {
        if (server.revision !== revision) throw Object.assign(new Error('conflict'), { status: 409 });
        server = { ...structuredClone(draft), revision: revision + 1 }; return structuredClone(server);
    }) };
    return { transport, controller: new DraftController(transport), get: () => server };
}
test('IME, 229, repeated/default-prevented/menu/modified Enter never submit; ordinary Enter does', () => {
    expect(shouldSubmit({ key: 'Enter' }, false)).toBe(true);
    for (const patch of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { defaultPrevented: true }]) expect(shouldSubmit({ key: 'Enter', ...patch }, false)).toBe(false);
    expect(shouldSubmit({ key: 'Enter' }, true)).toBe(false);
    expect(shouldSubmit({ key: 'Enter' }, false, true)).toBe(false);
});
test('duplicate send is synchronous; ACK clears only A and saves newly typed B', async () => {
    const { controller, get } = fixture(); await controller.initialize();
    controller.update({ text: 'A' });
    const first = controller.beginSubmit();
    expect(await controller.beginSubmit()).toBeNull();
    const snapshot = await first;
    controller.update({ text: 'B' });
    await controller.accepted(snapshot); controller.endSubmit(); await controller.flush();
    expect(controller.getSnapshot().draft.text).toBe('B'); expect(get().text).toBe('B');
    expect(get().revision).toBe(3);
});
test('new text while initial flush is pending is flushed before snapshot capture', async () => {
    const { controller, transport } = fixture(); await controller.initialize();
    const gate = deferred(); const write = transport.write.getMockImplementation();
    transport.write.mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
    controller.update({ text: 'A' }); const submit = controller.beginSubmit();
    await Promise.resolve(); controller.update({ text: 'B' }); gate.resolve();
    const snapshot = await submit; expect(snapshot.draft.text).toBe('B');
    await controller.accepted(snapshot); controller.endSubmit(); expect(controller.getSnapshot().draft.text).toBe('');
});
test('accepted send keeps selected local folders available for follow-up turns', async () => {
    const { controller, get } = fixture(); await controller.initialize();
    const folder = { id: 'folder_receipts', name: '憑證', path: 'C:\\Receipts' };
    controller.update({ text: '先列出檔案', localFolders: [folder] });
    const snapshot = await controller.beginSubmit();
    await controller.accepted(snapshot); controller.endSubmit();
    expect(controller.getSnapshot().draft.text).toBe('');
    expect(controller.getSnapshot().draft.localFolders).toEqual([folder]);
    expect(get().localFolders).toEqual([folder]);
});
test('two windows preserve local edits on conflict and explicitly resolve', async () => {
    const { controller: a, transport } = fixture(); const b = new DraftController(transport);
    await Promise.all([a.initialize(), b.initialize()]);
    a.update({ text: 'window A' }); await a.flush();
    b.update({ text: 'window B' }); await expect(b.flush()).rejects.toMatchObject({ status: 409 });
    expect(b.getSnapshot().draft.text).toBe('window B');
    expect(b.getSnapshot().status).toBe('conflict');
    await b.resolveConflict(true); expect(b.getSnapshot().status).toBe('saved');
});
test('a failed or unknown send keeps draft and does not itself dispatch or cancel anything', async () => {
    const { controller } = fixture(); await controller.initialize(); controller.update({ text: 'keep me' });
    await controller.beginSubmit(); controller.endSubmit();
    expect(controller.getSnapshot().draft.text).toBe('keep me');
});
test('latest query aborts only reads and rejects same-scope old completion', () => {
    const query = new LatestQuery(); const a = query.begin('messages'); const b = query.begin('messages');
    expect(a.current()).toBe(false); expect(a.signal.aborted).toBe(true); expect(b.current()).toBe(true);
    query.dispose(); expect(b.current()).toBe(false);
});
