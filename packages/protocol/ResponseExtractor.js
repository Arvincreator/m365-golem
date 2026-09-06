// ============================================================
// 🔍 ResponseExtractor - 回應信封擷取與清理
// ============================================================
const { TIMINGS, LIMITS } = require('../../src/core/constants');

class ResponseExtractor {
    /**
     * Inspect the currently visible conversation without sending anything.
     * Used by the M365 recovery button to find the exact request envelope that
     * may have appeared after the normal wait expired.
     */
    static async inspectExistingResponse(page, selector, startTag, endTag, options = {}) {
        return page.evaluate(({ sel, sTag, eTag, responseContainers, stopSelectors }) => {
            const visible = (node) => {
                if (!node || !(node instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            };
            const closestMatching = (node, selectors) => {
                for (const candidate of selectors || []) {
                    try {
                        const matched = node && node.closest(candidate);
                        if (matched) return matched;
                    } catch (_) { }
                }
                return null;
            };
            const nodes = (() => {
                try { return Array.from(document.querySelectorAll(sel)); } catch (_) { return []; }
            })();
            const containers = [];
            const seen = new Set();
            for (const node of nodes) {
                const container = closestMatching(node, responseContainers) || node.parentElement || node;
                if (!container || seen.has(container)) continue;
                seen.add(container);
                containers.push(container);
            }
            const isGenerating = (stopSelectors || []).some((candidate) => {
                try { return Array.from(document.querySelectorAll(candidate)).some(visible); } catch (_) { return false; }
            });
            for (let index = containers.length - 1; index >= 0; index -= 1) {
                const container = containers[index];
                const rawText = String(container.innerText || container.textContent || '');
                const startIndex = rawText.indexOf(sTag);
                const endIndex = rawText.indexOf(eTag, startIndex + sTag.length);
                if (startIndex < 0 || endIndex <= startIndex) continue;
                const attachments = Array.from(container.querySelectorAll('a[href]')).map((anchor) => {
                    const href = String(anchor.href || '');
                    if (!/^https:\/\//i.test(href)) return null;
                    const name = String(anchor.innerText || anchor.getAttribute('download') || href)
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 240);
                    return { url: href, name, mimeType: 'application/octet-stream', isRemote: true };
                }).filter(Boolean);
                return {
                    found: true,
                    busy: isGenerating,
                    status: 'ENVELOPE_COMPLETE',
                    text: rawText.substring(startIndex + sTag.length, endIndex).trim(),
                    attachments,
                };
            }
            return { found: false, busy: isGenerating, status: isGenerating ? 'GENERATING' : 'NOT_FOUND', text: '', attachments: [] };
        }, {
            sel: selector,
            sTag: startTag,
            eTag: endTag,
            responseContainers: Array.isArray(options.responseContainerSelectors) && options.responseContainerSelectors.length > 0
                ? options.responseContainerSelectors
                : ['model-response', '.markdown', '.model-response-text', '.message-content', '[data-message-id]', '.conversation-turn'],
            stopSelectors: Array.isArray(options.stopSelectors) && options.stopSelectors.length > 0
                ? options.stopSelectors
                : ['button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]', '[data-testid*="stop" i]'],
        });
    }

    /**
     * 在瀏覽器內等待 AI 回應信封完成
     * (此函式會傳入 page.evaluate 在瀏覽器上下文中執行)
     *
     * @param {import('playwright').Page} page - Playwright 頁面實例
     * @param {string} selector - 回應氣泡的 CSS Selector
     * @param {string} startTag - 信封開始標籤
     * @param {string} endTag - 信封結束標籤
     * @param {string} baseline - 發送前的基準文字 (用於排除舊回應)
     * @param {{timeoutMs?: number, diagnosticSelectors?: string[], stableFallbackThreshold?: number}} [options]
     * @returns {Promise<{status: string, text: string, attachments?: Array, matchedSelector?: string, diagnostics?: Object}>}
     */
    static async waitForResponse(page, selector, startTag, endTag, baseline, options = {}) {
        const stableComplete = LIMITS.STABLE_THRESHOLD_COMPLETE;
        const stableThinking = LIMITS.STABLE_THRESHOLD_THINKING;
        const pollInterval = TIMINGS.POLL_INTERVAL;
        const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : TIMINGS.TIMEOUT;
        const graceMultiplier = Number.isFinite(Number(options.stableGraceMultiplier)) && Number(options.stableGraceMultiplier) > 0
            ? Number(options.stableGraceMultiplier)
            : 1.5;
        const stableThinkingThreshold = Math.max(stableThinking, Math.ceil(stableThinking * graceMultiplier));
        const configuredFallbackThreshold = Number(options.stableFallbackThreshold);
        const stableFallbackThreshold = Number.isFinite(configuredFallbackThreshold) && configuredFallbackThreshold > 0
            ? Math.max(1, Math.floor(configuredFallbackThreshold))
            : stableThinkingThreshold;

        return page.evaluate(
            async ({ sel, sTag, eTag, oldText, _stableComplete, _stableThinking, _stableFallback, _pollInterval, _timeout, _responseContainers, _diagnosticSelectors, _stopSelectors, _extractAttachments }) => {
                return new Promise((resolve) => {
                    const startTime = Date.now();
                    let beganAt = 0;
                    let stableCount = 0;
                    let lastCheckText = "";
                    let lastResponseText = "";
                    let lastAttachments = [];

                    const buildDiagnostics = () => {
                        const selectors = [];
                        for (const candidate of _diagnosticSelectors || []) {
                            try {
                                const matches = Array.from(document.querySelectorAll(candidate));
                                const last = matches.slice(-1)[0] || null;
                                const readAttr = (name) => String(last?.getAttribute?.(name) || '').slice(0, 160);
                                selectors.push({
                                    selector: candidate,
                                    count: matches.length,
                                    lastTag: String(last?.tagName || '').toLowerCase(),
                                    lastRole: readAttr('role'),
                                    lastAriaLabel: readAttr('aria-label'),
                                    lastDataTestId: readAttr('data-testid'),
                                    lastDataContent: readAttr('data-content'),
                                    lastDataAuthor: readAttr('data-message-author') || readAttr('data-author'),
                                    lastClassTokens: readAttr('class').split(/\s+/).filter(Boolean).slice(0, 8),
                                    lastTextLength: String(last?.innerText || last?.textContent || '').length,
                                });
                            } catch (_) {
                                selectors.push({ selector: candidate, invalid: true, count: 0 });
                            }
                        }

                        const iframeHosts = Array.from(document.querySelectorAll('iframe')).map((frame) => {
                            try {
                                return new URL(frame.getAttribute('src') || '', window.location.href).hostname;
                            } catch (_) {
                                return '';
                            }
                        }).filter(Boolean).slice(0, 10);

                        return {
                            selectors,
                            iframeCount: document.querySelectorAll('iframe').length,
                            iframeHosts: [...new Set(iframeHosts)],
                        };
                    };

                    const resolveTimeout = () => resolve({
                        status: 'TIMEOUT',
                        text: lastResponseText,
                        attachments: lastAttachments,
                        diagnostics: buildDiagnostics(),
                    });

                    const check = () => {
                        // This guard must run before every early return. Previously the
                        // zero-selector branch could reschedule forever and never time out.
                        if (Date.now() - startTime >= _timeout) {
                            resolveTimeout();
                            return;
                        }

                        const bubbles = Array.from(document.querySelectorAll(sel));
                        if (bubbles.length === 0) { setTimeout(check, _pollInterval); return; }

                        const isEditableNode = (el) => {
                            if (!el) return false;
                            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
                            if (el.isContentEditable) return true;
                            if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return true;
                            return false;
                        };
                        const closestMatching = (el, selectors) => {
                            if (!el) return null;
                            for (const candidate of selectors || []) {
                                try {
                                    const matched = el.closest(candidate);
                                    if (matched) return matched;
                                } catch (_) { }
                            }
                            return null;
                        };
                        const isSemanticResponseNode = (el) => {
                            if (!el) return false;
                            if (isEditableNode(el)) return false;
                            return Boolean(closestMatching(el, _responseContainers));
                        };

                        const semanticCandidates = bubbles.filter((node) => isSemanticResponseNode(node));
                        let currentLastBubble = (semanticCandidates.length ? semanticCandidates : bubbles).slice(-1)[0] || null;
                        if (!currentLastBubble) { setTimeout(check, _pollInterval); return; }

                        let container = closestMatching(currentLastBubble, _responseContainers) ||
                            currentLastBubble.parentElement ||
                            currentLastBubble;
                        if (isEditableNode(container)) {
                            container = currentLastBubble;
                        }

                        const rawText = container.innerText || "";
                        const matchedSelector = (_responseContainers || []).find((candidate) => {
                            try {
                                return currentLastBubble.matches(candidate) || Boolean(currentLastBubble.closest(candidate));
                            } catch (_) {
                                return false;
                            }
                        }) || '';
                        lastResponseText = rawText;
                        const startIndex = rawText.indexOf(sTag);
                        const endIndex = rawText.indexOf(eTag);
                        if (startIndex !== -1 && beganAt === 0) {
                            beganAt = Date.now();
                        }

                        // 📸 [v9.1.10] 提取容器內的圖片與其他附件
                        const attachments = [];
                        
                        if (_extractAttachments) {
                            // 1. 圖片偵測 (濾除天氣/UI 圖示等 svg 雜訊)
                            container.querySelectorAll('img').forEach(img => {
                                if (img.src && img.src.startsWith('http')) {
                                    if (img.src.toLowerCase().includes('.svg')) return;
                                    attachments.push({ url: img.src, mimeType: 'image/png' });
                                }
                            });

                            // 2. 連結/下載偵測 (例如生成的檔案、PDF 等)
                            container.querySelectorAll('a').forEach(a => {
                                const href = a.href || "";
                                if (!href || !href.startsWith('http')) return;
                                const isDownload = a.hasAttribute('download');
                                const linkText = String(a.innerText || a.textContent || '').trim();
                                const hasFileExt = /\.(pdf|docx|xlsx|pptx|csv|txt|zip|md|js|py)(?:$|[?#])/i.test(href)
                                    || /\.(pdf|docx|xlsx|pptx|csv|txt|zip|md|js|py)$/i.test(linkText);
                                const isGoogleContent = href.includes('googleusercontent.com') || href.includes('blob:');
                                const looksLikeDownload = /download|attachment/i.test(href);
                                if (isDownload || hasFileExt || isGoogleContent || looksLikeDownload) {
                                    let mime = 'application/octet-stream';
                                    if (href.endsWith('.pdf')) mime = 'application/pdf';
                                    else if (href.endsWith('.md')) mime = 'text/markdown';
                                    else if (href.endsWith('.txt')) mime = 'text/plain';
                                    attachments.push({
                                        url: href,
                                        mimeType: mime,
                                        name: linkText || a.getAttribute('download') || '下載檔案',
                                        isRemote: true,
                                    });
                                }
                            });
                        }
                        lastAttachments = attachments;

                        // ✨ [條件 1：完美信封] 看到 END 標籤，瞬間打包回傳
                        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
                            const content = rawText.substring(startIndex + sTag.length, endIndex).trim();
                            resolve({ 
                                status: 'ENVELOPE_COMPLETE', 
                                text: content,
                                attachments: attachments,
                                matchedSelector,
                            });
                            return;
                        }

                        // 計算文字穩定度
                        if (rawText === lastCheckText) {
                            stableCount++;
                        } else {
                            stableCount = 0;
                        }
                        lastCheckText = rawText;

                        // 嘗試判斷目前是否仍在生成（避免慢回應被誤判截斷）
                        let stopControls = [];
                        try {
                            stopControls = Array.from(document.querySelectorAll((_stopSelectors || []).join(', ')));
                        } catch (_) { }
                        const isLikelyGenerating = stopControls.some((el) => {
                            if (!el) return false;
                            const style = window.getComputedStyle(el);
                            const rect = el.getBoundingClientRect();
                            return rect.width > 0 &&
                                rect.height > 0 &&
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                !el.disabled &&
                                el.getAttribute('aria-disabled') !== 'true';
                        });

                        if (startIndex !== -1) {
                            // ✨ [條件 2：已經開始回答] 看到 BEGIN，但遲遲沒看到 END (AI 忘記寫)
                            // 只要畫面停頓超過 5 秒 (10 次檢查) 沒動靜，就強制截斷回傳，不等 30 秒！
                            if (stableCount > _stableComplete) {
                                const content = rawText.substring(startIndex + sTag.length).trim();
                                resolve({ 
                                    status: 'ENVELOPE_TRUNCATED', 
                                    text: content,
                                    attachments: attachments,
                                    matchedSelector,
                                });
                                return;
                            }
                            // [v9.6.22] BEGIN 後若遲遲沒 END，給絕對上限避免首則卡死
                            if (beganAt > 0 && Date.now() - beganAt > 45000) {
                                const content = rawText.substring(startIndex + sTag.length).trim();
                                resolve({
                                    status: 'ENVELOPE_TRUNCATED_TIMEOUT',
                                    text: content,
                                    attachments: attachments,
                                    matchedSelector,
                                });
                                return;
                            }
                        } else if (rawText !== oldText) {
                            // ✨ [條件 3.5：只有 END 沒有 BEGIN]
                            // 有些回合模型會漏掉 BEGIN，只留下 END。若文字已穩定，直接回收 END 前內容。
                            if (endIndex !== -1 && stableCount > _stableFallback && !isLikelyGenerating) {
                                const content = rawText.substring(0, endIndex).trim();
                                resolve({
                                    status: 'ENVELOPE_END_ONLY',
                                    text: content,
                                    attachments: attachments,
                                    matchedSelector,
                                });
                                return;
                            }
                            // ✨ [條件 3：Thinking Mode] 還沒看到 BEGIN，可能在深思
                            // 若偵測仍在生成，延長容忍，避免慢回應被誤截斷
                            if (stableCount > _stableFallback && !isLikelyGenerating) {
                                resolve({ 
                                    status: 'FALLBACK_DIFF', 
                                    text: rawText,
                                    attachments: attachments,
                                    matchedSelector,
                                });
                                return;
                            }
                        }

                        // 總超時時間上限，預設 5 分鐘，可由特定呼叫延長。
                        if (Date.now() - startTime >= _timeout) {
                            resolveTimeout();
                            return;
                        }
                        setTimeout(check, _pollInterval);
                    };
                    check();
                });
            },
            {
                sel: selector,
                sTag: startTag,
                eTag: endTag,
                oldText: baseline,
                _stableComplete: stableComplete,
                _stableThinking: stableThinkingThreshold,
                _stableFallback: stableFallbackThreshold,
                _pollInterval: pollInterval,
                _timeout: timeout,
                _responseContainers: Array.isArray(options.responseContainerSelectors) && options.responseContainerSelectors.length > 0
                    ? options.responseContainerSelectors
                    : ['model-response', '.markdown', '.model-response-text', '.message-content', '[data-message-id]', '.conversation-turn'],
                _diagnosticSelectors: Array.isArray(options.diagnosticSelectors)
                    ? options.diagnosticSelectors
                    : [],
                _stopSelectors: Array.isArray(options.stopSelectors) && options.stopSelectors.length > 0
                    ? options.stopSelectors
                    : ['button[aria-label*=\"Stop\" i]', 'button[aria-label*=\"停止\" i]', '[data-testid*=\"stop\" i]'],
                _extractAttachments: options.extractAttachments !== false
            }
        );
    }

    /**
     * 清理回應文字中的信封標籤和系統雜訊
     * @param {string} rawText - 原始回應文字
     * @param {string} startTag - 信封開始標籤
     * @param {string} endTag - 信封結束標籤
     * @returns {string} 清理後的文字
     */
    static cleanResponse(rawText, startTag, endTag) {
        return rawText
            .replace(startTag, '')
            .replace(endTag, '')
            .replace(/\[{1,2}\s*(?:BEGIN|END)\s*:[^\]\n\r]+?\]{1,2}/gi, '')
            .replace(/\[\s*BEGIN\s*:[^\]\n\r]+?\]\]/gi, '')
            .replace(/\[\s*END\s*:[^\]\n\r]+?\]\]/gi, '')
            .replace(/\[\[\s*BEGIN\s*:[^\]\n\r]+?\]\]/gi, '')
            .replace(/\[\[\s*END\s*:[^\]\n\r]+?\]\]/gi, '')
            .replace(/\[\s*BEGIN\s*:[^\]\n\r]+?\]/gi, '')
            .replace(/\[\s*END\s*:[^\]\n\r]+?\]/gi, '')
            .replace(/\[\[\s*BEGIN\s*:[^\]\n\r]+?\]/gi, '')
            .replace(/\[\[\s*END\s*:[^\]\n\r]+?\]/gi, '')
            .replace(/\[\s*BEGIN\s*:[^\]\n\r]+?\]\]/gi, '')
            .replace(/\[\s*END\s*:[^\]\n\r]+?\]\]/gi, '')
            .replace(/\[SYSTEM: Please WRAP.*?\]/, '')
            .trim();
    }
}

module.exports = ResponseExtractor;
