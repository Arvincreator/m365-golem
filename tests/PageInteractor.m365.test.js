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

    test('reuses the original Golem send reinforcement when the first M365 click leaves the draft in place', async () => {
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

        expect(interactor._tryClickSendButton).toHaveBeenCalledTimes(2);
        expect(interactor._performSendClick).toHaveBeenCalledTimes(2);
        expect(keyboardFallback).not.toHaveBeenCalled();
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
        jest.spyOn(interactor, '_pressSubmitKeys').mockResolvedValue();

        await expect(interactor._clickSend('button[aria-label="Send"]', {
            payloadLength: 20,
            startTag: '[[BEGIN:test]]',
        })).rejects.toMatchObject({ code: 'M365_SEND_UNCONFIRMED' });

        expect(interactor._tryClickSendButton).toHaveBeenCalledTimes(2);
        expect(interactor._performSendClick).toHaveBeenCalledTimes(2);
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
});
