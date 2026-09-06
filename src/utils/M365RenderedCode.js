'use strict';

const RENDERED_CODE_LABELS = new Set([
    'json',
    'show more lines',
    '顯示更多行',
    '显示更多行',
]);

function nonEmptyLines(value) {
    return String(value || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function isRenderedCodeChrome(value) {
    return nonEmptyLines(value).every((line) => (
        /^\d+$/.test(line)
        // M365 occasionally leaves an incomplete Markdown closing fence as a
        // visible second code line (for example ``) before its "show more"
        // control. It is renderer/fence chrome only when it is outside the
        // already balanced JSON payload.
        || /^`{1,3}$/.test(line)
        || RENDERED_CODE_LABELS.has(line.toLowerCase())
    ));
}

function stripSequentialRenderedLineNumbers(raw, options = {}) {
    const text = String(raw || '');
    const lines = text.split(/\r?\n/);
    const gutters = lines
        .map((line, index) => ({ index, value: line.trim() }))
        .filter((entry) => /^\d+$/.test(entry.value));

    if (gutters.length < 2) return text;
    const firstGutter = Number(gutters[0].value);
    if (!gutters.every((entry, index) => Number(entry.value) === firstGutter + index)) return text;

    const gutterIndexes = new Set(gutters.map((entry) => entry.index));
    const cleaned = lines
        .filter((_, index) => !gutterIndexes.has(index))
        .join('\n')
        .trim();
    if (options.payloadPattern && !options.payloadPattern.test(cleaned)) return text;
    return cleaned;
}

function extractJsonPayloadFromRenderedCode(raw, options = {}) {
    const text = String(raw || '');
    const allowArray = options.allowArray === true;
    const objectIndex = text.indexOf('{');
    const arrayIndex = allowArray ? text.indexOf('[') : -1;
    const starts = [objectIndex, arrayIndex].filter((index) => index >= 0);
    if (starts.length === 0) return text;
    const start = Math.min(...starts);

    // M365 merges code-block chrome into innerText. Only discard the exact
    // renderer labels and standalone gutter numbers observed around the JSON;
    // arbitrary prose must remain invalid at the protocol boundary.
    if (!isRenderedCodeChrome(text.slice(0, start))) return text;

    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') {
            inString = true;
            continue;
        }
        if (character === '{' || character === '[') {
            stack.push(character);
            continue;
        }
        if (character !== '}' && character !== ']') continue;

        const expected = character === '}' ? '{' : '[';
        if (stack.pop() !== expected) return text;
        if (stack.length !== 0) continue;

        const payload = text.slice(start, index + 1);
        if (!isRenderedCodeChrome(text.slice(index + 1))) return text;
        if (options.payloadPattern && !options.payloadPattern.test(payload)) return text;
        return payload;
    }
    return text;
}

module.exports = {
    extractJsonPayloadFromRenderedCode,
    isRenderedCodeChrome,
    stripSequentialRenderedLineNumbers,
};
