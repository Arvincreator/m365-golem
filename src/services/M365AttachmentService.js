'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_STALE_MS = 60 * 60 * 1000;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const MIME_BY_EXTENSION = new Map([
    ['.pdf', 'application/pdf'],
    ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.txt', 'text/plain'],
    ['.md', 'text/markdown'],
    ['.csv', 'text/csv'],
    ['.tsv', 'text/tab-separated-values'],
    ['.json', 'application/json'],
    ['.xml', 'application/xml'],
    ['.yaml', 'application/yaml'],
    ['.yml', 'application/yaml'],
    ['.html', 'text/html'],
    ['.htm', 'text/html'],
    ['.rtf', 'application/rtf'],
    ['.log', 'text/plain'],
    ['.js', 'text/javascript'],
    ['.jsx', 'text/javascript'],
    ['.ts', 'text/typescript'],
    ['.tsx', 'text/typescript'],
    ['.py', 'text/x-python'],
    ['.java', 'text/x-java-source'],
    ['.cs', 'text/plain'],
    ['.cpp', 'text/x-c++src'],
    ['.c', 'text/x-csrc'],
    ['.h', 'text/x-chdr'],
    ['.php', 'text/x-php'],
    ['.css', 'text/css'],
    ['.sql', 'application/sql'],
    ['.sh', 'text/x-shellscript'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.bmp', 'image/bmp'],
    ['.tiff', 'image/tiff'],
    ['.tif', 'image/tiff'],
]);

function attachmentError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function requireBoundId(value, fieldName) {
    const id = String(value || '').trim();
    if (!SAFE_ID_PATTERN.test(id)) {
        throw attachmentError('M365_ATTACHMENT_BINDING_INVALID', `${fieldName} is invalid.`);
    }
    return id;
}

function validateFileName(value) {
    const name = String(value || '').normalize('NFC').trim();
    if (!name || name.length > 180 || name !== path.basename(name)
        || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)
        || name === '.' || name === '..' || WINDOWS_RESERVED_NAMES.test(name)) {
        throw attachmentError('M365_ATTACHMENT_NAME_INVALID', 'Attachment filename is not safe.');
    }
    const extension = path.extname(name).toLowerCase();
    if (!MIME_BY_EXTENSION.has(extension)) {
        throw attachmentError(
            'M365_ATTACHMENT_TYPE_UNSUPPORTED',
            `Attachment type is not supported: ${extension || '(none)'}`
        );
    }
    return { name, extension, mimeType: MIME_BY_EXTENSION.get(extension) };
}

function decodeBase64(value, maxBytes) {
    const raw = String(value || '').trim();
    const cleaned = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    if (!cleaned || cleaned.length > Math.ceil(maxBytes * 4 / 3) + 8
        || !/^[a-zA-Z0-9+/]*={0,2}$/.test(cleaned)) {
        throw attachmentError('M365_ATTACHMENT_PAYLOAD_INVALID', 'Attachment payload is invalid.');
    }
    const buffer = Buffer.from(cleaned, 'base64');
    if (buffer.length === 0 || buffer.length > maxBytes) {
        throw attachmentError(
            'M365_ATTACHMENT_TOO_LARGE',
            `Each attachment must be between 1 byte and ${maxBytes} bytes.`,
            413
        );
    }
    return buffer;
}

class M365AttachmentService {
    constructor(options = {}) {
        this.rootDir = path.resolve(options.rootDir || path.join(process.cwd(), 'data', 'temp_uploads', 'm365'));
        this.maxFiles = Math.max(1, Math.min(Number(options.maxFiles || DEFAULT_MAX_FILES), 20));
        this.maxFileBytes = Math.max(1, Math.min(Number(options.maxFileBytes || DEFAULT_MAX_FILE_BYTES), 50 * 1024 * 1024));
        this.maxTotalBytes = Math.max(this.maxFileBytes, Math.min(
            Number(options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES),
            100 * 1024 * 1024
        ));
        this.staleMs = Math.max(60 * 1000, Number(options.staleMs || DEFAULT_STALE_MS));
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        fs.mkdirSync(this.rootDir, { recursive: true });
        this.sweepStaleBatches();
    }

    _batchRoot(batchId) {
        const id = requireBoundId(batchId, 'batchId');
        const root = path.resolve(this.rootDir, id);
        const prefix = `${this.rootDir}${path.sep}`;
        if (!root.startsWith(prefix)) {
            throw attachmentError('M365_ATTACHMENT_BATCH_INVALID', 'Attachment batch path is invalid.');
        }
        return root;
    }

    _manifestPath(batchId) {
        return path.join(this._batchRoot(batchId), 'manifest.json');
    }

