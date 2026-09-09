const ActionExecutionGate = require('../src/managers/ActionExecutionGate');

describe('ActionExecutionGate attach_local_files', () => {
    test('accepts a bounded selected-folder request and normalizes the action name', () => {
        expect(ActionExecutionGate.validate({
            action: 'attach_local_files',
            folder_id: 'folder_123',
            relative_paths: ['one.docx', 'nested/two.pdf'],
            purpose: 'Read the original files.',
        })).toEqual(expect.objectContaining({ ok: true, lane: 'host', normalizedAction: 'attach_local_files' }));
    });

    test('rejects absolute-like extra authority and oversized selections', () => {
        expect(ActionExecutionGate.validate({
            action: 'attach_local_files',
            folder_id: 'folder_123',
            relative_paths: Array.from({ length: 101 }, (_, index) => `${index}.txt`),
            purpose: 'Read files.',
        })).toEqual(expect.objectContaining({ ok: false, code: 'M365_LOCAL_ATTACHMENT_PATHS_INVALID' }));
        expect(ActionExecutionGate.validate({
            action: 'attach_local_files',
            folder_id: 'folder_123',
            relative_paths: ['one.docx'],
            purpose: 'Read files.',
            absolute_path: 'C:\\outside.docx',
        })).toEqual(expect.objectContaining({ ok: false, code: 'M365_LOCAL_ATTACHMENT_REQUEST_INVALID' }));
    });
});
