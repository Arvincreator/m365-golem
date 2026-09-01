'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

const RUN_STATUSES = Object.freeze([
    'DRAFT',
    'WAITING_START_APPROVAL',
    'QUEUED',
    'RUNNING',
    'WAITING_USER',
    'WAITING_APPROVAL',
    'PAUSED',
    'RECONCILE_REQUIRED',
    'BLOCKED',
    'FAILED',
    'CANCELED',
    'COMPLETED',
]);

const RUN_TRANSITIONS = Object.freeze({
    DRAFT: new Set(['WAITING_START_APPROVAL', 'CANCELED']),
    WAITING_START_APPROVAL: new Set(['QUEUED', 'CANCELED']),
    QUEUED: new Set(['RUNNING', 'PAUSED', 'CANCELED', 'FAILED']),
    RUNNING: new Set([
        'QUEUED',
        'WAITING_USER',
        'WAITING_APPROVAL',
        'PAUSED',
        'RECONCILE_REQUIRED',
        'BLOCKED',
        'FAILED',
        'CANCELED',
        'COMPLETED',
    ]),
    WAITING_USER: new Set(['QUEUED', 'CANCELED', 'FAILED']),
    WAITING_APPROVAL: new Set(['QUEUED', 'CANCELED', 'FAILED']),
    PAUSED: new Set([
        'QUEUED',
        'WAITING_USER',
        'WAITING_APPROVAL',
        'RECONCILE_REQUIRED',
        'BLOCKED',
        'FAILED',
        'CANCELED',
        'COMPLETED',
    ]),
    RECONCILE_REQUIRED: new Set(['QUEUED', 'FAILED', 'CANCELED', 'COMPLETED']),
    BLOCKED: new Set(['QUEUED', 'FAILED', 'CANCELED']),
    FAILED: new Set(),
    CANCELED: new Set(),
    COMPLETED: new Set(),
});

function workspaceError(code, message, details = null) {
    const error = new Error(message);
    error.code = code;
    if (details) error.details = details;
    return error;
}

function parseEncryptionKey(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        throw workspaceError(
            'M365_DATA_KEY_REQUIRED',
            'M365 workspace persistence requires M365_DATA_ENCRYPTION_KEY. Plaintext fallback is not allowed.'
        );
    }

    let key = null;
    if (/^[0-9a-f]{64}$/i.test(raw)) {
        key = Buffer.from(raw, 'hex');
    } else {
        try {
            key = Buffer.from(raw, 'base64');
        } catch (_) {
            key = null;
        }
    }

    if (!key || key.length !== 32) {
        throw workspaceError(
            'M365_DATA_KEY_INVALID',
            'M365_DATA_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64 or 64 hexadecimal characters.'
        );
    }
    return key;
}

function requireText(value, field, maxLength) {
    const text = String(value || '').trim();
    if (!text) throw workspaceError('M365_VALIDATION_ERROR', `${field} is required.`);
    if (text.length > maxLength) {
        throw workspaceError('M365_VALIDATION_ERROR', `${field} exceeds ${maxLength} characters.`);
    }
    return text;
}

function optionalText(value, field, maxLength) {
    const text = String(value || '').trim();
    if (text.length > maxLength) {
        throw workspaceError('M365_VALIDATION_ERROR', `${field} exceeds ${maxLength} characters.`);
    }
    return text;
}

class M365WorkspaceStore {
    constructor(options = {}) {
        this.dbPath = path.resolve(options.dbPath || path.join(process.cwd(), 'data', 'm365-workspace.sqlite'));
        this.key = parseEncryptionKey(options.encryptionKey || process.env.M365_DATA_ENCRYPTION_KEY);
        this.clock = typeof options.clock === 'function' ? options.clock : () => new Date();
        this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : uuidv4;
        this.db = null;
        this._initPromise = null;
        this._serial = Promise.resolve();
    }

    async init() {
        if (this._initPromise) return this._initPromise;
        this._initPromise = this._initialize().catch((error) => {
            this._initPromise = null;
            throw error;
        });
        return this._initPromise;
    }

    async _initialize() {
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        this.db = await new Promise((resolve, reject) => {
            const db = new sqlite3.Database(this.dbPath, (error) => {
                if (error) reject(error);
                else resolve(db);
            });
        });

        await this._run('PRAGMA foreign_keys = ON;');
        await this._run('PRAGMA journal_mode = WAL;');
        await this._run('PRAGMA synchronous = FULL;');
        await this._run('PRAGMA busy_timeout = 5000;');
        await this._migrate();
        return this;
    }

