'use strict';

const FOLLOW_UP_RE = /(那(?:個|用)?|這(?:個|樣)?|它|剛剛|前面|上面|再(?:試|測|做|跑|開)?|繼續|重試|測試|測看看|試試看|試看看|用\s*action|\baction\b|\bbridge\b|那個工具|這個工具)/i;
const URL_RE = /https?:\/\/\S+/i;

function shouldUsePriorRoutingContext(message) {
    const text = String(message || '').trim();
    return text.length > 0 && text.length <= 180 && FOLLOW_UP_RE.test(text) && !URL_RE.test(text);
}

function buildContextualToolRoutingQuery(message, messages = [], options = {}) {
    const current = String(message || '').trim();
    if (!shouldUsePriorRoutingContext(current)) return current;

    const currentMessageId = String(options.currentMessageId || '');
    const prior = [...(Array.isArray(messages) ? messages : [])]
        .reverse()
        .find((item) => item
            && item.role === 'user'
            && item.source === 'user'
            && String(item.id || '') !== currentMessageId
            && String(item.content || '').trim());
    if (!prior) return current;

    const priorContent = String(prior.content || '').trim().slice(0, 2000);
    return `[Previous user context for tool routing only]\n${priorContent}\n[Current request]\n${current}`;
}

module.exports = {
    buildContextualToolRoutingQuery,
    shouldUsePriorRoutingContext,
};
