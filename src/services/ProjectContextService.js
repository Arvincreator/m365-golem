const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_IGNORE_DIRS = new Set([
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.next',
    '.turbo',
    '.cache',
    'tmp',
    'logs',
    'golem_memory',
]);

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip',
    '.gz', '.tar', '.7z', '.rar', '.mp3', '.mp4', '.mov', '.avi', '.woff',
    '.woff2', '.ttf', '.otf', '.eot', '.db', '.sqlite', '.sqlite3', '.bin',
    '.pyc', '.class', '.jar', '.dylib', '.so', '.dll',
]);

class ProjectContextService {
    constructor(options = {}) {
        this.defaultMaxFiles = options.defaultMaxFiles || 5000;
        this.defaultMaxFileChars = options.defaultMaxFileChars || 6000;
        this.defaultMaxChunkChars = options.defaultMaxChunkChars || 12000;
        this.defaultReadTopFiles = options.defaultReadTopFiles || 120;
        this.defaultReadConcurrency = options.defaultReadConcurrency || 12;
        this.defaultIgnoreDirs = new Set([
            ...DEFAULT_IGNORE_DIRS,
            ...(options.ignoreDirs || []),
        ]);
    }

    _isLikelyBinary(filePath) {
        return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    }

    _walkFiles(rootDir, opts = {}) {
        const ignoreDirs = new Set([
            ...this.defaultIgnoreDirs,
            ...((opts.ignoreDirs || []).map(x => String(x))),
        ]);
        const maxFiles = Number(opts.maxFiles || this.defaultMaxFiles);
        const collected = [];

        const stack = [rootDir];
        while (stack.length > 0 && collected.length < maxFiles) {
            const current = stack.pop();
            let entries = [];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch (_) {
                continue;
            }

            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (!ignoreDirs.has(entry.name)) {
                        stack.push(fullPath);
                    }
                    continue;
                }
                if (!entry.isFile()) continue;
                if (this._isLikelyBinary(fullPath)) continue;
                collected.push(fullPath);
                if (collected.length >= maxFiles) break;
            }
        }

        collected.sort();
        return collected;
    }

    _indexWithRipgrep(rootDir, opts = {}) {
        const maxFiles = Number(opts.maxFiles || this.defaultMaxFiles);
        const ignoreDirs = new Set([
            ...this.defaultIgnoreDirs,
            ...((opts.ignoreDirs || []).map(x => String(x))),
        ]);
        const args = ['--files'];
        for (const name of ignoreDirs) {
            args.push('-g', `!${name}/**`);
        }

        const out = spawnSync('rg', args, {
            cwd: rootDir,
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
        });
        if (out.error || out.status !== 0) return null;

        const lines = String(out.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
        const files = [];
        for (const rel of lines) {
            const fullPath = path.join(rootDir, rel);
            if (this._isLikelyBinary(fullPath)) continue;
            files.push(fullPath);
            if (files.length >= maxFiles) break;
        }
        return files;
    }

    _safeStat(filePath) {
        try {
            return fs.statSync(filePath);
        } catch (_) {
            return null;
        }
    }

    _tokenizeQuery(query) {
        return String(query || '')
            .toLowerCase()
            .split(/[^a-z0-9_\-./]+/i)
            .map(x => x.trim())
            .filter(Boolean);
    }

    _scoreFile(meta, queryTokens) {
        const rel = meta.relativePath.toLowerCase();
        let score = 0;

        // Core modules receive a baseline boost.
        if (rel.startsWith('src/core/')) score += 80;
        else if (rel.startsWith('src/services/')) score += 55;
        else if (rel.startsWith('src/managers/')) score += 50;
        else if (rel.startsWith('web-dashboard/routes/')) score += 45;
        else if (rel.startsWith('src/')) score += 35;
        else if (rel.startsWith('tests/')) score += 15;

        const ext = path.extname(rel);
        if (ext === '.js' || ext === '.ts' || ext === '.tsx') score += 18;
        else if (ext === '.json') score += 8;
        else if (ext === '.md') score += 5;

        // Prefer mid-size files (too huge or too tiny are less useful at first pass).
        if (meta.size > 0 && meta.size < 200000) score += 10;
        if (meta.size > 400000) score -= 12;

        for (const tk of queryTokens) {
            if (!tk) continue;
            if (rel.includes(tk)) score += 25;
            const baseName = path.basename(rel);
            if (baseName.includes(tk)) score += 10;
        }

        return score;
    }

    async _mapLimit(items, limit, worker) {
        const concurrency = Math.max(1, Number(limit) || 1);
        const results = new Array(items.length);
        let cursor = 0;

        const runOne = async () => {
            while (true) {
                const idx = cursor++;
                if (idx >= items.length) return;
                results[idx] = await worker(items[idx], idx);
            }
        };

        const workers = [];
        for (let i = 0; i < Math.min(concurrency, items.length); i++) {
            workers.push(runOne());
        }
        await Promise.all(workers);
        return results;
    }

    _readTextFile(filePath, maxChars) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n...<TRUNCATED>` : raw;
        } catch (e) {
            return `<<READ_ERROR: ${e.message}>>`;
        }
    }

    _buildChunks(fileEntries, maxChunkChars) {
        const chunks = [];
        let current = '';
        let currentCount = 0;

        const flush = () => {
            if (!current.trim()) return;
            chunks.push({
                index: chunks.length + 1,
                text: current.trim(),
                files: currentCount,
            });
            current = '';
            currentCount = 0;
        };

        for (const entry of fileEntries) {
            const block = [
                `### FILE: ${entry.relativePath}`,
                '```text',
                entry.content,
                '```',
                '',
            ].join('\n');

            if (current.length + block.length > maxChunkChars && current.length > 0) {
                flush();
            }
            current += block;
            currentCount += 1;
        }
        flush();
        return chunks;
    }

    async createProjectChunks(projectPath, options = {}) {
        const rootDir = path.resolve(projectPath || process.cwd());
        const maxFileChars = Number(options.maxFileChars || this.defaultMaxFileChars);
        const maxChunkChars = Number(options.maxChunkChars || this.defaultMaxChunkChars);
        const readTopFiles = Number(options.readTopFiles || this.defaultReadTopFiles);
        const readConcurrency = Number(options.readConcurrency || this.defaultReadConcurrency);
        const queryTokens = this._tokenizeQuery(options.query || '');

        const indexedFiles = this._indexWithRipgrep(rootDir, options) || this._walkFiles(rootDir, options);
        const metas = indexedFiles
            .map(filePath => {
                const st = this._safeStat(filePath);
                if (!st || !st.isFile()) return null;
                return {
                    absolutePath: filePath,
                    relativePath: path.relative(rootDir, filePath),
                    size: st.size,
                    mtimeMs: st.mtimeMs,
                };
            })
            .filter(Boolean);

        const ranked = metas
            .map(meta => ({ ...meta, score: this._scoreFile(meta, queryTokens) }))
            .sort((a, b) => b.score - a.score);

        const selected = ranked.slice(0, Math.max(1, readTopFiles));

        if (options.scanOnly) {
            return {
                summary: {
                    rootDir,
                    indexedFileCount: metas.length,
                    selectedFileCount: selected.length,
                    chunkCount: 0,
                    maxFileChars,
                    maxChunkChars,
                    readTopFiles,
                    queryTokens,
                    generatedAt: new Date().toISOString(),
                },
                chunks: [],
            };
        }

        const entries = await this._mapLimit(selected, readConcurrency, async (meta) => ({
            absolutePath: meta.absolutePath,
            relativePath: meta.relativePath,
            score: meta.score,
            content: this._readTextFile(meta.absolutePath, maxFileChars),
        }));

        const chunks = this._buildChunks(entries, maxChunkChars);
        const summary = {
            rootDir,
            indexedFileCount: metas.length,
            selectedFileCount: entries.length,
            chunkCount: chunks.length,
            maxFileChars,
            maxChunkChars,
            readTopFiles,
            readConcurrency,
            queryTokens,
            generatedAt: new Date().toISOString(),
        };

        return { summary, chunks };
    }
}

module.exports = ProjectContextService;
