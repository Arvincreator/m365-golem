'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function pickerError(code, message, statusCode = 500) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

class LocalWorkspacePicker {
    constructor(options = {}) {
        this.platform = options.platform || process.platform;
        this.powershellPath = options.powershellPath || 'powershell.exe';
        this.execFile = options.execFile || execFile;
        this.scriptPath = options.scriptPath || path.resolve(
            __dirname,
            '../../scripts/select-workspace-folder.ps1'
        );
        this.timeoutMs = Math.max(10000, Number(options.timeoutMs || 10 * 60 * 1000));
        this.selecting = false;
    }

    async selectFolder(options = {}) {
        if (this.selecting) {
            throw pickerError(
                'M365_FOLDER_PICKER_BUSY',
                'A folder selection window is already open.',
                409
            );
        }
        this.selecting = true;
        try {
            return await this._selectFolder(options);
        } finally {
            this.selecting = false;
        }
    }

    async _selectFolder(options = {}) {
        if (this.platform !== 'win32') {
            throw pickerError(
                'M365_FOLDER_PICKER_UNAVAILABLE',
                'This computer does not support the Windows folder picker. Enter an absolute path instead.',
                501
            );
        }

        if (!fs.existsSync(this.scriptPath)) {
            throw pickerError(
                'M365_FOLDER_PICKER_SCRIPT_MISSING',
                '資料夾選擇元件遺失，請重新執行 Install-M365-Golem.bat 修復安裝。'
            );
        }

        const args = [
            '-NoLogo',
            '-NoProfile',
            '-STA',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            this.scriptPath,
            '-Description',
            String(options.description || 'Select a workspace folder for M365 Golem'),
        ];
        if (String(options.initialPath || '').trim()) {
            args.push('-InitialPath', String(options.initialPath).trim());
        }

        const stdout = await new Promise((resolve, reject) => {
            this.execFile(this.powershellPath, args, {
                windowsHide: false,
                timeout: this.timeoutMs,
                maxBuffer: 1024 * 1024,
                encoding: 'utf8',
            }, (error, output, stderr) => {
                if (error) {
                    const timedOut = error.killed || error.code === 'ETIMEDOUT';
                    reject(pickerError(
                        timedOut ? 'M365_FOLDER_PICKER_TIMEOUT' : 'M365_FOLDER_PICKER_FAILED',
                        timedOut
                            ? '資料夾選擇視窗等待逾時，請重試或直接輸入絕對路徑。'
                            : '無法開啟 Windows 資料夾選擇視窗，請重試、直接輸入絕對路徑，或執行 Install-M365-Golem.bat 修復安裝。'
                    ));
                    return;
                }
                resolve(String(output || '').trim());
            });
        });

        if (!stdout || stdout === 'CANCELLED') {
            return { cancelled: true, path: null };
        }
        if (!stdout.startsWith('SELECTED:')) {
            throw pickerError('M365_FOLDER_PICKER_RESPONSE_INVALID', 'The folder picker returned an invalid response.');
        }

        let selectedPath;
        try {
            selectedPath = Buffer.from(stdout.slice('SELECTED:'.length), 'base64').toString('utf8');
        } catch (_) {
            throw pickerError('M365_FOLDER_PICKER_RESPONSE_INVALID', 'The selected folder path could not be decoded.');
        }
        if (!path.isAbsolute(selectedPath)) {
            throw pickerError('M365_FOLDER_PICKER_RESPONSE_INVALID', 'The folder picker did not return an absolute path.');
        }
        return { cancelled: false, path: path.resolve(selectedPath) };
    }
}

module.exports = LocalWorkspacePicker;
module.exports.pickerError = pickerError;
