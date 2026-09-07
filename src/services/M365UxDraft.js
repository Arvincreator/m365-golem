'use strict';

function invalid(message) {
    return Object.assign(new Error(message), { code: 'M365_DRAFT_INVALID', statusCode: 400 });
}

function normalizeDraft(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Invalid draft.');
    const text = input.text ?? '';
    if (typeof text !== 'string' || text.length > 100000) throw invalid('Draft text exceeds the limit.');
    const list = (key) => {
        const value = input[key] ?? [];
        if (!Array.isArray(value) || value.length > 3 || value.some(v => typeof v !== 'string' || !v || v.length > 200)) throw invalid('Invalid resource selection.');
        return [...new Set(value)];
    };
    const attachments = input.attachmentDescriptors ?? [];
    if (!Array.isArray(attachments) || attachments.length > 10 || attachments.some(a => !a || typeof a.id !== 'string' || a.id.length > 200 || typeof a.fileName !== 'string' || a.fileName.length > 500 || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > 25 * 1024 * 1024 || !Number.isFinite(a.lastModified))) throw invalid('Invalid attachment descriptors.');
    if (attachments.reduce((n, a) => n + a.size, 0) > 50 * 1024 * 1024) throw invalid('Attachments exceed the limit.');
    const quote = input.quote ?? null;
    if (quote && (typeof quote.messageId !== 'string' || quote.messageId.length > 200 || typeof quote.excerpt !== 'string' || quote.excerpt.length > 12000)) throw invalid('Invalid quote.');
    const responseMode = input.responseMode ?? 'auto';
    if (!['auto', 'quick', 'thoughtful'].includes(responseMode)) throw invalid('Invalid response mode.');
    return { schemaVersion: 1, text, responseMode, referenceFileIds: list('referenceFileIds'), mcpServerNames: list('mcpServerNames'), skillIds: list('skillIds'),
        quote: quote ? { messageId: quote.messageId, excerpt: quote.excerpt } : null,
        attachmentDescriptors: attachments.map(a => ({ id: a.id, fileName: a.fileName, size: a.size, lastModified: a.lastModified, state: 'needs_reselect' })) };
}

// These endpoints never trust forwarded addresses or a caller-supplied Host alone.
function isLocalUxRequest(req) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded) return false;
    try {
        const host = new URL(`http://${req.headers.host}`);
        const origin = new URL(req.headers.origin || req.headers.referer || '');
        return [host, origin].every(url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            && ['3000', '3001'].includes(url.port) && ['http:', 'https:'].includes(url.protocol));
    } catch { return false; }
}

module.exports = { normalizeDraft, isLocalUxRequest };
