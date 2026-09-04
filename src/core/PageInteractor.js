// ============================================================
// 🎯 PageInteractor - Web AI 頁面 DOM 互動引擎 (抗 UI 改版強化版 v9.1.5)
// ============================================================
const { TIMINGS, LIMITS } = require('./constants');
const { ResponseExtractor } = require('../../packages/protocol');

// 共用的按鈕偵測關鍵字 (供 autoClick 快速點擊使用)
const WORKSPACE_SAVE_KEYWORDS = ['儲存活動', '儲存', '建立', '建立活動', 'Save event', 'Save', 'Create'];

class PageInteractor {
    /**
     * @param {import('playwright').Page} page - Playwright 頁面實例
     * @param {import('../services/DOMDoctor')} doctor - DOM 修復服務
     */
    constructor(page, doctor, backendDefinition = null) {
        this.page = page;
        this.doctor = doctor;
        this.backendDefinition = backendDefinition || { id: 'gemini', label: 'Gemini Web' };
        this.backendLabel = this.backendDefinition.label || 'Web AI';
    }

    static getLargePayloadThreshold() {
        const raw = Number(process.env.GOLEM_COMPOSER_CHUNK_THRESHOLD || 12000);
        return Number.isFinite(raw) && raw > 0 ? raw : 12000;
    }

    static getComposerInsertChunkSize() {
        const raw = Number(process.env.GOLEM_COMPOSER_CHUNK_SIZE || 3500);
        return Number.isFinite(raw) && raw > 0 ? raw : 3500;
    }

    /**
     * 清洗 DOMDoctor 回傳的 Selector 字串
     * @param {string} rawSelector
     * @returns {string}
     */
    static cleanSelector(rawSelector) {
        if (!rawSelector) return "";
        let cleaned = rawSelector
            .replace(/```[a-zA-Z]*\s*/gi, '')
            .replace(/`/g, '')
            .trim();

        if (cleaned.toLowerCase().startsWith('css ')) {
            cleaned = cleaned.substring(4).trim();
        }
        return cleaned;
    }

    static getComposerSelectors(backendDefinition = null) {
        if (backendDefinition && Array.isArray(backendDefinition.composerSelectors) && backendDefinition.composerSelectors.length > 0) {
            return [...backendDefinition.composerSelectors];
        }
        return [
            '.ProseMirror',
            '.ql-editor',
            'rich-textarea .ProseMirror',
            'rich-textarea .ql-editor',
            'rich-textarea div[contenteditable="true"]',
            'div[role="textbox"][contenteditable="true"]',
            'div[contenteditable="true"]',
            'textarea'
        ];
    }

    _getComposerSelectors() {
        return PageInteractor.getComposerSelectors(this.backendDefinition);
    }

    /**
     * 主互動流程：輸入文字 → 點擊發送 → 等待回應 → 🌟自動點擊按鈕 (智慧判斷)
     */
    async interact(payload, selectors, isSystem, startTag, endTag, retryCount = 0, attachment = null, options = {}) {
        if (retryCount > LIMITS.MAX_INTERACT_RETRY) {
            throw new Error("🔥 DOM Doctor 修復失敗，請檢查網路或 HTML 結構大幅變更。");
        }

        try {
            // 🚀 利用 macOS AppleScript 將 Chrome 隱藏至背景，避免接下來的 focus() 搶走終端機焦點
            if (process.platform === 'darwin' && this.backendDefinition.id === 'gemini') {
                const { exec } = require('child_process');
                exec(`osascript -e 'tell application "System Events" to set visible of process "Google Chrome for Testing" to false' >/dev/null 2>&1`);
                exec(`osascript -e 'tell application "System Events" to set visible of process "Google Chrome" to false' >/dev/null 2>&1`);
            }

            // 0. 確保頁面處於空閒狀態 (避免前一則訊息還在發送中)
            await this._waitForReady(selectors.send, options);

            // 1. 捕獲基準文字
            const baseline = await this._captureBaseline(selectors.response);

            // 1.5 M365 附件使用可見頁面的原生 file input；舊後端保留原本貼上流程。
            if (attachment && this.backendDefinition.id === 'm365-web') {
                await this._attachM365Files(attachment);
            } else if (attachment && attachment.path) {
                await this._attachFile(selectors.input, attachment.path, attachment.mimeType);
            }

            // 2. 輸入文字 (使用無敵定位法 + 斜線指令標籤召喚術)
            await this._typeInput(selectors.input, payload);

            // 3. 等待輸入穩定
            await new Promise(r => setTimeout(r, TIMINGS.INPUT_DELAY));

            // M365 first uploads pasted/selected files to OneDrive. A visible
            // attachment card is not sufficient: wait until upload activity
            // stops and the real send control becomes enabled.
            if (attachment && this.backendDefinition.id === 'm365-web') {
                await this._waitForM365AttachmentUploadReady(
                    attachment,
                    selectors.send,
                    options.attachmentUploadTimeoutMs
                );
            }

            // 4. 發送訊息。M365 只允許點擊已啟用的真正送出鍵，絕不以 Enter 強送。
            await this._clickSend(selectors.send, {
                responseSelector: selectors.response,
                baseline,
                startTag,
                payloadLength: String(payload || '').length,
                hasAttachment: Boolean(attachment && this.backendDefinition.id === 'm365-web')
            });
            if (typeof options.onSendAccepted === 'function') {
                await options.onSendAccepted({
                    startTag,
                    endTag,
                    acceptedAt: Date.now(),
                });
            }

            // 5. 若為系統訊息，延遲後直接返回
            if (isSystem) {
                await new Promise(r => setTimeout(r, TIMINGS.SYSTEM_DELAY));
                return "";
            }

            // 6. 等待信封回應
            console.log(`⚡ [Brain] 等待信封完整性 (${startTag} ... ${endTag})...`);
            const responseOptions = {
                timeoutMs: options.responseTimeoutMs || options.timeoutMs || this.backendDefinition.responseTimeoutMs,
            };
            if (Array.isArray(this.backendDefinition.responseContainerSelectors)) {
                responseOptions.responseContainerSelectors = this.backendDefinition.responseContainerSelectors;
            }
            if (Array.isArray(this.backendDefinition.stopSelectors)) {
                responseOptions.stopSelectors = this.backendDefinition.stopSelectors;
            }
            if (Number.isFinite(Number(this.backendDefinition.unwrappedResponseStableThreshold))) {
                responseOptions.stableFallbackThreshold = Number(this.backendDefinition.unwrappedResponseStableThreshold);
            }
            if (this.backendDefinition.id === 'm365-web') {
                // Preserve only links that are visibly rendered in the M365
                // answer. They remain remote links; the harness does not fetch
                // them with hidden APIs or browser cookies.
                responseOptions.extractAttachments = true;
                responseOptions.diagnosticSelectors = Array.isArray(this.backendDefinition.responseDiagnosticSelectors)
                    ? this.backendDefinition.responseDiagnosticSelectors
                    : [];
            }
            const finalResponse = await ResponseExtractor.waitForResponse(
                this.page,
                selectors.response,
                startTag,
                endTag,
                baseline,
                responseOptions
            );

            if (finalResponse.status === 'TIMEOUT') {
                const timedOutText = String(finalResponse.text || '').trim();
                if (this.backendDefinition.id === 'm365-web' && finalResponse.diagnostics) {
                    console.warn(`[M365Diagnostics] 回覆在期限內未達可信完成條件；僅記錄節點統計，不記錄文字內容: ${JSON.stringify(finalResponse.diagnostics)}`);
                }
                if (!options.allowPartialOnTimeout) {
                    const responseError = new Error(this.backendDefinition.id === 'm365-web'
                        ? 'Microsoft 365 Copilot Chat 已接受送出，但在有限等待內找不到可信的回覆節點。'
                        : '等待回應超時');
                    if (this.backendDefinition.id === 'm365-web') responseError.code = 'M365_RESPONSE_NOT_FOUND';
                    throw responseError;
                }
                finalResponse.status = 'ENVELOPE_TIMEOUT_PARTIAL';
                console.warn(`⏳ [PageInteractor] 回應逾時但已捕獲部分內容，將交由上層解析 (${timedOutText.length} chars)。`);
            }

            if (this.backendDefinition.id === 'm365-web' && finalResponse.matchedSelector) {
                console.log(`✅ [PageInteractor] M365 回覆 selector: ${finalResponse.matchedSelector}`);
            }

            // 💡 效能優化：判斷這回合有沒有使用 /@ 擴充功能指令
            const hasExtensionCommand = /\/@(Gmail|Google Calendar|Google Keep|Google Tasks|Google 文件|Google 雲端硬碟|Workspace|YouTube Music|YouTube|Google Maps|Google 航班|Google 飯店|Spotify|Google Home|SynthID)/i.test(payload);

            if (hasExtensionCommand && this.backendDefinition.id === 'gemini') {
                // 只有呼叫了擴充功能，才需要花 1.5 秒去巡邏有沒有儲存按鈕
                await this._autoClickWorkspaceButtons();
            } else {
                console.log("⏩ [PageInteractor] 此次對話無擴充功能，跳過幽靈掃描，極速返回！");
            }

            console.log(`🏁 [Brain] 捕獲: ${finalResponse.status} | 長度: ${finalResponse.text.length} | 附件: ${finalResponse.attachments?.length || 0}`);
            
            // 🧹 [Memory Optimization] 實體修剪老舊 DOM 節點
            await this._pruneDOM();

            return {
                text: ResponseExtractor.cleanResponse(finalResponse.text, startTag, endTag),
                attachments: finalResponse.attachments || [],
                status: finalResponse.status
            };

        } catch (e) {
            console.warn(`⚠️ [Brain] 互動失敗: ${e.message}`);

            const postSendM365Failure = this.backendDefinition.id === 'm365-web'
                && ['M365_RESPONSE_NOT_FOUND', 'M365_SEND_UNCONFIRMED'].includes(String(e && e.code || ''));
            if (retryCount === 0 && !postSendM365Failure) {
                console.log('🩺 [Brain] 啟動 DOM Doctor 進行 Response 診斷...');
                const healed = await this._healSelector('response', selectors);
                if (healed) {
                    return this.interact(payload, selectors, isSystem, startTag, endTag, retryCount + 1, attachment, options);
                }
            }
            throw e;
        }
    }

