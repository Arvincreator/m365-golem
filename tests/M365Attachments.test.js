'use strict';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const { collectDroppedAttachmentCandidates } = jiti('../web-dashboard/src/lib/m365-attachments.ts');

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