    async _migrate() {
        await this._run(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
        `);

        const applied = await this._get('SELECT version FROM schema_migrations WHERE version = 1');
        if (applied) return;

        await this._transaction(async () => {
            await this._run(`
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    name_ciphertext TEXT NOT NULL,
                    name_iv TEXT NOT NULL,
                    name_tag TEXT NOT NULL,
                    description_ciphertext TEXT NOT NULL,
                    description_iv TEXT NOT NULL,
                    description_tag TEXT NOT NULL,
                    instructions_ciphertext TEXT NOT NULL,
                    instructions_iv TEXT NOT NULL,
                    instructions_tag TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
                    retention_mode TEXT NOT NULL DEFAULT 'manual',
                    context_version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            `);
            await this._run(`
                CREATE TABLE conversations (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
                    title_ciphertext TEXT NOT NULL,
                    title_iv TEXT NOT NULL,
                    title_tag TEXT NOT NULL,
                    remote_url_ciphertext TEXT,
                    remote_url_iv TEXT,
                    remote_url_tag TEXT,
                    remote_conversation_id_ciphertext TEXT,
                    remote_conversation_id_iv TEXT,
                    remote_conversation_id_tag TEXT,
                    binding_state TEXT NOT NULL CHECK (binding_state IN ('unbound', 'bound', 'reconcile_required', 'broken')),
                    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
                    project_context_version INTEGER NOT NULL DEFAULT 1,
                    last_message_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            `);
            await this._run(`
                CREATE TABLE messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
                    source TEXT NOT NULL CHECK (source IN ('user', 'm365', 'system')),
                    content_ciphertext TEXT NOT NULL,
                    content_iv TEXT NOT NULL,
                    content_tag TEXT NOT NULL,
                    request_id TEXT,
                    run_id TEXT,
                    step_id TEXT,
                    delivery_state TEXT NOT NULL CHECK (delivery_state IN ('local', 'dispatch_started', 'confirmed', 'response_confirmed', 'ambiguous', 'failed')),
                    created_at TEXT NOT NULL
                )
            `);
            await this._run(`
                CREATE TABLE runs (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
                    objective_ciphertext TEXT NOT NULL,
                    objective_iv TEXT NOT NULL,
                    objective_tag TEXT NOT NULL,
                    constraints_ciphertext TEXT NOT NULL,
                    constraints_iv TEXT NOT NULL,
                    constraints_tag TEXT NOT NULL,
                    verification_ciphertext TEXT NOT NULL,
                    verification_iv TEXT NOT NULL,
                    verification_tag TEXT NOT NULL,
                    status TEXT NOT NULL,
                    max_steps INTEGER NOT NULL,
                    current_step INTEGER NOT NULL DEFAULT 0,
                    error_code TEXT,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    updated_at TEXT NOT NULL
                )
            `);
            await this._run(`
                CREATE TABLE run_steps (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
                    step_number INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'reconcile_required', 'failed', 'completed', 'canceled')),
                    prompt_ciphertext TEXT NOT NULL,
                    prompt_iv TEXT NOT NULL,
                    prompt_tag TEXT NOT NULL,
                    summary_ciphertext TEXT NOT NULL,
                    summary_iv TEXT NOT NULL,
                    summary_tag TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(run_id, step_number),
                    UNIQUE(request_id)
                )
            `);
            await this._run(`
                CREATE TABLE run_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
                    event_type TEXT NOT NULL,
                    payload_ciphertext TEXT NOT NULL,
                    payload_iv TEXT NOT NULL,
                    payload_tag TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            `);
            await this._run(`
                CREATE TABLE checkpoints (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
                    step_id TEXT REFERENCES run_steps(id) ON DELETE RESTRICT,
                    sequence INTEGER NOT NULL,
                    state_ciphertext TEXT NOT NULL,
                    state_iv TEXT NOT NULL,
                    state_tag TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(run_id, sequence)
                )
            `);
            await this._run(`
                CREATE TABLE approvals (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
                    step_id TEXT REFERENCES run_steps(id) ON DELETE RESTRICT,
                    approval_type TEXT NOT NULL,
                    request_ciphertext TEXT NOT NULL,
                    request_iv TEXT NOT NULL,
                    request_tag TEXT NOT NULL,
                    decision_ciphertext TEXT NOT NULL,
                    decision_iv TEXT NOT NULL,
                    decision_tag TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'canceled')),
                    requested_at TEXT NOT NULL,
                    decided_at TEXT
                )
            `);

            await this._run('CREATE INDEX idx_conversations_project ON conversations(project_id, status, updated_at DESC)');
            await this._run('CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at, id)');
            await this._run('CREATE INDEX idx_runs_conversation ON runs(conversation_id, created_at DESC)');
            await this._run('CREATE INDEX idx_run_events_run ON run_events(run_id, id)');
            await this._run('CREATE INDEX idx_checkpoints_run ON checkpoints(run_id, sequence DESC)');
            await this._run('CREATE INDEX idx_approvals_run ON approvals(run_id, status)');
            await this._run(
                'INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)',
                [this._now()]
            );
        });
    }

    _now() {
        const value = this.clock();
        return (value instanceof Date ? value : new Date(value)).toISOString();
    }

    _encrypt(value, aad) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(aad, 'utf8'));
        const ciphertext = Buffer.concat([
            cipher.update(String(value ?? ''), 'utf8'),
            cipher.final(),
        ]);
        return {
            ciphertext: ciphertext.toString('base64'),
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
        };
    }

    _decrypt(record, prefix, aad) {
        const ciphertext = record[`${prefix}_ciphertext`];
        const iv = record[`${prefix}_iv`];
        const tag = record[`${prefix}_tag`];
        if (ciphertext === null || ciphertext === undefined) return null;
        try {
            const decipher = crypto.createDecipheriv(
                'aes-256-gcm',
                this.key,
                Buffer.from(iv, 'base64')
            );
            decipher.setAAD(Buffer.from(aad, 'utf8'));
            decipher.setAuthTag(Buffer.from(tag, 'base64'));
            return Buffer.concat([
                decipher.update(Buffer.from(ciphertext, 'base64')),
                decipher.final(),
            ]).toString('utf8');
        } catch (error) {
            throw workspaceError(
                'M365_DATA_DECRYPT_FAILED',
                'Stored M365 workspace data could not be authenticated or decrypted.',
                { field: prefix, recordId: record.id }
            );
        }
    }

    _encryptedParams(value, aad) {
        const encrypted = this._encrypt(value, aad);
        return [encrypted.ciphertext, encrypted.iv, encrypted.tag];
    }

    _enqueue(work) {
        const operation = this._serial.then(async () => {
            await this.init();
            return work();
        });
        this._serial = operation.catch(() => undefined);
        return operation;
    }

    _run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function onRun(error) {
                if (error) reject(error);
                else resolve({ changes: this.changes, lastID: this.lastID });
            });
        });
    }

    _get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (error, row) => {
                if (error) reject(error);
                else resolve(row || null);
            });
        });
    }

    _all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (error, rows) => {
                if (error) reject(error);
                else resolve(rows || []);
            });
        });
    }

    async _transaction(work) {
        await this._run('BEGIN IMMEDIATE');
        try {
            const result = await work();
            await this._run('COMMIT');
            return result;
        } catch (error) {
            await this._run('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }

    _decodeProject(row) {
        if (!row) return null;
        return {
            id: row.id,
            name: this._decrypt(row, 'name', `projects:${row.id}:name`),
            description: this._decrypt(row, 'description', `projects:${row.id}:description`),
            instructions: this._decrypt(row, 'instructions', `projects:${row.id}:instructions`),
            status: row.status,
            retentionMode: row.retention_mode,
            contextVersion: row.context_version,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    _decodeConversation(row) {
        if (!row) return null;
        return {
            id: row.id,
            projectId: row.project_id,
            title: this._decrypt(row, 'title', `conversations:${row.id}:title`),
            remoteConversationUrl: this._decrypt(row, 'remote_url', `conversations:${row.id}:remote_url`),
            remoteConversationId: this._decrypt(row, 'remote_conversation_id', `conversations:${row.id}:remote_conversation_id`),
            bindingState: row.binding_state,
            status: row.status,
            projectContextVersion: row.project_context_version,
            lastMessageAt: row.last_message_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    _decodeMessage(row) {
        if (!row) return null;
        return {
            id: row.id,
            conversationId: row.conversation_id,
            role: row.role,
            source: row.source,
            content: this._decrypt(row, 'content', `messages:${row.id}:content`),
            requestId: row.request_id,
            runId: row.run_id,
            stepId: row.step_id,
            deliveryState: row.delivery_state,
            createdAt: row.created_at,
        };
    }

    async createProject(input = {}) {
        const name = requireText(input.name, 'name', 160);
        const description = optionalText(input.description, 'description', 8000);
        const instructions = optionalText(input.instructions, 'instructions', 12000);
        const id = this.idFactory();
        const now = this._now();
        const nameParts = this._encryptedParams(name, `projects:${id}:name`);
        const descriptionParts = this._encryptedParams(description, `projects:${id}:description`);
        const instructionParts = this._encryptedParams(instructions, `projects:${id}:instructions`);

        return this._enqueue(async () => {
            await this._run(`
                INSERT INTO projects (
                    id,
                    name_ciphertext, name_iv, name_tag,
                    description_ciphertext, description_iv, description_tag,
                    instructions_ciphertext, instructions_iv, instructions_tag,
                    status, retention_mode, context_version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'manual', 1, ?, ?)
            `, [
                id,
                ...nameParts,
                ...descriptionParts,
                ...instructionParts,
                now,
                now,
            ]);
            return this._decodeProject(await this._get('SELECT * FROM projects WHERE id = ?', [id]));
        });
    }

    async listProjects(options = {}) {
        const includeArchived = options.includeArchived === true;
        return this._enqueue(async () => {
            const rows = await this._all(
                `SELECT * FROM projects ${includeArchived ? '' : "WHERE status = 'active'"} ORDER BY updated_at DESC, id DESC`
            );
            return rows.map((row) => this._decodeProject(row));
        });
    }

    async getProject(projectId) {
        return this._enqueue(async () => {
            const row = await this._get('SELECT * FROM projects WHERE id = ?', [projectId]);
            if (!row) throw workspaceError('M365_PROJECT_NOT_FOUND', 'Project not found.');
            return this._decodeProject(row);
        });
    }

    async updateProject(projectId, changes = {}) {
        return this._enqueue(async () => this._transaction(async () => {
            const current = await this._get('SELECT * FROM projects WHERE id = ?', [projectId]);
            if (!current) throw workspaceError('M365_PROJECT_NOT_FOUND', 'Project not found.');
            if (current.status === 'archived') {
                throw workspaceError('M365_PROJECT_ARCHIVED', 'Archived projects cannot be edited.');
            }

            const name = changes.name === undefined
                ? this._decrypt(current, 'name', `projects:${projectId}:name`)
                : requireText(changes.name, 'name', 160);
            const description = changes.description === undefined
                ? this._decrypt(current, 'description', `projects:${projectId}:description`)
                : optionalText(changes.description, 'description', 8000);
            const instructions = changes.instructions === undefined
                ? this._decrypt(current, 'instructions', `projects:${projectId}:instructions`)
                : optionalText(changes.instructions, 'instructions', 12000);
            const contextChanged = changes.description !== undefined || changes.instructions !== undefined;
            const contextVersion = contextChanged ? current.context_version + 1 : current.context_version;
            const now = this._now();

            await this._run(`
                UPDATE projects SET
                    name_ciphertext = ?, name_iv = ?, name_tag = ?,
                    description_ciphertext = ?, description_iv = ?, description_tag = ?,
                    instructions_ciphertext = ?, instructions_iv = ?, instructions_tag = ?,
                    context_version = ?, updated_at = ?
                WHERE id = ?
            `, [
                ...this._encryptedParams(name, `projects:${projectId}:name`),
                ...this._encryptedParams(description, `projects:${projectId}:description`),
                ...this._encryptedParams(instructions, `projects:${projectId}:instructions`),
                contextVersion,
                now,
                projectId,
            ]);
            return this._decodeProject(await this._get('SELECT * FROM projects WHERE id = ?', [projectId]));
        }));
    }

    async archiveProject(projectId) {
        return this._enqueue(async () => this._transaction(async () => {
            const project = await this._get('SELECT * FROM projects WHERE id = ?', [projectId]);
            if (!project) throw workspaceError('M365_PROJECT_NOT_FOUND', 'Project not found.');
            const activeRun = await this._get(`
                SELECT runs.id
                FROM runs
                JOIN conversations ON conversations.id = runs.conversation_id
                WHERE conversations.project_id = ?
                  AND runs.status NOT IN ('FAILED', 'CANCELED', 'COMPLETED')
                LIMIT 1
            `, [projectId]);
            if (activeRun) {
                throw workspaceError('M365_PROJECT_HAS_ACTIVE_RUN', 'Pause or finish active work before archiving this project.');
            }
            const now = this._now();
            await this._run("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?", [now, projectId]);
            await this._run("UPDATE conversations SET status = 'archived', updated_at = ? WHERE project_id = ?", [now, projectId]);
            return this._decodeProject(await this._get('SELECT * FROM projects WHERE id = ?', [projectId]));
        }));
    }

    async createConversation(projectId, input = {}) {
        const title = requireText(input.title || '新對話', 'title', 200);
        const id = this.idFactory();
        const now = this._now();
        return this._enqueue(async () => this._transaction(async () => {
            const project = await this._get('SELECT * FROM projects WHERE id = ?', [projectId]);
            if (!project) throw workspaceError('M365_PROJECT_NOT_FOUND', 'Project not found.');
            if (project.status !== 'active') {
                throw workspaceError('M365_PROJECT_ARCHIVED', 'Cannot add a conversation to an archived project.');
            }
            await this._run(`
                INSERT INTO conversations (
                    id, project_id,
                    title_ciphertext, title_iv, title_tag,
                    binding_state, status, project_context_version,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'unbound', 'active', ?, ?, ?)
            `, [
                id,
                projectId,
                ...this._encryptedParams(title, `conversations:${id}:title`),
                project.context_version,
                now,
                now,
            ]);
            await this._run('UPDATE projects SET updated_at = ? WHERE id = ?', [now, projectId]);
            return this._decodeConversation(await this._get('SELECT * FROM conversations WHERE id = ?', [id]));
        }));
    }

    async listConversations(projectId, options = {}) {
        const includeArchived = options.includeArchived === true;
        return this._enqueue(async () => {
            const project = await this._get('SELECT id FROM projects WHERE id = ?', [projectId]);
            if (!project) throw workspaceError('M365_PROJECT_NOT_FOUND', 'Project not found.');
            const rows = await this._all(`
                SELECT * FROM conversations
                WHERE project_id = ? ${includeArchived ? '' : "AND status = 'active'"}
                ORDER BY COALESCE(last_message_at, updated_at) DESC, id DESC
            `, [projectId]);
            return rows.map((row) => this._decodeConversation(row));
        });
    }

    async getConversation(conversationId) {
        return this._enqueue(async () => {
            const row = await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
            if (!row) throw workspaceError('M365_CONVERSATION_NOT_FOUND', 'Conversation not found.');
            return this._decodeConversation(row);
        });
    }

    async updateConversationTitle(conversationId, titleValue) {
        const title = requireText(titleValue, 'title', 200);
        return this._enqueue(async () => {
            const current = await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
            if (!current) throw workspaceError('M365_CONVERSATION_NOT_FOUND', 'Conversation not found.');
            if (current.status !== 'active') {
                throw workspaceError('M365_CONVERSATION_ARCHIVED', 'Archived conversations cannot be edited.');
            }
            const now = this._now();
            await this._run(`
                UPDATE conversations SET
                    title_ciphertext = ?, title_iv = ?, title_tag = ?, updated_at = ?
                WHERE id = ?
            `, [...this._encryptedParams(title, `conversations:${conversationId}:title`), now, conversationId]);
            return this._decodeConversation(await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]));
        });
    }

    async setConversationBinding(conversationId, binding = {}) {
        const bindingState = String(binding.bindingState || 'bound');
        if (!['unbound', 'bound', 'reconcile_required', 'broken'].includes(bindingState)) {
            throw workspaceError('M365_VALIDATION_ERROR', 'Invalid conversation binding state.');
        }
        const remoteUrl = optionalText(binding.remoteConversationUrl, 'remoteConversationUrl', 2048);
        const remoteId = optionalText(binding.remoteConversationId, 'remoteConversationId', 512);
        if (bindingState === 'bound' && (!remoteUrl || !remoteId)) {
            throw workspaceError('M365_VALIDATION_ERROR', 'A bound conversation requires a remote URL and conversation ID.');
        }

        return this._enqueue(async () => {
            const current = await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
            if (!current) throw workspaceError('M365_CONVERSATION_NOT_FOUND', 'Conversation not found.');
            const urlParts = remoteUrl
                ? this._encryptedParams(remoteUrl, `conversations:${conversationId}:remote_url`)
                : [null, null, null];
            const idParts = remoteId
                ? this._encryptedParams(remoteId, `conversations:${conversationId}:remote_conversation_id`)
                : [null, null, null];
            const now = this._now();
            await this._run(`
                UPDATE conversations SET
                    remote_url_ciphertext = ?, remote_url_iv = ?, remote_url_tag = ?,
                    remote_conversation_id_ciphertext = ?, remote_conversation_id_iv = ?, remote_conversation_id_tag = ?,
                    binding_state = ?, updated_at = ?
                WHERE id = ?
            `, [...urlParts, ...idParts, bindingState, now, conversationId]);
            return this._decodeConversation(await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]));
        });
    }

    async setConversationBindingState(conversationId, bindingStateValue) {
        const bindingState = String(bindingStateValue || '');
        if (!['unbound', 'bound', 'reconcile_required', 'broken'].includes(bindingState)) {
            throw workspaceError('M365_VALIDATION_ERROR', 'Invalid conversation binding state.');
        }
        return this._enqueue(async () => {
            const current = await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
            if (!current) throw workspaceError('M365_CONVERSATION_NOT_FOUND', 'Conversation not found.');
            if (bindingState === 'bound' && (!current.remote_url_ciphertext || !current.remote_conversation_id_ciphertext)) {
                throw workspaceError('M365_VALIDATION_ERROR', 'An unbound conversation cannot be marked bound without a remote locator.');
            }
            await this._run(
                'UPDATE conversations SET binding_state = ?, updated_at = ? WHERE id = ?',
                [bindingState, this._now(), conversationId]
            );
            return this._decodeConversation(await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]));
        });
    }

    async acknowledgeConversationProjectContext(conversationId, contextVersionValue) {
        const contextVersion = Math.max(1, Math.floor(Number(contextVersionValue) || 1));
        return this._enqueue(async () => {
            const current = await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
            if (!current) throw workspaceError('M365_CONVERSATION_NOT_FOUND', 'Conversation not found.');
            await this._run(
                'UPDATE conversations SET project_context_version = ?, updated_at = ? WHERE id = ?',
                [contextVersion, this._now(), conversationId]
            );
            return this._decodeConversation(await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]));
        });
    }

    async archiveConversation(conversationId) {
        return this._enqueue(async () => this._transaction(async () => {
            const current = await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
            if (!current) throw workspaceError('M365_CONVERSATION_NOT_FOUND', 'Conversation not found.');
            const activeRun = await this._get(`
                SELECT id FROM runs
                WHERE conversation_id = ? AND status NOT IN ('FAILED', 'CANCELED', 'COMPLETED')
                LIMIT 1
            `, [conversationId]);
            if (activeRun) {
                throw workspaceError('M365_CONVERSATION_HAS_ACTIVE_RUN', 'Pause or finish active work before archiving this conversation.');
            }
            const now = this._now();
            await this._run("UPDATE conversations SET status = 'archived', updated_at = ? WHERE id = ?", [now, conversationId]);
            return this._decodeConversation(await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]));
        }));
    }

    async addMessage(conversationId, input = {}) {
        const role = String(input.role || 'user');
        const source = String(input.source || (role === 'assistant' ? 'm365' : role));
        const deliveryState = String(input.deliveryState || 'local');
        if (!['user', 'assistant', 'system'].includes(role)) {
            throw workspaceError('M365_VALIDATION_ERROR', 'Invalid message role.');
        }
        if (!['user', 'm365', 'system'].includes(source)) {
            throw workspaceError('M365_VALIDATION_ERROR', 'Invalid message source.');
        }
        if (!['local', 'dispatch_started', 'confirmed', 'response_confirmed', 'ambiguous', 'failed'].includes(deliveryState)) {
            throw workspaceError('M365_VALIDATION_ERROR', 'Invalid message delivery state.');
        }
        const content = requireText(input.content, 'content', 200000);
        const id = this.idFactory();
        const now = this._now();
        return this._enqueue(async () => this._transaction(async () => {
            const conversation = await this._get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
            if (!conversation) throw workspaceError('M365_CONVERSATION_NOT_FOUND', 'Conversation not found.');
            if (conversation.status !== 'active') {
                throw workspaceError('M365_CONVERSATION_ARCHIVED', 'Cannot add messages to an archived conversation.');
            }
            await this._run(`
                INSERT INTO messages (
                    id, conversation_id, role, source,
                    content_ciphertext, content_iv, content_tag,
                    request_id, run_id, step_id, delivery_state, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                id,
                conversationId,
                role,
                source,
                ...this._encryptedParams(content, `messages:${id}:content`),
                input.requestId || null,
                input.runId || null,
                input.stepId || null,
                deliveryState,
                now,
            ]);
            await this._run(
                'UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?',
                [now, now, conversationId]
            );
            await this._run(
                'UPDATE projects SET updated_at = ? WHERE id = ?',
                [now, conversation.project_id]
            );
            return this._decodeMessage(await this._get('SELECT * FROM messages WHERE id = ?', [id]));
        }));
    }

    async updateMessageDeliveryState(messageId, deliveryState) {
        const state = String(deliveryState || '');
        if (!['local', 'dispatch_started', 'confirmed', 'response_confirmed', 'ambiguous', 'failed'].includes(state)) {
            throw workspaceError('M365_VALIDATION_ERROR', 'Invalid message delivery state.');
        }
        return this._enqueue(async () => {
            const result = await this._run('UPDATE messages SET delivery_state = ? WHERE id = ?', [state, messageId]);
            if (result.changes !== 1) throw workspaceError('M365_MESSAGE_NOT_FOUND', 'Message not found.');
            return this._decodeMessage(await this._get('SELECT * FROM messages WHERE id = ?', [messageId]));
        });
    }

    async listMessages(conversationId, options = {}) {
        const rawLimit = Number(options.limit || 200);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.floor(rawLimit), 1000)) : 200;
        return this._enqueue(async () => {
            const conversation = await this._get('SELECT id FROM conversations WHERE id = ?', [conversationId]);
            if (!conversation) throw workspaceError('M365_CONVERSATION_NOT_FOUND', 'Conversation not found.');
            const rows = await this._all(`
                SELECT * FROM (
                    SELECT * FROM messages
                    WHERE conversation_id = ?
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?
                ) ORDER BY created_at ASC, id ASC
            `, [conversationId, limit]);
            return rows.map((row) => this._decodeMessage(row));
        });
    }

    async createRun(conversationId, input = {}) {
        const objective = requireText(input.objective, 'objective', 20000);
        const constraints = optionalText(input.constraints, 'constraints', 20000);
        const verification = requireText(input.verification, 'verification', 20000);
        const rawMaxSteps = Number(input.maxSteps || 6);
        const maxSteps = Number.isFinite(rawMaxSteps) ? Math.max(1, Math.min(Math.floor(rawMaxSteps), 12)) : 6;
        const id = this.idFactory();
        const now = this._now();
        return this._enqueue(async () => this._transaction(async () => {
            const conversation = await this._get('SELECT status FROM conversations WHERE id = ?', [conversationId]);
            if (!conversation) throw workspaceError('M365_CONVERSATION_NOT_FOUND', 'Conversation not found.');
            if (conversation.status !== 'active') {
                throw workspaceError('M365_CONVERSATION_ARCHIVED', 'Cannot start work in an archived conversation.');
            }
            const activeRun = await this._get(`
                SELECT id FROM runs
                WHERE conversation_id = ?
                  AND status NOT IN ('FAILED', 'CANCELED', 'COMPLETED')
                LIMIT 1
            `, [conversationId]);
            if (activeRun) {
                throw workspaceError(
                    'M365_CONVERSATION_HAS_ACTIVE_RUN',
                    'Finish or cancel the active multi-step work before creating another one.'
                );
            }
            await this._run(`
                INSERT INTO runs (
                    id, conversation_id,
                    objective_ciphertext, objective_iv, objective_tag,
                    constraints_ciphertext, constraints_iv, constraints_tag,
                    verification_ciphertext, verification_iv, verification_tag,
                    status, max_steps, current_step, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'WAITING_START_APPROVAL', ?, 0, ?, ?)
            `, [
                id,
                conversationId,
                ...this._encryptedParams(objective, `runs:${id}:objective`),
                ...this._encryptedParams(constraints, `runs:${id}:constraints`),
                ...this._encryptedParams(verification, `runs:${id}:verification`),
                maxSteps,
                now,
                now,
            ]);
            await this._appendRunEventDirect(id, 'run_created', { maxSteps });
            await this._appendCheckpointDirect(id, null, {
                status: 'WAITING_START_APPROVAL',
                currentStep: 0,
                pendingApproval: 'run_start',
            });
            return this._decodeRun(await this._get('SELECT * FROM runs WHERE id = ?', [id]));
        }));
    }

    _decodeRun(row) {
        if (!row) return null;
        return {
            id: row.id,
            conversationId: row.conversation_id,
            objective: this._decrypt(row, 'objective', `runs:${row.id}:objective`),
            constraints: this._decrypt(row, 'constraints', `runs:${row.id}:constraints`),
            verification: this._decrypt(row, 'verification', `runs:${row.id}:verification`),
            status: row.status,
            maxSteps: row.max_steps,
            currentStep: row.current_step,
            errorCode: row.error_code,
            createdAt: row.created_at,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            updatedAt: row.updated_at,
        };
    }

    async getRun(runId) {
        return this._enqueue(async () => {
            const row = await this._get('SELECT * FROM runs WHERE id = ?', [runId]);
            if (!row) throw workspaceError('M365_RUN_NOT_FOUND', 'Run not found.');
            return this._decodeRun(row);
        });
    }

    async listRuns(conversationId) {
        return this._enqueue(async () => {
            const rows = await this._all(
                'SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, id DESC',
                [conversationId]
            );
            return rows.map((row) => this._decodeRun(row));
        });
    }

    async listRecoverableRuns() {
        return this._enqueue(async () => {
            const rows = await this._all(`
                SELECT * FROM runs
                WHERE status IN ('QUEUED', 'RUNNING')
                ORDER BY updated_at ASC, id ASC
            `);
            return rows.map((row) => this._decodeRun(row));
        });
    }

    async transitionRun(runId, nextStatus, options = {}) {
        const target = String(nextStatus || '').toUpperCase();
        if (!RUN_STATUSES.includes(target)) {
            throw workspaceError('M365_VALIDATION_ERROR', 'Invalid run status.');
        }
        return this._enqueue(async () => this._transaction(async () => {
            const current = await this._get('SELECT * FROM runs WHERE id = ?', [runId]);
            if (!current) throw workspaceError('M365_RUN_NOT_FOUND', 'Run not found.');
            if (current.status !== target && !RUN_TRANSITIONS[current.status]?.has(target)) {
                throw workspaceError(
                    'M365_RUN_TRANSITION_INVALID',
                    `Run cannot transition from ${current.status} to ${target}.`
                );
            }
            const now = this._now();
            const startedAt = current.started_at || (target === 'RUNNING' ? now : null);
            const completedAt = ['FAILED', 'CANCELED', 'COMPLETED'].includes(target) ? now : null;
            const currentStep = options.currentStep === undefined
                ? current.current_step
                : Math.max(0, Math.floor(Number(options.currentStep) || 0));
            await this._run(`
                UPDATE runs SET status = ?, current_step = ?, error_code = ?,
                    started_at = ?, completed_at = ?, updated_at = ?
                WHERE id = ?
            `, [
                target,
                currentStep,
                options.errorCode || null,
                startedAt,
                completedAt,
                now,
                runId,
            ]);
            await this._appendRunEventDirect(runId, 'run_status_changed', {
                from: current.status,
                to: target,
                currentStep,
                errorCode: options.errorCode || null,
                reason: options.reason || '',
            });
            await this._appendCheckpointDirect(runId, options.stepId || null, {
                status: target,
                currentStep,
                errorCode: options.errorCode || null,
                reason: options.reason || '',
            });
            return this._decodeRun(await this._get('SELECT * FROM runs WHERE id = ?', [runId]));
        }));
    }

    async createRunStep(runId, input = {}) {
        const prompt = requireText(input.prompt, 'prompt', 200000);
        const summary = optionalText(input.summary, 'summary', 20000);
        const id = this.idFactory();
        const requestId = String(input.requestId || this.idFactory());
        const now = this._now();
        return this._enqueue(async () => this._transaction(async () => {
            const run = await this._get('SELECT * FROM runs WHERE id = ?', [runId]);
            if (!run) throw workspaceError('M365_RUN_NOT_FOUND', 'Run not found.');
            const stepNumber = input.stepNumber === undefined
                ? run.current_step + 1
                : Math.max(1, Math.floor(Number(input.stepNumber) || 1));
            if (stepNumber > run.max_steps) {
                throw workspaceError('M365_RUN_STEP_LIMIT', 'Run has reached its maximum step count.');
            }
            await this._run(`
                INSERT INTO run_steps (
                    id, run_id, step_number, status,
                    prompt_ciphertext, prompt_iv, prompt_tag,
                    summary_ciphertext, summary_iv, summary_tag,
                    request_id, created_at, updated_at
                ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                id,
                runId,
                stepNumber,
                ...this._encryptedParams(prompt, `run_steps:${id}:prompt`),
                ...this._encryptedParams(summary, `run_steps:${id}:summary`),
                requestId,
                now,
                now,
            ]);
            await this._appendRunEventDirect(runId, 'step_created', { stepId: id, stepNumber, requestId });
            await this._appendCheckpointDirect(runId, id, {
                status: run.status,
                currentStep: run.current_step,
                pendingStep: stepNumber,
                requestId,
            });
            return this._decodeRunStep(await this._get('SELECT * FROM run_steps WHERE id = ?', [id]));
        }));
    }

    _decodeRunStep(row) {
        if (!row) return null;
        return {
            id: row.id,
            runId: row.run_id,
            stepNumber: row.step_number,
            status: row.status,
            prompt: this._decrypt(row, 'prompt', `run_steps:${row.id}:prompt`),
            summary: this._decrypt(row, 'summary', `run_steps:${row.id}:summary`),
            requestId: row.request_id,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    async updateRunStep(stepId, changes = {}) {
        const status = String(changes.status || '').toLowerCase();
        if (!['queued', 'running', 'waiting', 'reconcile_required', 'failed', 'completed', 'canceled'].includes(status)) {
            throw workspaceError('M365_VALIDATION_ERROR', 'Invalid run step status.');
        }
        return this._enqueue(async () => this._transaction(async () => {
            const step = await this._get('SELECT * FROM run_steps WHERE id = ?', [stepId]);
            if (!step) throw workspaceError('M365_RUN_STEP_NOT_FOUND', 'Run step not found.');
            const summary = changes.summary === undefined
                ? this._decrypt(step, 'summary', `run_steps:${stepId}:summary`)
                : optionalText(changes.summary, 'summary', 20000);
            const now = this._now();
            const startedAt = step.started_at || (status === 'running' ? now : null);
            const completedAt = ['failed', 'completed', 'canceled'].includes(status) ? now : null;
            await this._run(`
                UPDATE run_steps SET status = ?, summary_ciphertext = ?, summary_iv = ?, summary_tag = ?,
                    started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?
            `, [
                status,
                ...this._encryptedParams(summary, `run_steps:${stepId}:summary`),
                startedAt,
                completedAt,
                now,
                stepId,
            ]);
            await this._appendRunEventDirect(step.run_id, 'step_status_changed', {
                stepId,
                stepNumber: step.step_number,
                from: step.status,
                to: status,
            });
            await this._appendCheckpointDirect(step.run_id, stepId, {
                stepNumber: step.step_number,
                stepStatus: status,
            });
            return this._decodeRunStep(await this._get('SELECT * FROM run_steps WHERE id = ?', [stepId]));
        }));
    }

    async listRunSteps(runId) {
        return this._enqueue(async () => {
            const rows = await this._all(
                'SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_number ASC',
                [runId]
            );
            return rows.map((row) => this._decodeRunStep(row));
        });
    }

    async _appendRunEventDirect(runId, eventType, payload) {
        const aad = `run_events:${runId}:${eventType}:${this._now()}:${crypto.randomBytes(8).toString('hex')}`;
        const encrypted = this._encrypt(JSON.stringify(payload || {}), aad);
        await this._run(`
            INSERT INTO run_events (
                run_id, event_type, payload_ciphertext, payload_iv, payload_tag, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
        `, [runId, `${eventType}|${Buffer.from(aad).toString('base64')}`, encrypted.ciphertext, encrypted.iv, encrypted.tag, this._now()]);
    }

    async appendRunEvent(runId, eventType, payload = {}) {
        const safeEventType = requireText(eventType, 'eventType', 120);
        return this._enqueue(async () => {
            const run = await this._get('SELECT id FROM runs WHERE id = ?', [runId]);
            if (!run) throw workspaceError('M365_RUN_NOT_FOUND', 'Run not found.');
            await this._appendRunEventDirect(runId, safeEventType, payload);
            return true;
        });
    }

    async _appendCheckpointDirect(runId, stepId, state) {
        const row = await this._get('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM checkpoints WHERE run_id = ?', [runId]);
        const sequence = Number(row?.sequence || 0) + 1;
        const id = this.idFactory();
        const encrypted = this._encrypt(JSON.stringify(state || {}), `checkpoints:${id}:state`);
        await this._run(`
            INSERT INTO checkpoints (
                id, run_id, step_id, sequence, state_ciphertext, state_iv, state_tag, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, runId, stepId, sequence, encrypted.ciphertext, encrypted.iv, encrypted.tag, this._now()]);
    }

    async listRunEvents(runId) {
        return this._enqueue(async () => {
            const rows = await this._all('SELECT * FROM run_events WHERE run_id = ? ORDER BY id ASC', [runId]);
            return rows.map((row) => {
                const [eventType, aadEncoded] = String(row.event_type || '').split('|');
                const aad = Buffer.from(aadEncoded || '', 'base64').toString('utf8');
                const payload = this._decrypt({
                    id: row.id,
                    payload_ciphertext: row.payload_ciphertext,
                    payload_iv: row.payload_iv,
                    payload_tag: row.payload_tag,
                }, 'payload', aad);
                return {
                    id: row.id,
                    runId: row.run_id,
                    eventType,
                    payload: JSON.parse(payload || '{}'),
                    createdAt: row.created_at,
                };
            });
        });
    }

    async getLatestCheckpoint(runId) {
        return this._enqueue(async () => {
            const row = await this._get(
                'SELECT * FROM checkpoints WHERE run_id = ? ORDER BY sequence DESC LIMIT 1',
                [runId]
            );
            if (!row) return null;
            const state = this._decrypt(row, 'state', `checkpoints:${row.id}:state`);
            return {
                id: row.id,
                runId: row.run_id,
                stepId: row.step_id,
                sequence: row.sequence,
                state: JSON.parse(state || '{}'),
                createdAt: row.created_at,
            };
        });
    }

    async createApproval(runId, input = {}) {
        const approvalType = requireText(input.approvalType, 'approvalType', 120);
        const request = requireText(input.request, 'request', 20000);
        const id = this.idFactory();
        const now = this._now();
        return this._enqueue(async () => this._transaction(async () => {
            const run = await this._get('SELECT id FROM runs WHERE id = ?', [runId]);
            if (!run) throw workspaceError('M365_RUN_NOT_FOUND', 'Run not found.');
            await this._run(`
                INSERT INTO approvals (
                    id, run_id, step_id, approval_type,
                    request_ciphertext, request_iv, request_tag,
                    decision_ciphertext, decision_iv, decision_tag,
                    status, requested_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            `, [
                id,
                runId,
                input.stepId || null,
                approvalType,
                ...this._encryptedParams(request, `approvals:${id}:request`),
                ...this._encryptedParams('', `approvals:${id}:decision`),
                now,
            ]);
            await this._appendRunEventDirect(runId, 'approval_requested', {
                approvalId: id,
                approvalType,
                stepId: input.stepId || null,
            });
            return this._decodeApproval(await this._get('SELECT * FROM approvals WHERE id = ?', [id]));
        }));
    }

    _decodeApproval(row) {
        if (!row) return null;
        return {
            id: row.id,
            runId: row.run_id,
            stepId: row.step_id,
            approvalType: row.approval_type,
            request: this._decrypt(row, 'request', `approvals:${row.id}:request`),
            decision: this._decrypt(row, 'decision', `approvals:${row.id}:decision`),
            status: row.status,
            requestedAt: row.requested_at,
            decidedAt: row.decided_at,
        };
    }

    async decideApproval(approvalId, input = {}) {
        const status = String(input.status || '').toLowerCase();
        if (!['approved', 'denied', 'canceled'].includes(status)) {
            throw workspaceError('M365_VALIDATION_ERROR', 'Approval decision must be approved, denied, or canceled.');
        }
        const decision = optionalText(input.decision, 'decision', 20000);
        return this._enqueue(async () => this._transaction(async () => {
            const approval = await this._get('SELECT * FROM approvals WHERE id = ?', [approvalId]);
            if (!approval) throw workspaceError('M365_APPROVAL_NOT_FOUND', 'Approval request not found.');
            if (approval.status !== 'pending') {
                throw workspaceError('M365_APPROVAL_ALREADY_DECIDED', 'Approval request has already been decided.');
            }
            const now = this._now();
            await this._run(`
                UPDATE approvals SET
                    decision_ciphertext = ?, decision_iv = ?, decision_tag = ?,
                    status = ?, decided_at = ?
                WHERE id = ?
            `, [
                ...this._encryptedParams(decision, `approvals:${approvalId}:decision`),
                status,
                now,
                approvalId,
            ]);
            await this._appendRunEventDirect(approval.run_id, 'approval_decided', {
                approvalId,
                status,
                stepId: approval.step_id,
            });
            return this._decodeApproval(await this._get('SELECT * FROM approvals WHERE id = ?', [approvalId]));
        }));
    }

    async listApprovals(runId) {
        return this._enqueue(async () => {
            const rows = await this._all(
                'SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at ASC, id ASC',
                [runId]
            );
            return rows.map((row) => this._decodeApproval(row));
        });
    }

    async close() {
        return this._enqueue(async () => {
            if (!this.db) return;
            const db = this.db;
            this.db = null;
            this._initPromise = null;
            await new Promise((resolve, reject) => {
                db.close((error) => (error ? reject(error) : resolve()));
            });
        });
    }
}

module.exports = M365WorkspaceStore;
module.exports.RUN_STATUSES = RUN_STATUSES;
module.exports.RUN_TRANSITIONS = RUN_TRANSITIONS;
module.exports.parseEncryptionKey = parseEncryptionKey;
module.exports.workspaceError = workspaceError;
