"use strict";

const LANGUAGE_ALIASES = new Map([
    ["html", "html"],
    ["htm", "html"],
    ["css", "css"],
    ["javascript", "javascript"],
    ["js", "javascript"],
    ["typescript", "typescript"],
    ["ts", "typescript"],
    ["json", "json"],
    ["xml", "xml"],
    ["yaml", "yaml"],
    ["yml", "yaml"],
    ["markdown", "markdown"],
    ["md", "markdown"],
    ["python", "python"],
    ["py", "python"],
    ["powershell", "powershell"],
    ["shell", "shell"],
    ["bash", "shell"],
    ["sql", "sql"],
    ["java", "java"],
    ["c#", "csharp"],
    ["csharp", "csharp"],
    ["c++", "cpp"],
    ["cpp", "cpp"],
    ["text", "text"],
    ["plaintext", "text"],
]);

function normalizeLanguage(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return LANGUAGE_ALIASES.get(normalized) || "";
}

function flushMarkdown(segments, buffer) {
    if (buffer.length === 0) return;
    const content = buffer.join("\n").trim();
    if (content) segments.push({ kind: "markdown", content });
    buffer.length = 0;
}

function readRenderedGutterBlock(lines, languageIndex) {
    const language = normalizeLanguage(lines[languageIndex]);
    if (!language) return null;

    let cursor = languageIndex + 1;
    let expectedLineNumber = null;
    const codeLines = [];

    while (cursor + 1 < lines.length) {
        const gutter = String(lines[cursor] || "").trim();
        if (!/^\d+$/.test(gutter)) break;
        const lineNumber = Number(gutter);
        if (expectedLineNumber !== null && lineNumber !== expectedLineNumber + 1) break;
        expectedLineNumber = lineNumber;
        codeLines.push(String(lines[cursor + 1] || "").replace(/\u00a0/g, " "));
        cursor += 2;
    }

    // Three consecutive gutter/code pairs are specific enough to distinguish
    // M365's rendered code viewer from an ordinary numbered list.
    if (codeLines.length < 3) return null;

    let sourceWasCollapsed = false;
    if (/^(?:顯示更多行|show more lines)$/i.test(String(lines[cursor] || "").trim())) {
        sourceWasCollapsed = true;
        cursor += 1;
    }

    return {
        nextIndex: cursor,
        segment: {
            kind: "code",
            language,
            code: codeLines.join("\n").trimEnd(),
            sourceWasCollapsed,
        },
    };
}

function readMarkdownFence(lines, fenceIndex) {
    const opening = String(lines[fenceIndex] || "").trim().match(/^```([^`]*)$/);
    if (!opening) return null;
    const codeLines = [];
    let cursor = fenceIndex + 1;
    while (cursor < lines.length && !/^```\s*$/.test(String(lines[cursor] || "").trim())) {
        codeLines.push(String(lines[cursor] || ""));
        cursor += 1;
    }
    if (cursor >= lines.length) return null;
    return {
        nextIndex: cursor + 1,
        segment: {
            kind: "code",
            language: normalizeLanguage(opening[1]) || String(opening[1] || "text").trim().toLowerCase() || "text",
            code: codeLines.join("\n").trimEnd(),
            sourceWasCollapsed: false,
        },
    };
}

function parseM365MessageContent(raw) {
    const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n");
    const segments = [];
    const markdown = [];

    for (let index = 0; index < lines.length;) {
        const fenced = readMarkdownFence(lines, index);
        const rendered = fenced ? null : readRenderedGutterBlock(lines, index);
        const block = fenced || rendered;
        if (block) {
            flushMarkdown(segments, markdown);
            segments.push(block.segment);
            index = block.nextIndex;
            continue;
        }
        markdown.push(lines[index]);
        index += 1;
    }
    flushMarkdown(segments, markdown);

    return segments.length > 0 ? segments : [{ kind: "markdown", content: String(raw || "") }];
}

function isNearChatBottom(metrics, threshold = 96) {
    const scrollTop = Number(metrics && metrics.scrollTop);
    const clientHeight = Number(metrics && metrics.clientHeight);
    const scrollHeight = Number(metrics && metrics.scrollHeight);
    const safeThreshold = Number.isFinite(Number(threshold)) ? Math.max(0, Number(threshold)) : 96;
    if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) return true;
    return scrollHeight - clientHeight - scrollTop <= safeThreshold;
}

module.exports = {
    isNearChatBottom,
    normalizeLanguage,
    parseM365MessageContent,
};
