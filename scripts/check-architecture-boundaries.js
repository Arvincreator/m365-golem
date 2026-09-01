#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['apps', 'src', 'packages', 'web-dashboard/routes', 'web-dashboard/server', 'scripts'];
const CODE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const IGNORE_DIRS = new Set(['node_modules', '.git', '.next', 'out', 'coverage']);

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_RE = /\bimport\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g;

function listFiles(dirPath, out) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const abs = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            listFiles(abs, out);
        } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) {
            out.push(abs);
        }
    }
}

function categoryForRelativePath(relPath) {
    const normalized = relPath.split(path.sep).join('/');
    const [head, second] = normalized.split('/');
    if (head === 'apps') return { layer: 'apps', scope: second || '' };
    if (head === 'src') return { layer: 'src', scope: second || '' };
    if (head === 'packages') return { layer: 'packages', scope: second || '' };
    if (head === 'web-dashboard') return { layer: 'web-dashboard', scope: second || '' };
    return { layer: 'other', scope: '' };
}

function getLineNumber(content, index) {
    let line = 1;
    for (let i = 0; i < index; i += 1) {
        if (content.charCodeAt(i) === 10) line += 1;
    }
    return line;
}

function* extractSpecs(content) {
    let match;
    while ((match = REQUIRE_RE.exec(content)) !== null) {
        yield { spec: match[1], index: match.index };
    }
    while ((match = IMPORT_RE.exec(content)) !== null) {
        yield { spec: match[1], index: match.index };
    }
}

function resolveTarget(fromFileAbs, spec) {
    if (spec.startsWith('.')) {
        return path.resolve(path.dirname(fromFileAbs), spec);
    }
    if (spec.startsWith('/')) {
        return path.resolve(spec);
    }
    return null;
}

function checkViolations() {
    const files = [];
    for (const relRoot of SCAN_ROOTS) {
        listFiles(path.join(ROOT, relRoot), files);
    }

    const violations = [];

    for (const fileAbs of files) {
        const fileRel = path.relative(ROOT, fileAbs);
        const from = categoryForRelativePath(fileRel);
        if (from.layer === 'other') continue;

        const content = fs.readFileSync(fileAbs, 'utf8');
        for (const ref of extractSpecs(content)) {
            const targetAbs = resolveTarget(fileAbs, ref.spec);
            if (!targetAbs) continue;

            const targetRel = path.relative(ROOT, targetAbs);
            if (targetRel.startsWith('..')) continue;

            const to = categoryForRelativePath(targetRel);
            if (to.layer === 'other') continue;

            const line = getLineNumber(content, ref.index);

            if (from.layer === 'src' && to.layer === 'apps') {
                violations.push({
                    file: fileRel,
                    line,
                    reason: 'src must not depend on apps',
                    importPath: ref.spec
                });
            }

            if (from.layer === 'packages' && to.layer === 'apps') {
                violations.push({
                    file: fileRel,
                    line,
                    reason: 'packages must not depend on apps',
                    importPath: ref.spec
                });
            }

            if (
                from.layer === 'packages' &&
                to.layer === 'packages' &&
                from.scope &&
                to.scope &&
                from.scope !== to.scope
            ) {
                violations.push({
                    file: fileRel,
                    line,
                    reason: `cross-package dependency is not allowed (${from.scope} -> ${to.scope})`,
                    importPath: ref.spec
                });
            }
        }
    }

    return violations;
}

function main() {
    const violations = checkViolations();
    if (violations.length === 0) {
        console.log('✅ Architecture boundary check passed.');
        process.exit(0);
    }

    console.error(`❌ Architecture boundary check failed (${violations.length} violation(s))`);
    for (const v of violations) {
        console.error(`- ${v.file}:${v.line} | ${v.reason} | import: ${v.importPath}`);
    }
    process.exit(1);
}

main();
