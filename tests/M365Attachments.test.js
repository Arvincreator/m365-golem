'use strict';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const {
    collectClipboardImageCandidates,
    collectDroppedAttachmentCandidates,
} = jiti('../web-dashboard/src/lib/m365-attachments.ts');

test('rejects a dropped folder before recursively reading any of its files', async () => {
    const createReader = jest.fn();
    const dataTransfer = {
        items: [{
            webkitGetAsEntry: () => ({
                isDirectory: true,
                isFile: false,
                name: 'large-folder',
                createReader,
            }),
        }],
        files: [],
    };

    await expect(collectDroppedAttachmentCandidates(dataTransfer)).rejects.toThrow(
        '資料夾不會整批上傳'
    );
    expect(createReader).not.toHaveBeenCalled();
});

test('turns pasted clipboard screenshots into safely named image attachments', () => {
    const png = new File([new Uint8Array([137, 80, 78, 71])], '', { type: 'image/png' });
    const clipboardData = {
        items: [
            { kind: 'string', type: 'text/plain', getAsFile: () => null },
            { kind: 'file', type: 'image/png', getAsFile: () => png },
        ],
    };

    const candidates = collectClipboardImageCandidates(clipboardData, Date.parse('2026-09-09T01:02:03.456Z'));

    expect(candidates).toHaveLength(1);
    expect(candidates[0].file.name).toBe('screenshot-20260909-010203.456.png');
    expect(candidates[0].file.type).toBe('image/png');
    expect(candidates[0].file.size).toBe(png.size);
    expect(candidates[0].displayPath).toBe(candidates[0].file.name);
});

test('ignores ordinary text paste so the textarea keeps its native paste behavior', () => {
    const clipboardData = {
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
    };

    expect(collectClipboardImageCandidates(clipboardData)).toEqual([]);
});
