'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const TABLE_NAME = 'project_rules';

function hashRule(rule) {
    const text = [
        rule.id,
        rule.kind,
        rule.content,
        ...(Array.isArray(rule.tags) ? rule.tags : []),
    ].filter(Boolean).join(' | ');
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
}

function quoteSql(value) {
    return `'${String(value || '').replace(/'/g, "''")}'`;
}

class ProjectRuleVectorIndex {
    constructor(projectRoot, embedder) {
        this.projectRoot = path.resolve(projectRoot);
        this.indexDir = path.join(this.projectRoot, '.golem', 'project-memory-index');
        this.metaPath = path.join(this.indexDir, 'meta.json');
        this.embedder = embedder;
        this._db = null;
        this._table = null;
        this._meta = null;
        this._initPromise = null;
        this._syncPromise = null;
    }

    async init() {
        if (!this.embedder || typeof this.embedder.embedQuery !== 'function') {
            throw new Error('Project memory vector index requires a local embedder.');
        }
        if (this._initPromise) return this._initPromise;
        this._initPromise = this._doInit().catch((error) => {
            this._initPromise = null;
            throw error;
        });
        return this._initPromise;
    }

    async _doInit() {
        fs.mkdirSync(this.indexDir, { recursive: true });
        this._meta = this._loadMeta();
        const { createJiti } = require('jiti');
        const jiti = createJiti(__filename);
        const lancedb = await jiti.import('@lancedb/lancedb');
        this._db = await lancedb.connect(path.join(this.indexDir, 'lancedb'));
        const names = await this._db.tableNames();
        this._table = names.includes(TABLE_NAME)
            ? await this._db.openTable(TABLE_NAME)
            : null;
    }

    async sync(rules) {
        const snapshot = Array.isArray(rules) ? rules.map((rule) => ({ ...rule })) : [];
        if (this._syncPromise) {
            return this._syncPromise.then(() => this.sync(snapshot));
        }
        this._syncPromise = this._sync(snapshot).finally(() => {
            this._syncPromise = null;
        });
        return this._syncPromise;
    }

    async _sync(rules) {
        const currentRules = Array.isArray(rules) ? rules.filter((rule) => rule && rule.id) : [];
        await this.init();

        const currentIds = new Set(currentRules.map((rule) => String(rule.id)));
        const staleIds = Object.keys(this._meta.hashes).filter((id) => !currentIds.has(id));
        const changed = currentRules.filter((rule) => this._meta.hashes[rule.id] !== hashRule(rule));

        try {
            if (this._table && staleIds.length > 0) {
                await this._table.delete(`id IN (${staleIds.map(quoteSql).join(',')})`);
                staleIds.forEach((id) => delete this._meta.hashes[id]);
            }

            const rows = [];
            for (const rule of changed) {
                const vector = await this.embedder.embedQuery([
                    rule.kind,
                    rule.content,
                    ...(Array.isArray(rule.tags) ? rule.tags : []),
                ].filter(Boolean).join(' | '));
                rows.push({
                    id: String(rule.id),
                    kind: String(rule.kind || 'context'),
                    content: String(rule.content || ''),
                    tags: JSON.stringify(rule.tags || []),
                    updatedAt: String(rule.updatedAt || ''),
                    entryHash: hashRule(rule),
                    vector,
                });
            }

            if (rows.length > 0) {
                if (!this._table) {
                    this._table = await this._db.createTable(TABLE_NAME, rows);
                } else {
                    await this._table.delete(`id IN (${rows.map((row) => quoteSql(row.id)).join(',')})`);
                    await this._table.add(rows);
                }
                rows.forEach((row) => { this._meta.hashes[row.id] = row.entryHash; });
            }
            this._saveMeta();
        } catch (error) {
            await this._rebuild(currentRules);
            console.warn(`[ProjectRuleVectorIndex] Incremental sync failed; rebuilt index: ${error.message}`);
        }
    }

    async _rebuild(rules) {
        const rows = [];
        for (const rule of rules) {
            const vector = await this.embedder.embedQuery([
                rule.kind,
                rule.content,
                ...(Array.isArray(rule.tags) ? rule.tags : []),
            ].filter(Boolean).join(' | '));
            rows.push({
                id: String(rule.id),
                kind: String(rule.kind || 'context'),
                content: String(rule.content || ''),
                tags: JSON.stringify(rule.tags || []),
                updatedAt: String(rule.updatedAt || ''),
                entryHash: hashRule(rule),
                vector,
            });
        }

        const names = await this._db.tableNames();
        if (names.includes(TABLE_NAME)) await this._db.dropTable(TABLE_NAME);
        this._table = rows.length > 0 ? await this._db.createTable(TABLE_NAME, rows) : null;
        this._meta = {
            version: SCHEMA_VERSION,
            hashes: Object.fromEntries(rows.map((row) => [row.id, row.entryHash])),
        };
        this._saveMeta();
    }

    async search(query, options = {}) {
        const text = String(query || '').trim();
        if (!text) return [];
        await this.init();
        if (!this._table) return [];
        const vector = await this.embedder.embedQuery(text);
        const rows = await this._table.vectorSearch(vector)
            .limit(Math.max(1, Number(options.limit || 8)))
            .toArray();
        return rows.map((row) => ({
            id: String(row.id),
            score: row._distance === undefined ? 0.5 : 1 - Number(row._distance),
        }));
    }

    _loadMeta() {
        try {
            if (fs.existsSync(this.metaPath)) {
                const parsed = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
                if (parsed && parsed.version === SCHEMA_VERSION && parsed.hashes) return parsed;
            }
        } catch (_) {}
        return { version: SCHEMA_VERSION, hashes: {} };
    }

    _saveMeta() {
        fs.writeFileSync(this.metaPath, `${JSON.stringify(this._meta, null, 2)}\n`, 'utf8');
    }
}

module.exports = ProjectRuleVectorIndex;
module.exports.hashRule = hashRule;
