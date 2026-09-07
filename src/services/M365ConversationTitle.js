'use strict';

const PLACEHOLDER_TITLES = new Set([
    '新對話',
    '新对话',
    'new chat',
    'new conversation',
    'untitled chat',
    'untitled conversation',
]);

function normalizeForComparison(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase('zh-TW');
}

function isPlaceholderConversationTitle(value) {
    return PLACEHOLDER_TITLES.has(normalizeForComparison(value));
}

function normalizeGeneratedConversationTitle(value) {
    const rawTitle = String(value || '').normalize('NFKC');
    if (!rawTitle || /[\r\n]/.test(rawTitle)) return null;

    let title = rawTitle
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
        .trim();

    if (!title) return null;

    title = title
        .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!title
        || /https?:\/\/|www\./i.test(title)
        || /[\[\]{}<>`]/.test(title)
        || /\b(?:SYSTEM|GOLEM_(?:REPLY|ACTION|PLAN|MEMORY|CONVERSATION_TITLE))\b/i.test(title)
        || isPlaceholderConversationTitle(title)) {
        return null;
    }

    const characters = Array.from(title);
    if (characters.length > 32) {
        title = characters.slice(0, 32).join('').trim();
    }

    return Array.from(title).length >= 2 ? title : null;
}

module.exports = {
    PLACEHOLDER_TITLES,
    isPlaceholderConversationTitle,
    normalizeGeneratedConversationTitle,
};