    // ─── Private Methods ─────────────────────────────────────

    async _captureBaseline(responseSelector) {
        if (!responseSelector || responseSelector.trim() === "") {
            console.log("⚠️ Response Selector 為空，等待觸發修復。");
            throw new Error("空的 Response Selector");
        }

        return this.page.evaluate((s) => {
            const bubbles = document.querySelectorAll(s);
            if (bubbles.length === 0) return "";
            let target = bubbles[bubbles.length - 1];
            let container = target.closest('model-response') ||
                target.closest('.markdown') ||
                target.closest('.model-response-text') ||
                target.parentElement || target;
            return container.innerText || "";
        }, responseSelector).catch(() => "");
    }

    /**
     * 在輸入框中填入文字 (無敵屬性定位法 + 斜線標籤召喚)
     */
    async _typeInput(inputSelector, text) {
        // 🚀 定義網頁原生文字編輯器的通用特徵 (無視 class 改變)
        const fallbackSelectors = this._getComposerSelectors();

        let targetSelector = inputSelector;

        if (!targetSelector || targetSelector.trim() === "") {
            targetSelector = fallbackSelectors.join(', ');
        }

        // 🚀 [Playwright] 增加 waitForSelector 確保頁面渲染完成
        try {
            await this.page.waitForSelector(targetSelector, { state: 'attached', timeout: 5000 });
        } catch (e) {
            // 如果超時，嘗試使用通用特徵再次等待
            if (targetSelector !== fallbackSelectors.join(', ')) {
                try {
                    targetSelector = fallbackSelectors.join(', ');
                    await this.page.waitForSelector(targetSelector, { state: 'attached', timeout: 3000 });
                } catch (e2) { }
            }
        }

        let inputEl = await this.page.$(targetSelector);

        if (!inputEl) {
            console.log("🚑 連通用特徵都找不到輸入框，呼叫 DOM Doctor...");
            const html = await this.page.content();
            const newSel = await this.doctor.diagnose(html, 'input');
            if (newSel) {
                const cleaned = PageInteractor.cleanSelector(newSel);
                throw new Error(`SELECTOR_HEALED:input:${cleaned}`);
            }
            throw new Error("無法修復輸入框 Selector");
        }

        const extRegex = /\/@(Gmail|Google Calendar|Google Keep|Google Tasks|Google 文件|Google 雲端硬碟|Workspace|YouTube Music|YouTube|Google Maps|Google 航班|Google 飯店|Spotify|Google Home|SynthID)/i;
        const extMatch = text.match(extRegex);

        let textToPaste = text;

        if (extMatch) {
            const originalSlashCommand = extMatch[0];
            const extensionName = extMatch[1];
            const summonWord = '@' + extensionName;

            console.log(`🪄 [PageInteractor] 偵測到明確指令 [${originalSlashCommand}]，轉換為 [${summonWord}] 啟動召喚儀式...`);

            textToPaste = text.replace(originalSlashCommand, '').trim();

            await inputEl.focus();

            await this.page.keyboard.type(summonWord, { delay: 100 });
            await new Promise(r => setTimeout(r, 1500));
            await this.page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 500));