    _readManifest(batchId) {
        const manifestPath = this._manifestPath(batchId);
        if (!fs.existsSync(manifestPath)) {
            throw attachmentError('M365_ATTACHMENT_BATCH_NOT_FOUND', 'Attachment batch was not found.', 404);
        }
        const stat = fs.lstatSync(manifestPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw attachmentError('M365_ATTACHMENT_BATCH_INVALID', 'Attachment batch manifest is invalid.');
        }
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('schema');
            return manifest;
        } catch (_) {
            throw attachmentError('M365_ATTACHMENT_BATCH_INVALID', 'Attachment batch manifest is invalid.');
        }
    }

    _writeManifest(manifest) {
        const manifestPath = this._manifestPath(manifest.id);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'w',
        });
    }

    _assertBinding(manifest, projectId, conversationId) {
        const expectedProjectId = requireBoundId(projectId, 'projectId');
        const expectedConversationId = requireBoundId(conversationId, 'conversationId');
        if (manifest.projectId !== expectedProjectId || manifest.conversationId !== expectedConversationId) {
            throw attachmentError(
                'M365_ATTACHMENT_BINDING_MISMATCH',
                'Attachment batch does not belong to the selected project conversation.',
                409
            );
        }
    }

    createBatch({ projectId, conversationId }) {
        const batchId = crypto.randomUUID();
        const manifest = {
            version: 1,
            id: batchId,
            projectId: requireBoundId(projectId, 'projectId'),
            conversationId: requireBoundId(conversationId, 'conversationId'),
            createdAt: new Date(this.now()).toISOString(),
            updatedAt: new Date(this.now()).toISOString(),
            totalBytes: 0,
            files: [],
        };
        const batchRoot = this._batchRoot(batchId);
        fs.mkdirSync(batchRoot, { recursive: false, mode: 0o700 });
        this._writeManifest(manifest);
        return { batchId, maxFiles: this.maxFiles, maxFileBytes: this.maxFileBytes, maxTotalBytes: this.maxTotalBytes };
    }

    stageFile(batchId, binding, input = {}) {
        const manifest = this._readManifest(batchId);
        this._assertBinding(manifest, binding.projectId, binding.conversationId);
        if (manifest.files.length >= this.maxFiles) {
            throw attachmentError('M365_ATTACHMENT_FILE_LIMIT', `At most ${this.maxFiles} attachments can be sent in one turn.`, 413);
        }
        const file = validateFileName(input.fileName);
        if (manifest.files.some((item) => item.name.toLowerCase() === file.name.toLowerCase())) {
            throw attachmentError('M365_ATTACHMENT_DUPLICATE_NAME', `Duplicate attachment filename: ${file.name}`, 409);
        }
        const buffer = decodeBase64(input.base64Data, this.maxFileBytes);
        if (manifest.totalBytes + buffer.length > this.maxTotalBytes) {
            throw attachmentError(
                'M365_ATTACHMENT_TOTAL_LIMIT',
                `Attachments in one turn cannot exceed ${this.maxTotalBytes} bytes.`,
                413
            );
        }
        const filePath = path.join(this._batchRoot(batchId), file.name);
        fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });
        const entry = {
            id: crypto.randomUUID(),
            name: file.name,
            extension: file.extension,
            mimeType: file.mimeType,
            size: buffer.length,
            sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        };
        manifest.files.push(entry);
        manifest.totalBytes += buffer.length;
        manifest.updatedAt = new Date(this.now()).toISOString();
        this._writeManifest(manifest);
        return { file: entry, fileCount: manifest.files.length, totalBytes: manifest.totalBytes };
    }

    resolveBatch(batchId, binding) {
        const manifest = this._readManifest(batchId);
        this._assertBinding(manifest, binding.projectId, binding.conversationId);
        if (manifest.files.length === 0) {
            throw attachmentError('M365_ATTACHMENT_BATCH_EMPTY', 'Attachment batch is empty.');
        }
        const batchRoot = this._batchRoot(batchId);
        const files = manifest.files.map((entry) => {
            const filePath = path.join(batchRoot, entry.name);
            const stat = fs.lstatSync(filePath);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) {
                throw attachmentError('M365_ATTACHMENT_STAGE_INVALID', 'A staged attachment changed before dispatch.');
            }
            const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
            if (!/^[0-9a-f]{64}$/i.test(String(entry.sha256 || '')) || actualHash !== entry.sha256) {
                throw attachmentError('M365_ATTACHMENT_STAGE_INVALID', 'A staged attachment failed its integrity check.');
            }
            return { ...entry, path: filePath };
        });
        return {
            isNative: true,
            validatedByM365Harness: true,
            batchId: manifest.id,
            files,
            totalBytes: manifest.totalBytes,
        };
    }

    cleanupBatch(batchId, binding = null) {
        const batchRoot = this._batchRoot(batchId);
        if (!fs.existsSync(batchRoot)) return false;
        if (binding) {
            const manifest = this._readManifest(batchId);
            this._assertBinding(manifest, binding.projectId, binding.conversationId);
        }
        fs.rmSync(batchRoot, { recursive: true, force: true });
        return true;
    }

    sweepStaleBatches() {
        if (!fs.existsSync(this.rootDir)) return 0;
        let removed = 0;
        const cutoff = this.now() - this.staleMs;
        for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !SAFE_ID_PATTERN.test(entry.name)) continue;
            const batchRoot = this._batchRoot(entry.name);
            const stat = fs.lstatSync(batchRoot);
            if (stat.isSymbolicLink() || stat.mtimeMs >= cutoff) continue;
            fs.rmSync(batchRoot, { recursive: true, force: true });
            removed += 1;
        }
        return removed;
    }
}

function getM365AttachmentService(server) {
    if (!server.m365AttachmentService) {
        server.m365AttachmentService = new M365AttachmentService({
            maxFileBytes: server.maxM365AttachmentBytes,
        });
    }
    return server.m365AttachmentService;
}

module.exports = M365AttachmentService;
module.exports.getM365AttachmentService = getM365AttachmentService;
module.exports.MIME_BY_EXTENSION = MIME_BY_EXTENSION;
