const fs = require('fs');
const path = require('path');

const PROMPT_POOL_PATH = path.resolve(process.cwd(), 'data', 'dashboard', 'prompt-pool.json');
let cache = {
    mtimeMs: -1,
    items: [],
};

function normalizeShortcut(raw) {
    return String(raw || '').trim();
}

function normalizePrompt(raw) {
    return String(raw || '').trim();
}

function toShortcutKey(raw) {
    const shortcut = String(raw || '').trim().toLowerCase();
    if (!shortcut) return '';
    return shortcut.replace(/^\/+/, '');
}

function loadSystemCommandSet() {
    try {
        const ConfigManager = require('../config');
        const commands = ConfigManager.CONFIG.GOLEM_BACKEND === 'm365-web'
            ? require('../config/m365Commands.js')
            : require('../config/commands.js');
        if (!Array.isArray(commands)) return new Set();
        return new Set(
            commands
                .map((item) => toShortcutKey(item && item.command ? item.command : ''))
                .filter(Boolean)
        );
    } catch {
        return new Set();
    }
}

function readPromptPoolItems() {
    let stat;
    try {
        stat = fs.statSync(PROMPT_POOL_PATH);
    } catch {
        cache = { mtimeMs: -1, items: [] };
        return [];
    }

    if (stat.isFile() && stat.mtimeMs === cache.mtimeMs) {
        return cache.items;
    }

    const reserved = loadSystemCommandSet();
    try {
        const raw = fs.readFileSync(PROMPT_POOL_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            cache = { mtimeMs: stat.mtimeMs, items: [] };
            return [];
        }

        const seen = new Set();
        const items = [];
        for (const entry of parsed) {
            const shortcut = normalizeShortcut(entry && entry.shortcut);
            const prompt = normalizePrompt(entry && entry.prompt);
            if (!shortcut || !prompt) continue;
            if (/\s/.test(shortcut)) continue;

            const shortcutKey = toShortcutKey(shortcut);
            if (!shortcutKey) continue;
            if (reserved.has(shortcutKey)) continue;
            if (seen.has(shortcutKey)) continue;
            seen.add(shortcutKey);

            items.push({
                id: String(entry && entry.id ? entry.id : `shortcut_${items.length + 1}`),
                shortcut,
                shortcutKey,
                prompt,
                note: String(entry && entry.note ? entry.note : '').trim(),
            });
        }

        cache = {
            mtimeMs: stat.mtimeMs,
            items,
        };
        return items;
    } catch {
        cache = { mtimeMs: stat.mtimeMs, items: [] };
        return [];
    }
}

function expandPromptShortcutInput(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
        return { changed: false, text: '', matched: null };
    }

    const parts = text.split(/\s+/);
    const headRaw = String(parts[0] || '').trim();
    if (!headRaw.startsWith('/')) {
        return { changed: false, text, matched: null };
    }

    const headKey = toShortcutKey(headRaw);
    if (!headKey) {
        return { changed: false, text, matched: null };
    }

    const items = readPromptPoolItems();
    const matched = items.find((item) => item.shortcutKey === headKey);
    if (!matched) {
        return { changed: false, text, matched: null };
    }

    const rest = parts.slice(1).join(' ').trim();
    const expanded = rest ? `${matched.prompt}\n${rest}` : matched.prompt;
    return {
        changed: true,
        text: expanded,
        matched,
    };
}

function scoreShortcutCandidate(shortcutKey, queryKey) {
    if (!shortcutKey || !queryKey) return 0;
    if (shortcutKey === queryKey) return 1000;
    if (shortcutKey.startsWith(queryKey)) return 800 - Math.max(0, shortcutKey.length - queryKey.length);
    const includeIndex = shortcutKey.indexOf(queryKey);
    if (includeIndex >= 0) return 500 - includeIndex;
    if (queryKey.startsWith(shortcutKey)) return 300 - Math.max(0, queryKey.length - shortcutKey.length);
    return 0;
}

function suggestPromptShortcuts(rawText, limit = 5) {
    const text = String(rawText || '').trim();
    if (!text) return [];

    const parts = text.split(/\s+/);
    const headRaw = String(parts[0] || '').trim();
    if (!headRaw.startsWith('/')) return [];

    const queryKey = toShortcutKey(headRaw);
    if (!queryKey) return [];

    const max = Math.max(1, Math.min(Number(limit) || 5, 20));
    const scored = readPromptPoolItems()
        .map((item) => ({
            ...item,
            _score: scoreShortcutCandidate(item.shortcutKey, queryKey),
        }))
        .filter((item) => item._score > 0)
        .sort((a, b) => {
            if (b._score !== a._score) return b._score - a._score;
            return String(a.shortcut).localeCompare(String(b.shortcut));
        })
        .slice(0, max)
        .map((item) => ({
            id: item.id,
            shortcut: item.shortcut,
            prompt: item.prompt,
            note: item.note,
            shortcutKey: item.shortcutKey,
        }));

    return scored;
}

const normalizeShortcutKey = toShortcutKey;

module.exports = {
    PROMPT_POOL_PATH,
    readPromptPoolItems,
    expandPromptShortcutInput,
    suggestPromptShortcuts,
    normalizeShortcutKey,
};
