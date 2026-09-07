'use strict';
const fs = require('fs');
const crypto = require('crypto');
const manifest = JSON.parse(fs.readFileSync('docs/ux-rebuild/protected-files.json', 'utf8').replace(/^\uFEFF/, ''));
const changed = Object.entries(manifest).filter(([file, expected]) => !fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected).map(([file]) => file);
if (changed.length) { console.error('Protected working-copy baseline changed:', changed); process.exitCode = 1; }
else console.log(`PASS: ${Object.keys(manifest).length} protected files match the pre-UX working copy (SHA-256).`);
