'use strict';

const path = require('path');
const LocalWorkspacePicker = require('../src/services/LocalWorkspacePicker');

describe('LocalWorkspacePicker', () => {
    test('fails with a clear fallback on non-Windows hosts', async () => {
        const picker = new LocalWorkspacePicker({ platform: 'linux' });
        await expect(picker.selectFolder()).rejects.toMatchObject({
            code: 'M365_FOLDER_PICKER_UNAVAILABLE',
            statusCode: 501,
        });
    });

    test('allows only one visible selection window at a time', async () => {
        const picker = new LocalWorkspacePicker({ platform: 'win32' });
        let finish;
        picker._selectFolder = jest.fn(() => new Promise((resolve) => { finish = resolve; }));

        const first = picker.selectFolder();
        await expect(picker.selectFolder()).rejects.toMatchObject({
            code: 'M365_FOLDER_PICKER_BUSY',
            statusCode: 409,
        });
        finish({ cancelled: true, path: null });
        await expect(first).resolves.toEqual({ cancelled: true, path: null });
        expect(picker.selecting).toBe(false);
    });

    test('fails before launching PowerShell when the packaged picker script is missing', async () => {
        const launch = jest.fn();
        const picker = new LocalWorkspacePicker({
            platform: 'win32',
            scriptPath: path.join(__dirname, 'missing-folder-picker.ps1'),
            execFile: launch,
        });

        await expect(picker.selectFolder()).rejects.toMatchObject({
            code: 'M365_FOLDER_PICKER_SCRIPT_MISSING',
        });
        expect(launch).not.toHaveBeenCalled();
    });

    test('passes the packaged script to PowerShell and decodes the selected folder', async () => {
        const selectedPath = path.resolve(__dirname, 'workspace-parent');
        const launch = jest.fn((_command, _args, _options, callback) => {
            callback(null, `SELECTED:${Buffer.from(selectedPath, 'utf8').toString('base64')}`, '');
        });
        const picker = new LocalWorkspacePicker({
            platform: 'win32',
            scriptPath: __filename,
            execFile: launch,
        });

        await expect(picker.selectFolder()).resolves.toEqual({
            cancelled: false,
            path: selectedPath,
        });
        expect(launch).toHaveBeenCalledWith(
            'powershell.exe',
            expect.arrayContaining(['-File', __filename]),
            expect.objectContaining({ encoding: 'utf8' }),
            expect.any(Function)
        );
    });
});