            console.log(`✅ [PageInteractor] [${summonWord}] 標籤召喚完成！準備貼上主指令...`);
        }

        const payloadLength = textToPaste.length;
        console.log(`📝 [PageInteractor] 準備植入文字 (長度: ${payloadLength})...`);

        // 1. 先使用 page.focus 確保焦點在輸入框上
        try {
            const focusedComposer = await this._focusBestComposer(targetSelector);
            if (focusedComposer && focusedComposer.ok && Number.isFinite(focusedComposer.x) && Number.isFinite(focusedComposer.y) && this.page.mouse) {
                await this.page.mouse.click(focusedComposer.x, focusedComposer.y);
            } else {
                if (typeof this.page.focus === 'function') {
                    await this.page.focus(targetSelector);
                }
                await inputEl.scrollIntoViewIfNeeded(); // [Playwright 強化] 確保在可視區域
                await inputEl.click({ delay: 50 });    // [強化] 點擊一下以確保真實 Focus
                await inputEl.focus();
            }
            await new Promise(r => setTimeout(r, 300)); // 給予瀏覽器反應時間
            
            // 🧹 清除可能殘留的舊內容
            const isMac = process.platform === 'darwin';
            await this.page.keyboard.down(isMac ? 'Meta' : 'Control');
            await this.page.keyboard.press('a');
            await this.page.keyboard.up(isMac ? 'Meta' : 'Control');
            await this.page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 100));
        } catch (e) {
            console.warn(`⚠️ [PageInteractor] focus 失敗: ${e.message}`);
        }

        let insertState = null;
        const isM365 = this.backendDefinition.id === 'm365-web';
        const minimumExpectedLength = Math.min(10, textToPaste.trim().length);
        const requiredInsertedLength = isM365 && textToPaste.trim().length > 100
            ? Math.max(minimumExpectedLength, Math.floor(textToPaste.trim().length * 0.9))
            : minimumExpectedLength;
        const shouldChunkInsert = payloadLength > PageInteractor.getLargePayloadThreshold();

        // 2. 優先使用 Playwright fill() 對 contenteditable 寫入。這會走瀏覽器原生
        // input/change 事件，比單純把文字塞進 DOM 更容易讓 Gemini 啟用送出鈕。
        try {
            if ((!shouldChunkInsert || isM365) && this.page.locator && textToPaste.length > 0) {
                const activeComposer = this.page.locator('[data-golem-active-composer="true"]').last();
                await activeComposer.fill(textToPaste, { timeout: 15000 });
                const fillState = await this._readComposerState('[data-golem-active-composer="true"]');
                if (fillState && fillState.ok && fillState.length >= requiredInsertedLength) {
                    insertState = {
                        ...fillState,
                        method: 'locator-fill'
                    };
                } else {
                    console.warn(`⚠️ [PageInteractor] locator.fill 後 composer 狀態不完整，改用鍵盤輸入補強。`);
                }
            }
        } catch (e) {
            console.warn(`⚠️ [PageInteractor] locator.fill 失敗: ${e.message}`);
        }

        if (isM365 && !insertState && this.page.keyboard) {
            const isMac = process.platform === 'darwin';
            await this.page.keyboard.press(isMac ? 'Meta+A' : 'Control+A').catch(() => {});
            await this.page.keyboard.press('Backspace').catch(() => {});
            await new Promise(r => setTimeout(r, 120));
        }

        // 3. 使用 Playwright 的真實文字輸入通道。這比 DOM 改字更能啟用
        // Gemini/ProseMirror 的 send button，尤其是 RPG/股市分析這種長 prompt。
        try {
            if (this.page.keyboard && typeof this.page.keyboard.insertText === 'function') {
                if (!insertState) {
                    if (shouldChunkInsert && !isM365) {
                        const chunkSize = PageInteractor.getComposerInsertChunkSize();
                        const totalChunks = Math.max(1, Math.ceil(textToPaste.length / chunkSize));
                        const startedAt = Date.now();
                        const progressInterval = Math.max(1, Math.floor(totalChunks / 8));
                        console.log(`⏳ [PageInteractor] AI 正在讀取長文本 ${textToPaste.length} 字，共分 ${totalChunks} 段。`);
                        for (let idx = 0; idx < totalChunks; idx += 1) {
                            const start = idx * chunkSize;
                            const end = Math.min(textToPaste.length, start + chunkSize);
                            const chunk = textToPaste.slice(start, end);
                            await this.page.keyboard.insertText(chunk);
                            if (idx === 0 || idx === totalChunks - 1 || (idx + 1) % progressInterval === 0) {
                                const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
                                console.log(`⏳ [PageInteractor] AI 正在讀取長文本 ${textToPaste.length} 字，共分 ${totalChunks} 段，目前第 ${idx + 1} 段 (${elapsed}s)。`);
                            }
                            if (idx < totalChunks - 1) {
                                await new Promise(r => setTimeout(r, 20));
                            }
                        }
                        console.log(`✅ [PageInteractor] 長文本讀取完成，共 ${textToPaste.length} 字 / ${totalChunks} 段。`);
                    } else {
                        await this.page.keyboard.insertText(textToPaste);
                    }
                }
                const keyboardState = await this._readComposerState(targetSelector);
                if (!insertState && keyboardState && keyboardState.ok && keyboardState.length >= requiredInsertedLength) {
                    insertState = {
                        ...keyboardState,
                        method: 'keyboard-insertText'
                    };
                } else if (!insertState) {
                    console.warn(`⚠️ [PageInteractor] keyboard.insertText 後 composer 狀態不完整，改用 DOM 貼上補強。`);
                }
            }
        } catch (e) {
            console.warn(`⚠️ [PageInteractor] keyboard.insertText 失敗: ${e.message}`);
        }

        // 4. Fallback：模擬真實貼上，而不是只改 innerText。Gemini 的 rich-textarea/ProseMirror
        // 需要 paste/input 事件更新內部狀態，否則畫面有草稿但送出鈕不會啟用。
        if (!insertState) {
            insertState = await this.page.evaluate(({ s, t, fallbacks }) => {
            const visible = (node) => {
                if (!node || !(node instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };

            const isEditable = (node) => {
                if (!node || !(node instanceof HTMLElement)) return false;
                const tag = node.tagName;
                return tag === 'TEXTAREA' ||
                    tag === 'INPUT' ||
                    node.isContentEditable ||
                    node.getAttribute('role') === 'textbox' ||
                    node.classList.contains('ProseMirror') ||
                    node.classList.contains('ql-editor');
            };

            const collect = (selector) => {
                if (!selector) return [];
                try {
                    return Array.from(document.querySelectorAll(selector));
                } catch (_) {
                    return [];
                }
            };

            const roots = [
                ...collect(s),
                ...fallbacks.flatMap(collect)
            ];
            const candidates = [];
            const addCandidate = (node) => {
                if (!node || !(node instanceof HTMLElement)) return;
                if (isEditable(node)) candidates.push(node);
                if (node.querySelectorAll) {
                    candidates.push(...Array.from(node.querySelectorAll(fallbacks.join(', '))).filter(isEditable));
                }
            };
            roots.forEach(addCandidate);

            const unique = Array.from(new Set(candidates)).filter(visible);
            unique.sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (br.top - ar.top) || (br.left - ar.left);
            });

            const el = unique[0];
            if (!el) return { ok: false, reason: 'editable-not-found' };

            const tagName = el.tagName;
            const isTextInput = tagName === 'TEXTAREA' || tagName === 'INPUT';
            el.focus();

            const dispatchInput = (inputType, data = null) => {
                try {
                    el.dispatchEvent(new InputEvent('beforeinput', {
                        bubbles: true,
                        cancelable: true,
                        inputType,
                        data
                    }));
                } catch (_) { }
                try {
                    el.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        cancelable: true,
                        inputType,
                        data
                    }));
                } catch (_) {
                    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                }
                el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Unidentified' }));
            };

            const selectAllEditable = () => {
                if (isTextInput) {
                    el.setSelectionRange(0, el.value.length);
                    return;
                }
                const range = document.createRange();
                range.selectNodeContents(el);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            };

            if (isTextInput) {
                const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
                if (setter) setter.call(el, '');
                else el.value = '';
                dispatchInput('deleteContentBackward');
                if (setter) setter.call(el, t);
                else el.value = t;
                dispatchInput('insertFromPaste', t);
                return {
                    ok: true,
                    method: 'native-value',
                    tagName,
                    length: el.value.length
                };
            }

            try {
                selectAllEditable();
                document.execCommand('delete', false);
            } catch (_) { }

            let pasteHandled = false;
            try {
                const dataTransfer = new DataTransfer();
                dataTransfer.setData('text/plain', t);
                const pasteEvent = new ClipboardEvent('paste', {
                    clipboardData: dataTransfer,
                    bubbles: true,
                    cancelable: true
                });
                pasteHandled = !el.dispatchEvent(pasteEvent) || pasteEvent.defaultPrevented;
            } catch (_) { }

            const currentTextAfterPaste = (el.innerText || el.textContent || '').trim();
            if (!currentTextAfterPaste || currentTextAfterPaste.length < Math.min(10, t.trim().length)) {
                try {
                    selectAllEditable();
                    const inserted = document.execCommand('insertText', false, t);
                    if (!inserted) {
                        el.textContent = t;
                    }
                } catch (_) {
                    el.textContent = t;
                }
                dispatchInput('insertFromPaste', t);
            } else {
                dispatchInput('insertFromPaste', t);
            }

            try {
                const range = document.createRange();
                const selection = window.getSelection();
                range.selectNodeContents(el);
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch (_) { }

            return {
                ok: true,
                method: pasteHandled ? 'paste-event' : 'exec-command',
                tagName,
                role: el.getAttribute('role') || '',
                className: el.className || '',
                length: (el.innerText || el.textContent || '').length
            };
            }, { s: targetSelector, t: textToPaste, fallbacks: fallbackSelectors });
        }

        if (!insertState || !insertState.ok || insertState.length < requiredInsertedLength) {
            throw new Error(`無法完整植入文字到 ${this.backendLabel} 輸入框: received=${insertState?.length || 0}, expected>=${requiredInsertedLength}, reason=${insertState?.reason || 'incomplete'}`);
        }
        console.log(`✅ [PageInteractor] 文字已植入 ${this.backendLabel} composer (${insertState.method}, ${insertState.tagName}, length=${insertState.length}).`);

        // 3. 額外觸發一個小的鍵盤事件，確保某些框架監聽的 focus/input 狀態被啟動
        await this.page.keyboard.type(' ', { delay: 1 });
        await this.page.keyboard.press('Backspace');
    }

    async _focusBestComposer(inputSelector) {
        return this.page.evaluate(({ s, fallbacks }) => {
            const visible = (node) => {
                if (!node || !(node instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const isEditable = (node) => {
                if (!node || !(node instanceof HTMLElement)) return false;
                const tag = node.tagName;
                return tag === 'TEXTAREA' ||
                    tag === 'INPUT' ||
                    node.isContentEditable ||
                    node.getAttribute('role') === 'textbox' ||
                    node.classList.contains('ProseMirror') ||
                    node.classList.contains('ql-editor');
            };
            const collect = (selector) => {
                if (!selector) return [];
                try {
                    return Array.from(document.querySelectorAll(selector));
                } catch (_) {
                    return [];
                }
            };
            const roots = [
                ...collect(s),
                ...fallbacks.flatMap(collect)
            ];
            const candidates = [];
            const addCandidate = (node) => {
                if (!node || !(node instanceof HTMLElement)) return;
                if (isEditable(node)) candidates.push(node);
                if (node.querySelectorAll) {
                    candidates.push(...Array.from(node.querySelectorAll(fallbacks.join(', '))).filter(isEditable));
                }
            };
            roots.forEach(addCandidate);
            const unique = Array.from(new Set(candidates)).filter(visible);
            unique.sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (br.top - ar.top) || (br.left - ar.left);
            });
            const el = unique[0];
            if (!el) return { ok: false, reason: 'editable-not-found' };
            document.querySelectorAll('[data-golem-active-composer="true"]').forEach((node) => {
                node.removeAttribute('data-golem-active-composer');
            });
            el.setAttribute('data-golem-active-composer', 'true');
            el.scrollIntoView({ block: 'center', inline: 'center' });
            el.focus();
            const rect = el.getBoundingClientRect();
            return {
                ok: true,
                tagName: el.tagName,
                className: el.className || '',
                role: el.getAttribute('role') || '',
                x: rect.left + Math.min(rect.width / 2, 24),
                y: rect.top + rect.height / 2
            };
        }, { s: inputSelector, fallbacks: this._getComposerSelectors() }).catch((error) => ({
            ok: false,
            reason: error.message
        }));
    }

    async _readComposerState(inputSelector) {
        return this.page.evaluate(({ s, fallbacks }) => {
            const visible = (node) => {
                if (!node || !(node instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const isEditable = (node) => {
                if (!node || !(node instanceof HTMLElement)) return false;
                const tag = node.tagName;
                return tag === 'TEXTAREA' ||
                    tag === 'INPUT' ||
                    node.isContentEditable ||
                    node.getAttribute('role') === 'textbox' ||
                    node.classList.contains('ProseMirror') ||
                    node.classList.contains('ql-editor');
            };
            const textOf = (node) => {
                if (!node) return '';
                if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') return node.value || '';
                return node.innerText || node.textContent || '';
            };
            const collect = (selector) => {
                if (!selector) return [];
                try {
                    return Array.from(document.querySelectorAll(selector));
                } catch (_) {
                    return [];
                }
            };
            const roots = [
                ...collect(s),
                ...fallbacks.flatMap(collect)
            ];
            const candidates = [];
            const addCandidate = (node) => {
                if (!node || !(node instanceof HTMLElement)) return;
                if (isEditable(node)) candidates.push(node);
                if (node.querySelectorAll) {
                    candidates.push(...Array.from(node.querySelectorAll(fallbacks.join(', '))).filter(isEditable));
                }
            };
            roots.forEach(addCandidate);
            const unique = Array.from(new Set(candidates)).filter(visible);
            unique.sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (br.top - ar.top) || (br.left - ar.left);
            });
            const el = unique[0];
            if (!el) return { ok: false, reason: 'editable-not-found', length: 0 };
            return {
                ok: true,
                tagName: el.tagName,
                className: el.className || '',
                role: el.getAttribute('role') || '',
                length: textOf(el).length
            };
        }, { s: inputSelector, fallbacks: this._getComposerSelectors() }).catch((error) => ({
            ok: false,
            reason: error.message,
            length: 0
        }));
    }

    async _waitForSendButtonEnabled(timeoutMs = 5000) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const ready = await this.page.evaluate(() => {
                const visible = (node) => {
                    if (!node || !(node instanceof HTMLElement)) return false;
                    const style = window.getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                };
                const editorSelector = [
                    '.ProseMirror',
                    '.ql-editor',
                    'rich-textarea .ProseMirror',
                    'rich-textarea .ql-editor',
                    'rich-textarea div[contenteditable="true"]',
                    'div[role="textbox"][contenteditable="true"]',
                    'div[contenteditable="true"]',
                    'textarea'
                ].join(', ');
                const editors = Array.from(document.querySelectorAll(editorSelector)).filter(visible);
                editors.sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    return (br.bottom - ar.bottom) || (br.left - ar.left);
                });
                const composer = editors[0] || null;
                if (!composer) return false;
                const inputRect = composer.getBoundingClientRect();
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title]')).filter(visible);
                return buttons.some((button) => {
                    const label = [
                        button.getAttribute('aria-label'),
                        button.getAttribute('title'),
                        button.getAttribute('data-tooltip'),
                        button.innerText,
                        button.textContent
                    ].filter(Boolean).join(' ').toLowerCase();
                    const explicitSend = label.includes('傳送訊息') ||
                        label.includes('送出訊息') ||
                        label.includes('發送訊息') ||
                        label.includes('send message') ||
                        label.includes('submit message');
                    if (!explicitSend) return false;
                    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
                    const rect = button.getBoundingClientRect();
                    const centerY = rect.top + rect.height / 2;
                    return centerY >= inputRect.top - 120 && centerY <= inputRect.bottom + 160;
                });
            }).catch(() => false);
            if (ready) return true;
            await new Promise(r => setTimeout(r, 250));
        }
        return false;
    }

    async _waitForM365AttachmentUploadReady(attachment, sendSelector, explicitTimeoutMs = null, safetyOptions = {}) {
        const configured = Number(explicitTimeoutMs);
        const timeoutMs = Number.isFinite(configured) && configured > 0
            ? Math.min(configured, 180000)
            : 90000;
        const configuredMinimumWait = Number(safetyOptions.minimumWaitMs);
        const minimumWaitMs = Number.isFinite(configuredMinimumWait) && configuredMinimumWait >= 0
            ? configuredMinimumWait
            : 1500;
        const configuredStableSamples = Number(safetyOptions.stableSamples);
        const stableSamplesRequired = Number.isFinite(configuredStableSamples) && configuredStableSamples > 0
            ? Math.max(1, Math.floor(configuredStableSamples))
            : 3;
        const configuredPollInterval = Number(safetyOptions.pollIntervalMs);
        const pollIntervalMs = Number.isFinite(configuredPollInterval) && configuredPollInterval >= 0
            ? configuredPollInterval
            : 350;
        const startedAt = Date.now();
        let consecutiveReadySamples = 0;
        while (Date.now() - startedAt < timeoutMs) {
            const uploadState = await this.page.evaluate(({ editorSelector, names }) => {
                const visible = (node) => {
                    if (!node || !(node instanceof HTMLElement)) return false;
                    const style = window.getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none'
                        && style.visibility !== 'hidden' && style.opacity !== '0';
                };
                const editors = Array.from(document.querySelectorAll(editorSelector)).filter(visible);
                editors.sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    return (br.bottom - ar.bottom) || (br.left - ar.left);
                });
                const composer = editors[0] || null;
                const root = composer
                    ? (composer.closest('form') || composer.parentElement?.parentElement || document.body)
                    : document.body;
                const text = String(root && root.innerText || '').toLowerCase();
                const errorText = [
                    'upload failed', 'failed to upload', '上傳失敗', '無法上傳',
                    '檔案上傳失敗', 'file is not supported', '不支援此檔案',
                ].find((value) => text.includes(value)) || '';
                const progressSelectors = [
                    '[role="progressbar"]',
                    '[aria-busy="true"]',
                    '[aria-label*="uploading" i]',
                    '[aria-label*="processing" i]',
                    '[aria-label*="正在上傳"]',
                    '[aria-label*="處理中"]',
                    '[data-testid*="progress" i]',
                    '[class*="upload-progress" i]',
                    '[class*="uploading" i]',
                ];
                const hasVisibleProgress = progressSelectors.some((selector) => {
                    try { return Array.from(root.querySelectorAll(selector)).some(visible); } catch (_) { return false; }
                });
                const hasProgressText = /uploading|preparing file|processing file|正在上傳|上傳中|正在處理附件|準備檔案/.test(text);
                const bodyText = document.body ? String(document.body.innerText || '') : '';
                const labelledText = Array.from(document.querySelectorAll('[aria-label], [title]'))
                    .map((node) => `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`)
                    .join('\n');
                const searchableText = `${bodyText}\n${labelledText}`.toLocaleLowerCase();
                const everyNameVisible = names.every((name) => searchableText.includes(String(name).toLocaleLowerCase()));
                return {
                    errorText,
                    pending: hasVisibleProgress || hasProgressText,
                    everyNameVisible,
                };
            }, {
                editorSelector: this._getComposerSelectors().join(', '),
                names: (attachment.files || []).map((file) => String(file.name || '')),
            }).catch(() => ({ errorText: '', pending: true, everyNameVisible: false }));

            if (uploadState.errorText) {
                const error = new Error(`Microsoft 365 Copilot 回報附件上傳失敗：${uploadState.errorText}`);
                error.code = 'M365_ATTACHMENT_UPLOAD_FAILED';
                throw error;
            }
            if (!uploadState.pending && uploadState.everyNameVisible) {
                const sendTarget = await this._tryClickSendButton(sendSelector);
                if (sendTarget && sendTarget.clicked) {
                    consecutiveReadySamples += 1;
                    const waitedLongEnough = Date.now() - startedAt >= minimumWaitMs;
                    if (waitedLongEnough && consecutiveReadySamples >= stableSamplesRequired) {
                        console.log('✅ [PageInteractor] M365 附件已完成 OneDrive 上傳，送出按鈕已連續穩定啟用。');
                        return;
                    }
                } else {
                    consecutiveReadySamples = 0;
                }
            } else {
                consecutiveReadySamples = 0;
            }
            await new Promise(r => setTimeout(r, pollIntervalMs));
        }
        const error = new Error('Microsoft 365 Copilot 的附件仍在上傳或送出按鈕尚未啟用；系統已停止，不會按 Enter 或自動重送。');
        error.code = 'M365_ATTACHMENT_UPLOAD_TIMEOUT';
        throw error;
    }

    async _waitForSendTarget(sendSelector, timeoutMs = 5000) {
        const startedAt = Date.now();
        let lastTarget = null;
        do {
            lastTarget = await this._tryClickSendButton(sendSelector);
            if (lastTarget && lastTarget.clicked) return lastTarget;
            await new Promise(r => setTimeout(r, 250));
        } while (Date.now() - startedAt < timeoutMs);
        return lastTarget;
    }

    async _clickSend(sendSelector, options = {}) {
        const isM365 = this.backendDefinition.id === 'm365-web';
        const hasM365Attachment = isM365 && options.hasAttachment === true;
        let usedKeyboardSubmit = false;

        // 1. 確保焦點回到底部 Gemini composer，而不是頁面上的舊 editable。
        try {
            const focusedComposer = await this._focusBestComposer(this._getComposerSelectors().join(', '));
            if (focusedComposer && focusedComposer.ok && Number.isFinite(focusedComposer.x) && Number.isFinite(focusedComposer.y) && this.page.mouse) {
                await this.page.mouse.click(focusedComposer.x, focusedComposer.y);
            }
            await new Promise(r => setTimeout(r, 100));
        } catch (e) { }

        // 防止 Enter 太快，給予輸入框更新時間
        await new Promise(r => setTimeout(r, 500));
        const dynamicTimeout = this._computeSendAcceptTimeout(options.payloadLength, options.sendAcceptTimeoutMs);
        const sendOptions = {
            ...options,
            sendAcceptTimeoutMs: dynamicTimeout
        };
        const sendReadyTimeout = this._computeSendReadyTimeout(
            options.payloadLength,
            options.sendReadyTimeoutMs
        );
        const sendTarget = await this._waitForSendTarget(sendSelector, sendReadyTimeout);

        if (!sendTarget || !sendTarget.clicked) {
            if (hasM365Attachment) {
                const sendError = new Error('Microsoft 365 Copilot 的送出按鈕尚未啟用；為避免在附件上傳期間鎖住草稿，系統已停止且不會改按 Enter。');
                sendError.code = 'M365_SEND_NOT_READY';
                throw sendError;
            }
            await this._pressSubmitKeys();
            usedKeyboardSubmit = true;
            console.warn(`⚠️ [PageInteractor] 找不到可點擊的送出按鈕，已嘗試鍵盤送出。${sendTarget?.diagnostics ? ` 候選: ${sendTarget.diagnostics}` : ''}`);
        } else {
            console.log(`🎯 [PageInteractor] 找到送出候選按鈕 score=${sendTarget.score || 0} label="${sendTarget.label || ''}"`);
            await this._performSendClick(sendTarget);
        }

        let accepted = await this._waitForSendAccepted(sendOptions);
        if (!accepted) {
            const draftBeforeRetry = await this._inspectComposerDraftState(options.startTag || '').catch(() => null);
            const currentDraftRemains = draftBeforeRetry
                ? (options.startTag ? draftBeforeRetry.hasStartTag : draftBeforeRetry.hasDraft)
                : true;

            // A cleared current envelope is itself an acceptance signal. If the
            // exact M365 envelope is still visible, use only one bounded retry:
            // text-only messages may use the original Golem Enter fallback,
            // while attachment messages must retry the real Send button only.
            if (isM365 && !currentDraftRemains) {
                accepted = true;
            } else {
                console.warn(`⚠️ [PageInteractor] ${this.backendLabel} 草稿尚未送出，進行一次送出補強。`);
                if (isM365 && !hasM365Attachment && !usedKeyboardSubmit) {
                    await this._pressSubmitKeys();
                    usedKeyboardSubmit = true;
                    console.warn('⌨️ [PageInteractor] M365 純文字草稿仍在，已使用一次 Enter 備援；附件訊息不會走此路徑。');
                } else {
                    const retryTarget = await this._waitForSendTarget(sendSelector, Math.min(sendReadyTimeout, 5000));
                    if (!retryTarget || !retryTarget.clicked) {
                        if (!isM365) await this._pressSubmitKeys();
                    } else {
                        console.log(`🎯 [PageInteractor] 第二次送出候選按鈕 score=${retryTarget.score || 0} label="${retryTarget.label || ''}"`);
                        await this._performSendClick(retryTarget);
                        await this._focusBestComposer(this._getComposerSelectors().join(', ')).catch(() => null);
                    }
                }
                accepted = await this._waitForSendAccepted(sendOptions);
            }
            if (!accepted) {
                const sendError = new Error(`${this.backendLabel} 草稿未送出：已植入文字，但送出按鈕沒有啟用或訊息沒有離開輸入框。`);
                if (isM365) sendError.code = 'M365_SEND_UNCONFIRMED';
                throw sendError;
            }
        }
        let draftState = await this._inspectComposerDraftState(options.startTag || '').catch(() => null);
        draftState = draftState || { hasDraft: false, length: 0, hasStartTag: false };
        const currentDraftRemains = options.startTag ? draftState.hasStartTag : draftState.hasDraft;
        if (currentDraftRemains) {
            if (isM365) {
                const sendError = new Error(`${this.backendLabel} 草稿未送出：輸入框仍殘留目前信封內容（len=${draftState.length}, startTag=${draftState.hasStartTag}）。`);
                sendError.code = 'M365_SEND_UNCONFIRMED';
                throw sendError;
            }
            console.warn(`⚠️ [PageInteractor] 偵測到草稿仍在輸入框（len=${draftState.length}, startTag=${draftState.hasStartTag}），執行第三次送出補強。`);
            const thirdTarget = await this._tryClickSendButton(sendSelector);
            if (!thirdTarget || !thirdTarget.clicked) {
                if (this.backendDefinition.id !== 'm365-web') await this._pressSubmitKeys();
            } else {
                console.log(`🎯 [PageInteractor] 第三次送出候選按鈕 score=${thirdTarget.score || 0} label="${thirdTarget.label || ''}"`);
                await this._performSendClick(thirdTarget);
            }
            await new Promise(r => setTimeout(r, 300));
            draftState = await this._inspectComposerDraftState(options.startTag || '').catch(() => null);
            draftState = draftState || { hasDraft: false, length: 0, hasStartTag: false };
            if (draftState.hasDraft) {
                const sendError = new Error(`${this.backendLabel} 草稿未送出：輸入框仍殘留內容（len=${draftState.length}, startTag=${draftState.hasStartTag}）。`);
                throw sendError;
            }
        }

        // 3. 自動置底 (最小化干擾)
        await this._moveWindowToBottom();

        await new Promise(r => setTimeout(r, 200));
    }

    async _inspectComposerDraftState(startTag = '') {
        return this.page.evaluate(({ sTag, editorSelector }) => {
            const visible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const textOf = (el) => {
                if (!el) return '';
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
                return el.innerText || el.textContent || '';
            };
            const editors = Array.from(document.querySelectorAll(editorSelector)).filter(visible);
            editors.sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (br.bottom - ar.bottom) || (br.left - ar.left);
            });
            const text = textOf(editors[0] || null).trim();
            const hasStartTag = Boolean(sTag && text.includes(sTag));
            const hasAnyBegin = /\[\[?BEGIN\s*:/i.test(text);
            const hasDraft = hasStartTag || hasAnyBegin || text.length > 80;
            return {
                hasDraft,
                hasStartTag,
                length: text.length
            };
        }, {
            sTag: startTag || '',
            editorSelector: this._getComposerSelectors().join(', '),
        });
    }

    async _pressSubmitKeys() {
        try {
            const focusedComposer = await this._focusBestComposer(this._getComposerSelectors().join(', '));
            if (focusedComposer && focusedComposer.ok && Number.isFinite(focusedComposer.x) && Number.isFinite(focusedComposer.y) && this.page.mouse) {
                await this.page.mouse.click(focusedComposer.x, focusedComposer.y);
                await new Promise(r => setTimeout(r, 80));
            }
        } catch (_) { }

        const submitCombos = this.backendDefinition.id === 'm365-web'
            ? ['Enter']
            : (process.platform === 'darwin'
                ? ['Enter', 'Meta+Enter', 'Control+Enter']
                : ['Enter', 'Control+Enter']);
        for (const combo of submitCombos) {
            await this.page.keyboard.press(combo).catch(() => {});
            await new Promise(r => setTimeout(r, 180));
        }
    }

    async _performSendClick(sendTarget) {
        if (!sendTarget || !Number.isFinite(sendTarget.x) || !Number.isFinite(sendTarget.y)) return;
        try {
            if (this.page.mouse && typeof this.page.mouse.click === 'function') {
                await this.page.mouse.click(sendTarget.x, sendTarget.y);
            } else {
                await this.page.evaluate(({ x, y }) => {
                    const target = document.elementFromPoint(x, y);
                    if (target && typeof target.click === 'function') target.click();
                }, { x: sendTarget.x, y: sendTarget.y });
            }
        } catch (e) {
            console.warn(`⚠️ [PageInteractor] 點擊送出按鈕失敗: ${e.message}`);
        }
    }

    async _tryClickSendButton(sendSelector) {
        const evaluationArg = this.backendDefinition.id === 'm365-web'
            ? {
                s: sendSelector,
                editorSelector: this._getComposerSelectors().join(', '),
            }
            : sendSelector;
        return this.page.evaluate((arg) => {
            const defaultEditorSelector = [
                '.ProseMirror',
                '.ql-editor',
                'rich-textarea .ProseMirror',
                'rich-textarea .ql-editor',
                'rich-textarea div[contenteditable="true"]',
                'div[role="textbox"][contenteditable="true"]',
                'div[contenteditable="true"]',
                'textarea'
            ].join(', ');
            const s = typeof arg === 'string' ? arg : arg.s;
            const editorSelector = typeof arg === 'string' ? defaultEditorSelector : arg.editorSelector;
            const stopWords = ['停止', 'Stop', '中斷', 'キャンセル', '停止生成', 'stop generating'];
            const sendWords = ['發送', '傳送', '送出', '提交', 'Send', 'Submit', '送信', '送る', 'send message'];
            const visible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const labelFor = (btn) => [
                btn.getAttribute('aria-label'),
                btn.getAttribute('title'),
                btn.getAttribute('data-tooltip'),
                btn.getAttribute('data-test-id'),
                btn.innerText,
                btn.textContent
            ].filter(Boolean).join(' ').trim();
            const findComposer = () => Array.from(document.querySelectorAll(editorSelector))
                .filter(visible)
                .sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    return (br.bottom - ar.bottom) || (br.left - ar.left);
                })[0] || null;
            const isNavigationButton = (btn, lowerLabel) => {
                const navRoot = btn.closest('nav, aside, mat-sidenav, [role="navigation"], .side-nav, .sidenav, .mat-drawer, .mat-sidenav, .navigation');
                if (navRoot) return true;
                return lowerLabel.includes('主選單') ||
                    lowerLabel.includes('main menu') ||
                    lowerLabel.includes('side-nav') ||
                    lowerLabel.includes('side nav') ||
                    lowerLabel.includes('sidenav') ||
                    lowerLabel.includes('menu button') ||
                    lowerLabel.includes('選單');
            };
            const nearComposer = (btn, composer) => {
                if (!composer) return false;
                const rect = btn.getBoundingClientRect();
                const inputRect = composer.getBoundingClientRect();
                const buttonCenterY = rect.top + rect.height / 2;
                const inputCenterY = inputRect.top + inputRect.height / 2;
                const yTolerance = Math.max(140, inputRect.height + 80);
                return Math.abs(buttonCenterY - inputCenterY) <= yTolerance &&
                    rect.left >= inputRect.left - 24 &&
                    rect.top <= inputRect.bottom + 120 &&
                    rect.bottom >= inputRect.top - 120;
            };
            const utilityWords = [
                '工具', 'tool', 'tools', 'mic', 'microphone', 'voice', '語音', '麥克風',
                'attach', 'attachment', 'upload', '上傳', '附件', '新增', 'add',
                '更多', 'more', 'menu', '選單', 'image', '圖片', '檔案'
            ];
            const describeIcon = (btn) => [
                btn.getAttribute('data-icon'),
                btn.getAttribute('data-mat-icon-name'),
                btn.getAttribute('fonticon'),
                btn.getAttribute('icon'),
                btn.className,
                btn.querySelector && btn.querySelector('mat-icon') ? btn.querySelector('mat-icon').textContent : '',
                btn.querySelector && btn.querySelector('[data-icon]') ? btn.querySelector('[data-icon]').getAttribute('data-icon') : '',
                btn.innerHTML
            ].filter(Boolean).join(' ');
            const scoreButton = (btn) => {
                if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true' || !visible(btn)) return -1;
                const label = labelFor(btn);
                const lowerLabel = label.toLowerCase();
                if (stopWords.some(word => lowerLabel.includes(word.toLowerCase()))) return -1;
                const rect = btn.getBoundingClientRect();
                const composer = findComposer();
                const nearInput = nearComposer(btn, composer);
                if (isNavigationButton(btn, lowerLabel)) return -1;
                if (utilityWords.some(word => lowerLabel.includes(word.toLowerCase()))) return -1;

                const explicitSend = lowerLabel.includes('send message') ||
                    lowerLabel.includes('傳送訊息') ||
                    lowerLabel.includes('送出訊息') ||
                    lowerLabel.includes('發送訊息') ||
                    lowerLabel.includes('submit message');
                const genericSend = sendWords.some(word => lowerLabel.includes(word.toLowerCase()));
                const iconDescription = describeIcon(btn);
                const iconLooksLikeSend = /paper-plane|arrow[_-]?upward|send|send[_-]?button|sendicon|send-icon/i.test(iconDescription) ||
                    /<mat-icon[^>]*>\s*(send|arrow_upward)\s*<\/mat-icon>/i.test(iconDescription);
                const iconOnly = label.length <= 48 && rect.width <= 88 && rect.height <= 88;
                let rightEdgeCandidate = false;
                if (composer) {
                    const inputRect = composer.getBoundingClientRect();
                    const centerX = rect.left + rect.width / 2;
                    const centerY = rect.top + rect.height / 2;
                    rightEdgeCandidate = centerX >= inputRect.right - 160 &&
                        centerX <= inputRect.right + 220 &&
                        centerY >= inputRect.top - 80 &&
                        centerY <= inputRect.bottom + 120;
                }

                if (explicitSend && nearInput) return 150;
                if (explicitSend) return 100;
                if (genericSend && nearInput) return 120;
                if (nearInput && iconOnly && iconLooksLikeSend) return 90;
                if (nearInput && rightEdgeCandidate && iconOnly && !label) return 60;

                return -1;
            };

            let explicit = null;
            try {
                explicit = (s ? document.querySelector(s) : null);
            } catch (_) { }
            const candidates = [
                explicit,
                ...Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title], [data-tooltip], [data-test-id], span[data-icon]'))
            ].filter(Boolean).map((node) => {
                if (!(node instanceof HTMLElement)) return null;
                return node.closest('button, [role="button"], [aria-label], [title], [data-tooltip], [data-test-id]') || node;
            }).filter(Boolean);
            const uniqueCandidates = Array.from(new Set(candidates));

            let best = null;
            let bestScore = -1;
            let bestLabel = '';
            const diagnostics = [];
            for (const btn of uniqueCandidates) {
                const score = scoreButton(btn);
                if (diagnostics.length < 8) {
                    const label = labelFor(btn).slice(0, 40);
                    const rect = btn.getBoundingClientRect();
                    if (visible(btn)) diagnostics.push(`${score}:${label || describeIcon(btn).slice(0, 40)}@${Math.round(rect.left)},${Math.round(rect.top)}`);
                }
                if (score > bestScore) {
                    best = btn;
                    bestScore = score;
                    bestLabel = labelFor(btn);
                }
            }

            if (!best || bestScore < 0) return {
                clicked: false,
                reason: 'send-button-not-found',
                diagnostics: diagnostics.join(' | ')
            };
            best.scrollIntoView({ block: 'center', inline: 'center' });
            const rect = best.getBoundingClientRect();
            best.focus();
            return {
                clicked: true,
                score: bestScore,
                label: bestLabel.slice(0, 80),
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            };
        }, evaluationArg).catch((error) => ({ clicked: false, reason: error.message }));
    }

    async _waitForSendAccepted(options = {}) {
        const timeoutMs = options.sendAcceptTimeoutMs || 5000;
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const state = await this.page.evaluate(({ responseSelector, baseline, startTag, editorSelector, responseContainers }) => {
                const visible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                };
                const textOf = (el) => {
                    if (!el) return '';
                    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
                    return el.innerText || el.textContent || '';
                };
                const editors = Array.from(document.querySelectorAll(editorSelector)).filter(visible);
                editors.sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    return (br.bottom - ar.bottom) || (br.left - ar.left);
                });
                const composerTexts = editors
                    .map((editor) => textOf(editor).trim())
                    .filter(Boolean);
                const composerTextLength = composerTexts.reduce((max, text) => Math.max(max, text.length), 0);
                const composerHasStartTag = Boolean(startTag && composerTexts.some((text) => text.includes(startTag)));
                const composerHasEnvelope = composerHasStartTag || composerTexts.some((text) => /\[\[?BEGIN\s*:/i.test(text));
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], [aria-label]')).filter(visible);
                const hasStop = buttons.some((button) => {
                    const label = [
                        button.getAttribute('aria-label'),
                        button.getAttribute('title'),
                        button.innerText,
                        button.textContent
                    ].filter(Boolean).join(' ').toLowerCase();
                    return label.includes('stop') || label.includes('停止') || label.includes('中斷') || label.includes('停止生成');
                });
                const hasDisabledSend = buttons.some((button) => {
                    const label = [
                        button.getAttribute('aria-label'),
                        button.getAttribute('title'),
                        button.innerText,
                        button.textContent
                    ].filter(Boolean).join(' ').toLowerCase();
                    const looksLikeSend = label.includes('send message') ||
                        label.includes('傳送訊息') ||
                        label.includes('送出訊息') ||
                        label.includes('發送訊息') ||
                        label.includes('submit message') ||
                        label.includes('send') ||
                        label.includes('傳送') ||
                        label.includes('送出');
                    if (!looksLikeSend) return false;
                    return button.disabled || button.getAttribute('aria-disabled') === 'true';
                });

                const isEditableNode = (el) => {
                    if (!el) return false;
                    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
                    if (el.isContentEditable) return true;
                    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return true;
                    return false;
                };
                const isResponseNode = (el) => {
                    if (!el) return false;
                    if (isEditableNode(el)) return false;
                    return (responseContainers || []).some((selector) => {
                        try { return Boolean(el.closest(selector)); } catch (_) { return false; }
                    });
                };

                let responseChanged = false;
                let responseFromNonEditable = false;
                if (responseSelector) {
                    try {
                        const responses = Array.from(document.querySelectorAll(responseSelector));
                        const semanticCandidates = responses.filter((node) => isResponseNode(node));
                        const latest = (semanticCandidates.length ? semanticCandidates : responses).slice(-1)[0] || null;
                        const latestText = textOf(latest);
                        responseFromNonEditable = Boolean(latest && !isEditableNode(latest));
                        responseChanged = Boolean(
                            latestText &&
                            latestText !== baseline &&
                            responseFromNonEditable &&
                            (!startTag || latestText.includes(startTag) || latestText.length > String(baseline || '').length + 20)
                        );
                    } catch (_) { }
                }

                const composerLikelyCleared = composerTextLength === 0;
                const responseSignal = responseChanged && responseFromNonEditable;
                const matchedSignals =
                    (hasStop ? 1 : 0) +
                    (hasDisabledSend ? 1 : 0) +
                    (responseSignal ? 1 : 0) +
                    (composerLikelyCleared ? 1 : 0);

                return {
                    composerCount: editors.length,
                    composerTextLength,
                    composerHasStartTag,
                    composerHasEnvelope,
                    hasStop,
                    hasDisabledSend,
                    responseChanged,
                    responseFromNonEditable,
                    responseSignal,
                    composerLikelyCleared,
                    matchedSignals
                };
            }, {
                responseSelector: options.responseSelector || '',
                baseline: options.baseline || '',
                startTag: options.startTag || '',
                editorSelector: this._getComposerSelectors().join(', '),
                responseContainers: Array.isArray(this.backendDefinition.responseContainerSelectors)
                    ? this.backendDefinition.responseContainerSelectors
                    : ['model-response', '.model-response-text', '.message-content', '[data-message-id]', '.conversation-turn'],
            }).catch(() => ({
                composerCount: 0,
                composerTextLength: 1,
                composerHasStartTag: Boolean(options.startTag),
                composerHasEnvelope: Boolean(options.startTag),
                hasStop: false,
                hasDisabledSend: false,
                responseChanged: false,
                responseFromNonEditable: false,
                responseSignal: false,
                composerLikelyCleared: false,
                matchedSignals: 0
            }));

            const safeState = state || {
                composerCount: 0,
                composerTextLength: 1,
                composerHasStartTag: Boolean(options.startTag),
                composerHasEnvelope: Boolean(options.startTag),
                hasStop: false,
                hasDisabledSend: false,
                responseChanged: false,
                responseFromNonEditable: false,
                responseSignal: false,
                composerLikelyCleared: false,
                matchedSignals: 0
            };
            if (this.backendDefinition.id === 'm365-web' && options.startTag) {
                // M365 can expose transient disabled/stop controls that look
                // like acceptance even when the full Golem envelope remains in
                // the composer. The current envelope must first disappear.
                if (safeState.composerHasStartTag || safeState.composerHasEnvelope) {
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }
                if (safeState.composerCount > 0 && safeState.composerLikelyCleared) {
                    return true;
                }
            }
            if (safeState.hasStop) {
                return true;
            }
            if (safeState.hasDisabledSend && safeState.composerTextLength < 40) {
                return true;
            }
            if (safeState.matchedSignals >= 2) {
                return true;
            }
            await new Promise(r => setTimeout(r, 300));
        }
        return false;
    }

    _computeSendAcceptTimeout(payloadLength = 0, explicitTimeoutMs = null) {
        if (Number.isFinite(Number(explicitTimeoutMs)) && Number(explicitTimeoutMs) > 0) {
            return Number(explicitTimeoutMs);
        }
        const len = Number(payloadLength) || 0;
        if (len >= 50000) return 12000;
        if (len >= 25000) return 9000;
        if (len >= 12000) return 7500;
        if (len >= 5000) return 6500;
        return 5000;
    }

    _computeSendReadyTimeout(payloadLength = 0, explicitTimeoutMs = null) {
        if (Number.isFinite(Number(explicitTimeoutMs)) && Number(explicitTimeoutMs) > 0) {
            return Number(explicitTimeoutMs);
        }
        const len = Number(payloadLength) || 0;
        if (len >= 25000) return 15000;
        if (len >= 12000) return 12000;
        if (len >= 5000) return 8000;
        return 5000;
    }

    async clearComposerDraft() {
        const editorSelector = this._getComposerSelectors().join(', ');
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const focusedComposer = await this._focusBestComposer(editorSelector);
                if (focusedComposer && focusedComposer.ok && Number.isFinite(focusedComposer.x) && Number.isFinite(focusedComposer.y) && this.page.mouse) {
                    await this.page.mouse.click(focusedComposer.x, focusedComposer.y);
                }
                const isMac = process.platform === 'darwin';
                await this.page.keyboard.press(isMac ? 'Meta+A' : 'Control+A').catch(() => {});
                await new Promise(r => setTimeout(r, 70));
                await this.page.keyboard.press('Backspace').catch(() => {});
                await this.page.keyboard.press('Delete').catch(() => {});
                await new Promise(r => setTimeout(r, 180));
                const state = await this._inspectComposerDraftState('').catch(() => ({ hasDraft: true, length: 9999 }));
                if (!state.hasDraft || state.length === 0) {
                    console.log(`🧹 [PageInteractor] 已清空 ${this.backendLabel} 草稿框。`);
                    return true;
                }
            } catch (_) { }
        }
        console.warn('⚠️ [PageInteractor] 草稿框清空失敗，可能需要使用者手動清除。');
        return false;
    }

    /**
     * 🚀 自動將 Chrome 視窗移動到螢幕最底部 (不影響使用者日常操作) - Playwright 版
     */
    async _moveWindowToBottom() {
        // ✨ [Headless 優化] 若為無頭模式，不需要移動視窗
        if (process.env.PLAYWRIGHT_HEADLESS === 'true') return;
        // M365 登入/MFA 與租戶提示必須保持對使用者可見。
        if (this.backendDefinition.id === 'm365-web') return;

        try {
            console.log("⚓ [PageInteractor] 正在將 Chrome 視窗自動移動至隱藏位置...");
            
            // 複用 CDPSession 以提升效能
            if (!this._persistedCdpSession) {
                this._persistedCdpSession = await this.page.context().newCDPSession(this.page);
            }
            const session = this._persistedCdpSession;

            // Playwright 中 getWindowForTarget 標籤可能略有不同，但協議本身一致
            const { windowId } = await session.send('Browser.getWindowForTarget');

            const screen = await this.page.evaluate(() => ({
                width: window.screen.availWidth,
                height: window.screen.availHeight
            }));

            // 將視窗移動到螢幕垂直座標之外 (隱身術)
            await session.send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                    left: 0,
                    top: screen.height + 1000,
                    width: 50,
                    height: 50,
                    windowState: 'normal'
                }
            });
            // 註: 不再呼叫 await session.detach()，保留給下次視窗移動時使用
            console.log("✅ [PageInteractor] 視窗已成功移動。");
        } catch (e) {
            console.warn(`⚠️ [PageInteractor] 視窗移動失敗: ${e.message}`);
        }
    }

    /**
     * 🌟 幽靈按鈕點擊術：加裝防禦機制的升級版
     */
    async _autoClickWorkspaceButtons() {
        try {
            console.log("🕵️ [PageInteractor] 啟動幽靈掃描，尋找是否需要點擊【儲存/建立】按鈕...");

            await new Promise(r => setTimeout(r, 1500));

            const clickedButtonText = await this.page.evaluate((keywords) => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], a.btn'));

                for (let i = buttons.length - 1; i >= 0; i--) {
                    const btn = buttons[i];

                    // 🛡️ 防禦 1：禁止觸摸側邊欄 (避開歷史紀錄)
                    if (btn.closest('nav') || btn.closest('aside') || btn.closest('sidenav')) {
                        continue;
                    }

                    const text = (btn.innerText || btn.textContent || "").trim();

                    // 🛡️ 防禦 2：長度限制 (按鈕文字通常很短，超過 15 字必定是標題)
                    if (text.length > 15 || text.length === 0) {
                        continue;
                    }

                    if (keywords.some(kw => text === kw || text.includes(kw))) {
                        btn.click();
                        return text;
                    }
                }
                return null;
            }, WORKSPACE_SAVE_KEYWORDS);

            if (clickedButtonText) {
                console.log(`🎯 [PageInteractor] 幽靈突刺成功！已自動幫忙點擊：【${clickedButtonText}】`);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                console.log("👻 [PageInteractor] 掃描完畢，沒有發現需要自動點擊的卡片按鈕。");
            }

        } catch (e) {
            console.warn(`⚠️ [PageInteractor] 幽靈掃描發生異常: ${e.message}`);
        }
    }

    async _attachM365Files(attachment) {
        const fs = require('fs');
        const crypto = require('crypto');
        const files = Array.isArray(attachment && attachment.files) ? attachment.files : [];
        if (attachment.validatedByM365Harness !== true || files.length === 0 || files.length > 10) {
            const error = new Error('M365 attachment batch is missing a trusted file manifest.');
            error.code = 'M365_ATTACHMENT_UNTRUSTED';
            throw error;
        }

        const filePaths = [];
        const fileNames = [];
        for (const file of files) {
            const filePath = String(file && file.path || '');
            const fileName = String(file && file.name || '');
            if (!filePath || !fileName || !fs.existsSync(filePath)) {
                const error = new Error('A staged M365 attachment is unavailable.');
                error.code = 'M365_ATTACHMENT_STAGE_INVALID';
                throw error;
            }
            const stat = fs.lstatSync(filePath);
            const expectedHash = String(file && file.sha256 || '').toLowerCase();
            const actualHash = stat.isFile() && !stat.isSymbolicLink()
                ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
                : '';
            if (!stat.isFile() || stat.isSymbolicLink() || Number(file.size) !== stat.size
                || !/^[0-9a-f]{64}$/.test(expectedHash) || actualHash !== expectedHash) {
                const error = new Error('A staged M365 attachment changed before upload.');
                error.code = 'M365_ATTACHMENT_STAGE_INVALID';
                throw error;
            }
            filePaths.push(filePath);
            fileNames.push(fileName);
        }

        const markerSelectors = [
            '[data-testid*="attachment" i]',
            '[data-testid*="upload" i]',
            '[class*="attachment" i]',
            '[aria-label*="remove attachment" i]',
            '[aria-label*="移除附件"]',
            '[aria-label*="移除檔案"]',
        ];
        const baseline = await this.page.evaluate(({ names, selectors }) => {
            const visible = (node) => {
                if (!node || !(node instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && style.display !== 'none'
                    && style.visibility !== 'hidden' && style.opacity !== '0';
            };
            const bodyText = document.body ? (document.body.innerText || '') : '';
            const nameCounts = names.map((name) => bodyText.split(name).length - 1);
            let markerCount = 0;
            for (const selector of selectors) {
                try {
                    markerCount += Array.from(document.querySelectorAll(selector)).filter(visible).length;
                } catch (_) { }
            }
            return { nameCounts, markerCount };
        }, { names: fileNames, selectors: markerSelectors });

        let selected = false;
        const inputs = this.page.locator('input[type="file"]');
        const inputCount = await inputs.count().catch(() => 0);
        for (let index = inputCount - 1; index >= 0 && !selected; index -= 1) {
            const input = inputs.nth(index);
            const disabled = await input.isDisabled().catch(() => true);
            if (disabled) continue;
            try {
                await input.setInputFiles(filePaths);
                selected = true;
            } catch (_) { }
        }

        if (!selected) {
            const uploadButtons = this.page.locator([
                'button[aria-label*="Attach" i]',
                'button[aria-label*="Upload" i]',
                'button[title*="Attach" i]',
                'button[title*="Upload" i]',
                'button[aria-label*="附加"]',
                'button[aria-label*="上傳"]',
                '[role="button"][aria-label*="Attach" i]',
                '[role="button"][aria-label*="Upload" i]',
            ].join(', '));
            const buttonCount = await uploadButtons.count().catch(() => 0);
            for (let index = buttonCount - 1; index >= 0 && !selected; index -= 1) {
                const button = uploadButtons.nth(index);
                if (!await button.isVisible().catch(() => false)) continue;
                try {
                    const [chooser] = await Promise.all([
                        this.page.waitForEvent('filechooser', { timeout: 5000 }),
                        button.click(),
                    ]);
                    await chooser.setFiles(filePaths);
                    selected = true;
                } catch (_) { }
            }
        }

        // M365 Copilot Chat also accepts pasted files. Preserve the original
        // Golem clipboard technique as a conservative fallback for one file;
        // multi-file and folder uploads stay on the native file chooser path.
        if (!selected && files.length === 1) {
            const file = files[0];
            const base64 = fs.readFileSync(file.path).toString('base64');
            const inputSelector = this.backendDefinition
                && this.backendDefinition.selectors
                && this.backendDefinition.selectors.input;
            selected = await this.page.evaluate(async ({ selector, payload, name, mimeType }) => {
                let target = null;
                try { target = document.querySelector(selector); } catch (_) { }
                if (!target) return false;
                const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
                const pastedFile = new File([bytes], name, { type: mimeType || 'application/octet-stream' });
                const clipboardData = new DataTransfer();
                clipboardData.items.add(pastedFile);
                const event = new ClipboardEvent('paste', {
                    clipboardData,
                    bubbles: true,
                    cancelable: true,
                });
                target.focus();
                target.dispatchEvent(event);
                return true;
            }, {
                selector: inputSelector,
                payload: base64,
                name: file.name,
                mimeType: file.mimeType,
            }).catch(() => false);
        }

        if (!selected) {
            const error = new Error('Microsoft 365 Copilot Chat file upload control was not found.');
            error.code = 'M365_ATTACHMENT_UPLOAD_FAILED';
            throw error;
        }

        const confirmed = await this.page.waitForFunction(({ names, selectors, before }) => {
            const visible = (node) => {
                if (!node || !(node instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && style.display !== 'none'
                    && style.visibility !== 'hidden' && style.opacity !== '0';
            };
            const bodyText = document.body ? (document.body.innerText || '') : '';
            const allNamesAdded = names.every((name, index) => (
                bodyText.split(name).length - 1
            ) > Number(before.nameCounts[index] || 0));
            let markerCount = 0;
            for (const selector of selectors) {
                try {
                    markerCount += Array.from(document.querySelectorAll(selector)).filter(visible).length;
                } catch (_) { }
            }
            return allNamesAdded || markerCount >= Number(before.markerCount || 0) + names.length;
        }, { names: fileNames, selectors: markerSelectors, before: baseline }, { timeout: 20000 })
            .then(() => true)
            .catch(() => false);

        if (!confirmed) {
            const error = new Error('Files were selected, but Microsoft 365 Copilot did not visibly confirm every attachment.');
            error.code = 'M365_ATTACHMENT_NOT_CONFIRMED';
            throw error;
        }
        console.log(`✅ [PageInteractor] M365 已在可見頁面確認 ${fileNames.length} 個附件。`);
    }

    /**
     * 📋 模擬人類貼上附件 (Clipboard Paste Technique)
     * @param {string} targetSelector - 貼上的目標輸入框
     * @param {string} filePath - 本地檔案路徑
     * @param {string} mimeType - 檔案類型
     */
    async _attachFile(targetSelector, filePath, mimeType) {
        console.log(`📋 [PageInteractor] 正在讀取並模擬貼上附件: ${filePath} (${mimeType || 'unknown'})`);
        
        try {
            const fs = require('fs');
            const path = require('path');
            if (!fs.existsSync(filePath)) {
                throw new Error(`找不到檔案: ${filePath}`);
            }

            const buffer = fs.readFileSync(filePath);
            const fileName = path.basename(filePath);
            
            // 如果沒帶 mimeType，則根據副檔名做最後保險 (Gemini 對文件的 mimetype 比較敏感)
            let resolvedMimeType = mimeType;
            if (!resolvedMimeType) {
                const ext = path.extname(fileName).toLowerCase();
                const mimeMap = {
                    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
                    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
                    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    '.js': 'text/javascript', '.py': 'text/x-python', '.json': 'application/json'
                };
                resolvedMimeType = mimeMap[ext] || 'application/octet-stream';
            }
            
            // 🚀 將 Buffer 轉換為 Base64 以便傳入 evaluate
            const base64 = buffer.toString('base64');

            await this.page.evaluate(async ({ s, b64, name, type }) => {
                const el = document.querySelector(s);
                if (!el) throw new Error("找不到貼上目標選取器");

                // 1. 將 Base64 轉回 Blob & File
                const byteCharacters = atob(b64);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type });
                const file = new File([blob], name, { type });

                // 2. 建立 DataTransfer 並模擬貼上事件
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);

                const event = new ClipboardEvent('paste', {
                    clipboardData: dataTransfer,
                    bubbles: true,
                    cancelable: true
                });

                el.focus();
                el.dispatchEvent(event);
            }, { s: targetSelector, b64: base64, name: fileName, type: resolvedMimeType });

            console.log(`✅ [PageInteractor] 附件 [${fileName}] 已模擬貼入，等待 UI 反映...`);
            await new Promise(r => setTimeout(r, 1500)); // 等待預覽圖/檔案圖示出現
        } catch (e) {
            console.error(`❌ [PageInteractor] 附件貼上失敗: ${e.message}`);
        }
    }

    /**
     * 🛡️ 頁面空閒檢查術：確保沒有正在生成的訊息或遮罩
     */
    async _waitForReady(sendSelector, options = {}) {
        console.log("🔍 [PageInteractor] 正在檢查頁面空閒狀態...");
        const configuredWait = Number(options.readyTimeoutMs);
        const maxWait = Number.isFinite(configuredWait) && configuredWait > 0
            ? configuredWait
            : 15000;
        const startTime = Date.now();
        let lastBusyLogAt = 0;
        const semanticBusySelectors = Array.isArray(this.backendDefinition.stopSelectors)
            ? this.backendDefinition.stopSelectors
            : [];

        while (Date.now() - startTime < maxWait) {
            const isBusy = await this.page.evaluate((busySelectors) => {
                const isVisible = (node) => {
                    if (!node) return false;
                    const style = window.getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 &&
                        style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                };
                for (const selector of busySelectors || []) {
                    try {
                        if (Array.from(document.querySelectorAll(selector)).some(isVisible)) return true;
                    } catch (_) { }
                }

                // 尋找「停止」按鈕或特定的正在處理標記
                const stopButtons = Array.from(document.querySelectorAll('button, [role="button"], [data-test-id*="stop"], .stop-button, [aria-label*="stop" i]'))
                    .filter(b => {
                        const txt = (b.innerText || b.textContent || "").trim();
                        const label = (b.getAttribute('aria-label') || "").trim();
                        const stopTexts = ['停止', 'Stop', '中斷', 'Stop generating'];
                        return stopTexts.includes(txt) || stopTexts.some(s => label.includes(s)) || (label && label.toLowerCase().includes('stop'));
                    });

                // 如果有停止按鈕，代表還在跑
                if (stopButtons.length > 0) {
                    const isAnyVisible = stopButtons.some(isVisible);
                    if (isAnyVisible) return true;
                }

                return false;
            }, semanticBusySelectors);

            if (!isBusy) {
                console.log("✅ [PageInteractor] 頁面已空閒，準備發送。");
                return;
            }

            if (Date.now() - lastBusyLogAt > 10000) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                console.log(`⏳ [PageInteractor] ${this.backendLabel} 仍在生成/停止狀態，先不塞新草稿 (${elapsed}s/${Math.round(maxWait / 1000)}s)...`);
                lastBusyLogAt = Date.now();
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        if (this.backendDefinition.id === 'm365-web') {
            const busyError = new Error('Microsoft 365 Copilot Chat 仍顯示正在產生回覆。為避免把新訊息送進忙碌中的對話，POC 已停止；請先查看 Edge 頁面。');
            busyError.code = 'M365_UI_BUSY';
            throw busyError;
        }
        console.warn(`⚠️ [PageInteractor] ${this.backendLabel} 忙碌檢查超時；DOM 狀態可能殘留，改交由實際 composer/send button 狀態判斷。`);
    }

    /**
     * 處理圖片上傳
     * @param {string} uploadSelector 
     * @param {string} filePath 
     */
    async _handleUpload(uploadSelector, filePath) {
        console.log(`📸 [PageInteractor] 正在嘗試上傳圖片: ${filePath}`);
        
        try {
            // 🚀 尋找隱藏的 file input
            let fileInput = await this.page.$('input[type="file"]');
            
            if (!fileInput) {
                console.log("🚑 找不到標準 input[type='file']，嘗試點擊上傳按鈕啟動元件...");
                const uploadBtn = await this.page.$(uploadSelector);
                if (uploadBtn) {
                    await uploadBtn.click();
                    await new Promise(r => setTimeout(r, 1000));
                    fileInput = await this.page.$('input[type="file"]');
                }
            }

            if (!fileInput) {
                throw new Error("找不到檔案上傳元件 (input[type='file'])");
            }

            // 📤 執行上傳
            await fileInput.setInputFiles(filePath);
            console.log("✅ [PageInteractor] 檔案已選擇，等待上傳預覽...");

            // ⏳ 等待預覽圖出現 (Gemini 通常會顯示一個縮圖或刪除按鈕)
            await this.page.waitForSelector('button[aria-label*="移除"], button[aria-label*="Remove"], .thumbnail, mat-chip', {
                state: 'attached',
                timeout: 10000
            }).catch(() => {
                console.warn("⚠️ [PageInteractor] 等待上傳預覽超時，將嘗試繼續流程。");
            });

            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            console.error(`❌ [PageInteractor] 圖片上傳失敗: ${e.message}`);
            // 不要拋出錯誤，讓流程嘗試繼續 (可能有文字訊息)
        }
    }

    async _healSelector(type, selectors) {
        if (this.backendDefinition.allowExternalSelectorHealing === false) {
            return false;
        }
        try {
            const htmlDump = await this.page.content();
            const newSelector = await this.doctor.diagnose(htmlDump, type);
            if (newSelector) {
                selectors[type] = PageInteractor.cleanSelector(newSelector);
                this.doctor.saveSelectors(selectors);
                return true;
            }
        } catch (e) {
            console.warn(`⚠️ [Doctor] ${type} 修復失敗: ${e.message}`);
        }
        return false;
    }

    /**
     * 🧹 物理修剪 DOM (DOM Pruning)
     * 移除畫面中過舊的對話泡泡，防止長時間對話導致 Chromium 渲染進程吃光記憶體
     */
    async _pruneDOM() {
        // 不修改 M365 應用程式持有的對話 DOM；避免破壞其狀態管理與合規提示。
        if (this.backendDefinition.id === 'm365-web') return;
        try {
            console.log("🧹 [PageInteractor] 正在物理修剪頁面 DOM 結構以釋放記憶體...");
            await this.page.evaluate(() => {
                // 涵蓋 Gemini 與主流大模型的前端對話節點特徵
                const chatNodes = document.querySelectorAll('message-content, model-response, user-message, .message-row, .conversation-turn');
                
                if (chatNodes.length <= 6) return; // 至少保留最後 6 個節點 (剛好是一兩組合法對話視窗)
                
                // 保留最後 6 個，其餘砍掉
                for (let i = 0; i < chatNodes.length - 6; i++) {
                    const node = chatNodes[i];
                    if (node && node.parentNode) {
                        // 往上找最高層級的包裝器
                        const wrapper = node.closest('.message-row') || node.closest('.conversation-turn') || node.closest('.chat-message-group') || node;
                        if (wrapper && wrapper.parentNode) {
                            wrapper.parentNode.removeChild(wrapper);
                        }
                    }
                }
            });
            console.log("✅ [PageInteractor] DOM 修剪完成，節點已釋放。");
        } catch (e) {
            console.warn(`⚠️ [PageInteractor] DOM 修剪失敗: ${e.message}`);
        }
    }
}

module.exports = PageInteractor;
