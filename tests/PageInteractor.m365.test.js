const fs = require('fs');
const os = require('os');
const path = require('path');
const PageInteractor = require('../src/core/PageInteractor');
const { getWebBackendDefinition } = require('../src/core/web_backends');
const { ResponseExtractor } = require('../packages/protocol');

describe('PageInteractor M365 safety behavior', () => {
    const definition = getWebBackendDefinition('m365-web', {
        M365_POC_SAFE_MODE: true,
        M365_LOCAL_MEMORY_ENABLED: false,
        M365_ACTIONS_ENABLED: false,
    });

    function locatorGroup(items) {
        return {
            count: jest.fn().mockResolvedValue(items.length),
            nth: jest.fn((index) => items[index]),
        };
    }

    test('switches the visible M365 response mode and verifies the trigger label', async () => {
        const state = { triggerText: '自動', expanded: false };
        const trigger = {
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn(() => Promise.resolve(state.triggerText)),
            getAttribute: jest.fn((name) => Promise.resolve(
                name === 'aria-expanded' ? String(state.expanded) : (name === 'aria-label' ? '模型選取器' : null)
            )),
            click: jest.fn().mockImplementation(async () => {
                state.expanded = !state.expanded;
            }),
        };
        const makeOption = (text, mode) => ({
            isVisible: jest.fn(() => Promise.resolve(state.expanded)),
            innerText: jest.fn().mockResolvedValue(text),
            getAttribute: jest.fn().mockResolvedValue(null),
            click: jest.fn().mockImplementation(async () => {
                state.triggerText = mode;
                state.expanded = false;
            }),
        });
        const options = [
            makeOption('自動\n決定思考多久', '自動'),
            makeOption('快速回應\n立即提供解答', '快速回應'),
            makeOption('深度思考\n思考更久以提供更好的解答', '深度思考'),
        ];
        const page = {
            locator: jest.fn((selector) => selector === '[role="menuitemradio"]'
                ? locatorGroup(options)
                : locatorGroup([trigger])),
        };
        const interactor = new PageInteractor(page, {}, definition);

        await expect(interactor._ensureM365ResponseMode('thoughtful')).resolves.toEqual({
            ok: true,
            requested: 'thoughtful',
            observed: 'thoughtful',
            changed: true,
        });

        expect(trigger.click).toHaveBeenCalledTimes(1);
        expect(options[2].click).toHaveBeenCalledTimes(1);
        expect(options[0].click).not.toHaveBeenCalled();
        expect(options[1].click).not.toHaveBeenCalled();
    });

    test('closes an already-open native mode menu before typing when the selected mode is unchanged', async () => {
        const state = { expanded: true };
        const trigger = {
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue('自動'),
            getAttribute: jest.fn((name) => Promise.resolve(
                name === 'aria-expanded' ? String(state.expanded) : (name === 'aria-label' ? '模型選取器' : null)
            )),
            click: jest.fn().mockImplementation(async () => {
                state.expanded = false;
            }),
        };
        const page = { locator: jest.fn(() => locatorGroup([trigger])) };
        const interactor = new PageInteractor(page, {}, definition);

        await expect(interactor._ensureM365ResponseMode('auto')).resolves.toEqual({
            ok: true,
            requested: 'auto',
            observed: 'auto',
            changed: false,
        });
        expect(trigger.click).toHaveBeenCalledTimes(1);
    });

    test('waits for the M365 response-mode button when the composer renders first', async () => {
        let triggerPolls = 0;
        const trigger = {
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue('自動'),
            getAttribute: jest.fn().mockResolvedValue(null),
            click: jest.fn(),
        };
        const page = {
            locator: jest.fn((selector) => {
                if (selector === '[role="menuitemradio"]') return locatorGroup([]);
                return {
                    count: jest.fn().mockImplementation(async () => {
                        triggerPolls += 1;
                        return triggerPolls === 1 ? 0 : 1;
                    }),
                    nth: jest.fn(() => trigger),
                };
            }),
        };
        const transientDefinition = {
            ...definition,
            responseModeSelectors: {
                ...definition.responseModeSelectors,
                waitTimeoutMs: 50,
                pollIntervalMs: 1,
            },
        };
        const interactor = new PageInteractor(page, {}, transientDefinition);

        await expect(interactor._ensureM365ResponseMode('auto')).resolves.toEqual({
            ok: true,
            requested: 'auto',
            observed: 'auto',
            changed: false,
        });
        expect(triggerPolls).toBeGreaterThanOrEqual(2);
        expect(trigger.click).not.toHaveBeenCalled();
    });

    test('detects and closes the live M365 menu even when aria-expanded is absent', async () => {
        const state = { menuOpen: true };
        const trigger = {
            isVisible: jest.fn().mockResolvedValue(true),
            innerText: jest.fn().mockResolvedValue('自動'),
            getAttribute: jest.fn().mockResolvedValue(null),
            click: jest.fn().mockImplementation(async () => {
                state.menuOpen = false;
            }),
        };
        const visibleOption = {
            isVisible: jest.fn(() => Promise.resolve(state.menuOpen)),
            innerText: jest.fn().mockResolvedValue('自動\n決定思考多久'),
            getAttribute: jest.fn().mockResolvedValue(null),
        };
        const page = {
            locator: jest.fn((selector) => selector === '[role="menuitemradio"]'
                ? locatorGroup([visibleOption])
                : locatorGroup([trigger])),
        };
        const interactor = new PageInteractor(page, {}, definition);

        await expect(interactor._ensureM365ResponseMode('auto')).resolves.toEqual({
            ok: true,
            requested: 'auto',
            observed: 'auto',
            changed: false,
        });
        expect(trigger.click).toHaveBeenCalledTimes(1);
    });

    test('accepts an already-selected hidden response mode in a narrow Word preview layout', async () => {
        const trigger = {
            isVisible: jest.fn().mockResolvedValue(false),
            innerText: jest.fn().mockResolvedValue('自動'),
            getAttribute: jest.fn((name) => Promise.resolve(
                name === 'aria-expanded' ? 'false' : (name === 'aria-label' ? '模型選取器' : null)
            )),
            click: jest.fn(),
        };
        const page = {
            locator: jest.fn((selector) => selector === '[role="menuitemradio"]'
                ? locatorGroup([])
                : locatorGroup([trigger])),
        };
        const interactor = new PageInteractor(page, {}, definition);

        await expect(interactor._ensureM365ResponseMode('auto')).resolves.toEqual({
            ok: true,
            requested: 'auto',
            observed: 'auto',
            changed: false,
        });
        expect(trigger.click).not.toHaveBeenCalled();
    });

    test('does not accept a hidden response-mode control when it shows a different mode', async () => {
        const trigger = {
            isVisible: jest.fn().mockResolvedValue(false),
            innerText: jest.fn().mockResolvedValue('快速回應'),
            getAttribute: jest.fn().mockResolvedValue(null),
        };
        const page = { locator: jest.fn(() => locatorGroup([trigger])) };
        const narrowDefinition = {
            ...definition,
            responseModeSelectors: {
                ...definition.responseModeSelectors,
                waitTimeoutMs: 1,
                pollIntervalMs: 1,
            },
        };
        const interactor = new PageInteractor(page, {}, narrowDefinition);

        await expect(interactor._ensureM365ResponseMode('auto')).rejects.toMatchObject({
            code: 'M365_RESPONSE_MODE_UNAVAILABLE',
        });
    });

    test('stops before reading or typing when M365 cannot confirm the queued response mode', async () => {
        const page = {};
        const interactor = new PageInteractor(page, {}, definition);
        jest.spyOn(interactor, '_waitForReady').mockResolvedValue();
        const modeError = new Error('mode unavailable');
        modeError.code = 'M365_RESPONSE_MODE_UNAVAILABLE';
        jest.spyOn(interactor, '_ensureM365ResponseMode').mockRejectedValue(modeError);
        const capture = jest.spyOn(interactor, '_captureBaseline').mockResolvedValue('old reply');
        const type = jest.spyOn(interactor, '_typeInput').mockResolvedValue();
        const send = jest.spyOn(interactor, '_clickSend').mockResolvedValue();
        jest.spyOn(interactor, '_healSelector').mockResolvedValue(false);

        await expect(interactor.interact(
            'payload',
            definition.selectors,
            false,
            '[[BEGIN:test]]',
            '[[END:test]]',
            0,
            null,
            { m365ResponseMode: 'quick' }
        )).rejects.toMatchObject({ code: 'M365_RESPONSE_MODE_UNAVAILABLE' });

        expect(capture).not.toHaveBeenCalled();
        expect(type).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    test('applies the queued response mode before baseline capture and send', async () => {
        const page = {};
        const interactor = new PageInteractor(page, {}, definition);
        jest.spyOn(interactor, '_waitForReady').mockResolvedValue();
        const ensureMode = jest.spyOn(interactor, '_ensureM365ResponseMode').mockResolvedValue({ ok: true });
        const capture = jest.spyOn(interactor, '_captureBaseline').mockResolvedValue('old reply');
        jest.spyOn(interactor, '_typeInput').mockResolvedValue();
        const send = jest.spyOn(interactor, '_clickSend').mockResolvedValue();
        jest.spyOn(interactor, '_pruneDOM').mockResolvedValue();
        jest.spyOn(ResponseExtractor, 'waitForResponse').mockResolvedValue({
            status: 'FALLBACK_DIFF',
            text: 'new reply',
            attachments: [],
        });

        await interactor.interact(
            'payload',
            definition.selectors,
            false,
            '[[BEGIN:test]]',
            '[[END:test]]',
            0,
            null,
            { m365ResponseMode: 'quick' }
        );

        expect(ensureMode).toHaveBeenCalledWith('quick');
        expect(ensureMode.mock.invocationCallOrder[0]).toBeLessThan(capture.mock.invocationCallOrder[0]);
        expect(capture.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    });

    test('does not serialize tenant DOM for external selector healing', async () => {
        const page = { content: jest.fn().mockResolvedValue('<html>tenant content</html>') };
        const doctor = { diagnose: jest.fn(), saveSelectors: jest.fn() };
        const interactor = new PageInteractor(page, doctor, definition);

        await expect(interactor._healSelector('response', {})).resolves.toBe(false);
        expect(page.content).not.toHaveBeenCalled();
        expect(doctor.diagnose).not.toHaveBeenCalled();
    });

    test('keeps the visible M365 window in place for login and MFA', async () => {
        const page = { context: jest.fn(), evaluate: jest.fn() };
        const interactor = new PageInteractor(page, {}, definition);

        await interactor._moveWindowToBottom();

        expect(page.context).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    test('does not duplicate-submit when the current M365 envelope already cleared', async () => {
        const page = { mouse: { click: jest.fn() } };
        const interactor = new PageInteractor(page, {}, definition);
        jest.spyOn(interactor, '_focusBestComposer').mockResolvedValue(null);
        jest.spyOn(interactor, '_tryClickSendButton').mockResolvedValue({
            clicked: true,
            score: 150,
            label: 'Send message',
            x: 10,
            y: 10,
        });
        jest.spyOn(interactor, '_performSendClick').mockResolvedValue();
        jest.spyOn(interactor, '_waitForSendAccepted')
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        jest.spyOn(interactor, '_inspectComposerDraftState').mockResolvedValue({
            hasDraft: false,
            hasStartTag: false,
            length: 0,
        });
        jest.spyOn(interactor, '_moveWindowToBottom').mockResolvedValue();
        const keyboardFallback = jest.spyOn(interactor, '_pressSubmitKeys').mockResolvedValue();

        await expect(interactor._clickSend('button[aria-label="Send"]', {
            payloadLength: 20,
            startTag: '[[BEGIN:test]]',
        })).resolves.toBeUndefined();

        expect(interactor._tryClickSendButton).toHaveBeenCalledTimes(1);
        expect(interactor._performSendClick).toHaveBeenCalledTimes(1);
        expect(keyboardFallback).not.toHaveBeenCalled();
    });

    test('waits for a delayed M365 send button before falling back to Enter', async () => {
        const page = { mouse: { click: jest.fn() } };
        const interactor = new PageInteractor(page, {}, definition);
        jest.spyOn(interactor, '_focusBestComposer').mockResolvedValue(null);
        jest.spyOn(interactor, '_tryClickSendButton')
            .mockResolvedValueOnce({ clicked: false, reason: 'send-button-not-ready' })
            .mockResolvedValueOnce({
                clicked: true,
                score: 150,
                label: 'Send message',
                x: 10,
                y: 10,
            });
        jest.spyOn(interactor, '_performSendClick').mockResolvedValue();
        jest.spyOn(interactor, '_waitForSendAccepted').mockResolvedValue(true);
        jest.spyOn(interactor, '_inspectComposerDraftState').mockResolvedValue({
            hasDraft: false,
            hasStartTag: false,
            length: 0,
        });
        jest.spyOn(interactor, '_moveWindowToBottom').mockResolvedValue();
        const keyboardFallback = jest.spyOn(interactor, '_pressSubmitKeys').mockResolvedValue();

        await expect(interactor._clickSend('button[aria-label="Send"]', {
            payloadLength: 15000,
            sendReadyTimeoutMs: 1000,
            startTag: '[[BEGIN:test]]',
        })).resolves.toBeUndefined();

        expect(interactor._tryClickSendButton).toHaveBeenCalledTimes(2);
        expect(interactor._performSendClick).toHaveBeenCalledTimes(1);
        expect(keyboardFallback).not.toHaveBeenCalled();
    });

    test('atomically fills a long M365 envelope instead of splitting it across SPA rerenders', async () => {
        const payload = 'x'.repeat(15006);
        const fill = jest.fn().mockResolvedValue();
        const keyboard = {
            down: jest.fn().mockResolvedValue(),
            up: jest.fn().mockResolvedValue(),
            press: jest.fn().mockResolvedValue(),
            insertText: jest.fn().mockResolvedValue(),
            type: jest.fn().mockResolvedValue(),
        };
        const page = {
            $: jest.fn().mockResolvedValue({}),
            locator: jest.fn().mockReturnValue({ last: () => ({ fill }) }),
            keyboard,
            mouse: { click: jest.fn().mockResolvedValue() },
        };
        const interactor = new PageInteractor(page, {}, definition);
        jest.spyOn(interactor, '_focusBestComposer').mockResolvedValue({ ok: true, x: 10, y: 10 });
        jest.spyOn(interactor, '_readComposerState').mockResolvedValue({
            ok: true,
            tagName: 'SPAN',
            length: payload.length,
        });

        await expect(interactor._typeInput(definition.selectors.input, payload)).resolves.toBeUndefined();

        expect(fill).toHaveBeenCalledWith(payload, { timeout: 15000 });
        expect(keyboard.insertText).not.toHaveBeenCalled();
    });

    test('rejects a truncated M365 envelope before attempting to send it', async () => {
        const payload = 'x'.repeat(15006);
        const fill = jest.fn().mockResolvedValue();
        const keyboard = {
            down: jest.fn().mockResolvedValue(),
            up: jest.fn().mockResolvedValue(),
            press: jest.fn().mockResolvedValue(),
            insertText: jest.fn().mockResolvedValue(),
            type: jest.fn().mockResolvedValue(),
        };
        const page = {
            $: jest.fn().mockResolvedValue({}),
            locator: jest.fn().mockReturnValue({ last: () => ({ fill }) }),
            keyboard,
            mouse: { click: jest.fn().mockResolvedValue() },
            evaluate: jest.fn().mockResolvedValue({
                ok: true,
                method: 'exec-command',
                tagName: 'SPAN',
                length: 47,
            }),
        };
        const interactor = new PageInteractor(page, {}, definition);
        jest.spyOn(interactor, '_focusBestComposer').mockResolvedValue({ ok: true, x: 10, y: 10 });
        jest.spyOn(interactor, '_readComposerState').mockResolvedValue({
            ok: true,
            tagName: 'SPAN',
            length: 47,
        });

        await expect(interactor._typeInput(definition.selectors.input, payload))
            .rejects.toThrow('無法完整植入文字');

        expect(fill).toHaveBeenCalledWith(payload, { timeout: 15000 });
    });

    test('still requires reconciliation after the original send reinforcement cannot clear the M365 draft', async () => {
        const page = { mouse: { click: jest.fn() } };
        const interactor = new PageInteractor(page, {}, definition);
        jest.spyOn(interactor, '_focusBestComposer').mockResolvedValue(null);
        jest.spyOn(interactor, '_tryClickSendButton').mockResolvedValue({
            clicked: true,
            score: 150,
            label: 'Send message',
            x: 10,
            y: 10,
        });
        jest.spyOn(interactor, '_performSendClick').mockResolvedValue();
        jest.spyOn(interactor, '_waitForSendAccepted').mockResolvedValue(false);
        jest.spyOn(interactor, '_inspectComposerDraftState').mockResolvedValue({
            hasDraft: true,
            hasStartTag: true,
            length: 8900,
        });
        jest.spyOn(interactor, '_pressSubmitKeys').mockResolvedValue();

        await expect(interactor._clickSend('button[aria-label="Send"]', {
            payloadLength: 20,
            startTag: '[[BEGIN:test]]',
        })).rejects.toMatchObject({ code: 'M365_SEND_UNCONFIRMED' });

        expect(interactor._tryClickSendButton).toHaveBeenCalledTimes(1);
        expect(interactor._performSendClick).toHaveBeenCalledTimes(1);
        expect(interactor._pressSubmitKeys).toHaveBeenCalledTimes(1);
    });

    test('uses one Enter fallback when a text-only M365 envelope remains after the Send click', async () => {
        const page = { mouse: { click: jest.fn() } };
        const interactor = new PageInteractor(page, {}, definition);
        jest.spyOn(interactor, '_focusBestComposer').mockResolvedValue(null);
        jest.spyOn(interactor, '_waitForSendTarget').mockResolvedValue({
            clicked: true,
            score: 150,
            label: 'Submit message',
            x: 10,
            y: 10,
        });
        jest.spyOn(interactor, '_performSendClick').mockResolvedValue();
        jest.spyOn(interactor, '_waitForSendAccepted')
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        jest.spyOn(interactor, '_inspectComposerDraftState')
            .mockResolvedValueOnce({ hasDraft: true, hasStartTag: true, length: 8900 })
            .mockResolvedValueOnce({ hasDraft: false, hasStartTag: false, length: 0 });
        jest.spyOn(interactor, '_moveWindowToBottom').mockResolvedValue();
        const keyboardFallback = jest.spyOn(interactor, '_pressSubmitKeys').mockResolvedValue();

        await expect(interactor._clickSend('button[aria-label="Send"]', {
            payloadLength: 8900,
            startTag: '[[BEGIN:test]]',
            hasAttachment: false,
        })).resolves.toBeUndefined();

        expect(interactor._performSendClick).toHaveBeenCalledTimes(1);
        expect(keyboardFallback).toHaveBeenCalledTimes(1);
    });

    test('stops instead of sending into a busy M365 conversation', async () => {
        const page = { evaluate: jest.fn() };
        const interactor = new PageInteractor(page, {}, definition);
        const nowSpy = jest.spyOn(Date, 'now')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(2);

        await expect(interactor._waitForReady('', { readyTimeoutMs: 1 }))
            .rejects.toMatchObject({ code: 'M365_UI_BUSY' });
        expect(page.evaluate).not.toHaveBeenCalled();
        nowSpy.mockRestore();
    });

    test('checks M365 typing indicators before accepting another prompt', async () => {
        const page = { evaluate: jest.fn().mockResolvedValue(false) };
        const interactor = new PageInteractor(page, {}, definition);

        await interactor._waitForReady('', { readyTimeoutMs: 50 });

        expect(page.evaluate).toHaveBeenCalledWith(
            expect.any(Function),
            expect.arrayContaining([
                '[data-is-typing="true"]',
                '[data-activity="typing"]',
            ])
        );
    });

    test('passes the M365 unwrapped-response stability threshold to the extractor', async () => {
        const page = {};
        const interactor = new PageInteractor(page, {}, definition);
        jest.spyOn(interactor, '_waitForReady').mockResolvedValue();
        jest.spyOn(interactor, '_captureBaseline').mockResolvedValue('old reply');
        jest.spyOn(interactor, '_typeInput').mockResolvedValue();
        jest.spyOn(interactor, '_clickSend').mockResolvedValue();
        jest.spyOn(interactor, '_pruneDOM').mockResolvedValue();
        const extractor = jest.spyOn(ResponseExtractor, 'waitForResponse').mockResolvedValue({
            status: 'FALLBACK_DIFF',
            text: 'new reply',
            attachments: [],
            matchedSelector: '[data-testid="lastChatMessage"]',
        });

        await expect(interactor.interact(
            'payload',
            definition.selectors,
            false,
            '[[BEGIN:test]]',
            '[[END:test]]'
        )).resolves.toEqual(expect.objectContaining({ text: 'new reply' }));

        expect(extractor).toHaveBeenCalledWith(
            page,
            definition.selectors.response,
            '[[BEGIN:test]]',
            '[[END:test]]',
            'old reply',
            expect.objectContaining({ stableFallbackThreshold: 10 })
        );
    });

    test('uses the visible M365 file input and requires attachment confirmation', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-interactor-attachment-'));
        const filePath = path.join(tempDir, 'evidence.txt');
        fs.writeFileSync(filePath, 'evidence', 'utf8');
        const setInputFiles = jest.fn().mockResolvedValue();
        const fileInput = {
            isDisabled: jest.fn().mockResolvedValue(false),
            setInputFiles,
        };
        const page = {
            evaluate: jest.fn().mockResolvedValue({ nameCounts: [0], markerCount: 0 }),
            locator: jest.fn((selector) => {
                if (selector === 'input[type="file"]') {
                    return { count: jest.fn().mockResolvedValue(1), nth: jest.fn(() => fileInput) };
                }
                return { count: jest.fn().mockResolvedValue(0), nth: jest.fn() };
            }),
            waitForFunction: jest.fn().mockResolvedValue({}),
        };
        const interactor = new PageInteractor(page, {}, definition);

        try {
            await expect(interactor._attachM365Files({
                validatedByM365Harness: true,
                files: [{
                    name: 'evidence.txt',
                    path: filePath,
                    size: 8,
                    sha256: require('crypto').createHash('sha256').update('evidence').digest('hex'),
                }],
            })).resolves.toBeUndefined();
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }

        expect(setInputFiles).toHaveBeenCalledWith([filePath]);
        expect(page.waitForFunction).toHaveBeenCalled();
    });

    test('requires consecutive stable M365 upload-ready samples before sending an attachment', async () => {
        const page = {
            evaluate: jest.fn()
                .mockResolvedValueOnce({ errorText: '', pending: true, everyNameVisible: true })
                .mockResolvedValue({ errorText: '', pending: false, everyNameVisible: true }),
        };
        const interactor = new PageInteractor(page, {}, definition);
        const sendTarget = jest.spyOn(interactor, '_tryClickSendButton').mockResolvedValue({
            clicked: true,
            score: 150,
            label: 'Send message',
        });

        await expect(interactor._waitForM365AttachmentUploadReady({
            files: [{ name: 'evidence.txt' }],
        }, 'button[aria-label="Send"]', 1000, {
            minimumWaitMs: 0,
            stableSamples: 3,
            pollIntervalMs: 1,
        })).resolves.toBeUndefined();

        expect(page.evaluate).toHaveBeenCalledTimes(4);
        expect(sendTarget).toHaveBeenCalledTimes(3);
    });

    test('stops on an M365 attachment upload error before looking for the send button', async () => {
        const page = {
            evaluate: jest.fn().mockResolvedValue({
                errorText: '上傳失敗',
                pending: false,
                everyNameVisible: true,
            }),
        };
        const interactor = new PageInteractor(page, {}, definition);
        const sendTarget = jest.spyOn(interactor, '_tryClickSendButton');

        await expect(interactor._waitForM365AttachmentUploadReady({
            files: [{ name: 'evidence.txt' }],
        }, 'button[aria-label="Send"]', 1000, {
            minimumWaitMs: 0,
            stableSamples: 1,
            pollIntervalMs: 1,
        })).rejects.toMatchObject({ code: 'M365_ATTACHMENT_UPLOAD_FAILED' });

        expect(sendTarget).not.toHaveBeenCalled();
    });

    test('never falls back to Enter when an M365 attachment send button is not ready', async () => {
        const page = { mouse: { click: jest.fn() } };
        const interactor = new PageInteractor(page, {}, definition);
        jest.spyOn(interactor, '_focusBestComposer').mockResolvedValue(null);
        jest.spyOn(interactor, '_waitForSendTarget').mockResolvedValue({
            clicked: false,
            reason: 'send-button-not-ready',
        });
        const keyboardFallback = jest.spyOn(interactor, '_pressSubmitKeys').mockResolvedValue();

        await expect(interactor._clickSend('button[aria-label="Send"]', {
            payloadLength: 20,
            sendReadyTimeoutMs: 1,
            hasAttachment: true,
        })).rejects.toMatchObject({ code: 'M365_SEND_NOT_READY' });

        expect(keyboardFallback).not.toHaveBeenCalled();
    });

    test('rejects attachment manifests that did not pass the local harness boundary', async () => {
        const interactor = new PageInteractor({}, {}, definition);
        await expect(interactor._attachM365Files({
            validatedByM365Harness: false,
            files: [{ name: 'untrusted.txt', path: 'C:\\untrusted.txt', size: 1 }],
        })).rejects.toMatchObject({ code: 'M365_ATTACHMENT_UNTRUSTED' });
    });
});
