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
