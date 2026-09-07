'use strict';

const fs = require('fs');
const path = require('path');

describe('M365 workspace UI regressions', () => {
    const read = (relativePath) => fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8').replace(/\r\n/g, '\n');

    test('clears stale project and conversation selections after the server tree is loaded', () => {
        const source = read('web-dashboard/src/app/dashboard/layout.tsx');
        expect(source).toContain('projectTreeLoaded');
        expect(source).toContain('clearSelection();');
        expect(source).toContain('if (!conversationExists) selectProject(activeProjectId);');
    });

    test('clears a prior chat error after valid context loads or the selection disappears', () => {
        const source = read('web-dashboard/src/app/dashboard/chat/page.tsx');
        expect(source).toContain('await Promise.all([loadMessages(), loadRuns(), loadPendingLocalActions(), loadPendingResponses()]);\n        if (ticket.current()) setError("");');
        expect(source).toContain('setPendingLocalActions([]);\n            setActionExecutionQueue([]);\n            setPendingResponses([]);\n            setError("");');
    });

    test('shows a friendly API message before a machine-readable error code', () => {
        const source = read('web-dashboard/src/lib/api-client.ts');
        expect(source).toContain('const candidates = [obj.message, obj.error, obj.detail];');
    });

    test('offers managed, create-new, and existing-folder project workspace modes', () => {
        const source = read('web-dashboard/src/app/dashboard/layout.tsx');
        expect(source).toContain('["managed", "Golem 預設位置"');
        expect(source).toContain('["create", "建立新資料夾"');
        expect(source).toContain('["existing", "連結既有資料夾"');
        expect(source).toContain('/api/m365/workspace/pick-folder');
    });

    test('keeps uploaded attachments distinct from indexed references in the composer', () => {
        const source = read('web-dashboard/src/app/dashboard/chat/page.tsx');
        expect(source).toContain('新增檔案');
        expect(source).toContain('新增資料夾');
        expect(source).toContain('選擇知識來源');
        expect(source).toContain('Prompt 指令池');
        expect(source).toContain('collectDroppedAttachmentCandidates');
        expect(source).toContain('node.setAttribute("webkitdirectory", "")');
        expect(source).toContain('onDrop={(event) => void handleAttachmentDrop(event)}');
        expect(source).toContain('M365 處理與送出結果以對話狀態為準');
    });

    test('sends expanded Prompt Pool shortcuts through the M365 workspace envelope', () => {
        const routeSource = read('web-dashboard/routes/api.chat.js');
        const runtimeSource = read('apps/runtime/index.js');
        expect(routeSource).toContain('m365PromptShortcutExpanded: shortcutExpansion.changed === true');
        expect(runtimeSource).toContain('const isPromptShortcutExpansion = ctx.m365PromptShortcutExpanded === true');
        expect(runtimeSource).toContain("? String(ctx.textOverride || '')");
    });

    test('uses the same response-mode labels as the visible M365 Copilot selector', () => {
        const source = read('web-dashboard/src/app/dashboard/chat/page.tsx');
        expect(source).toContain('<option value="auto">自動</option>');
        expect(source).toContain('<option value="quick">快速回應</option>');
        expect(source).toContain('<option value="thoughtful">仔細</option>');
        expect(source).not.toContain('<option value="thoughtful">自動思考</option>');
    });

    test('keeps M365 Session Bridge management inside the Golem tool sidebar', () => {
        const layoutSource = read('web-dashboard/src/app/dashboard/layout.tsx');
        const bridgeSource = read('web-dashboard/src/app/dashboard/m365-bridge/page.tsx');
        const settingsSource = read('web-dashboard/src/app/dashboard/settings/page.tsx');
        expect(layoutSource).toContain('{ label: "M365 Bridge", href: "/dashboard/m365-bridge"');
        expect(bridgeSource).toContain('/api/mcp/bridge/policy');
        expect(bridgeSource).toContain('/api/mcp/bridge/settings');
        expect(bridgeSource).toContain('/api/mcp/bridge/entries');
        expect(bridgeSource).toContain('這項變更會擴大 Bridge 可接觸的範圍');
        expect(settingsSource).toContain('href="/dashboard/m365-bridge"');
        expect(settingsSource).not.toContain('href="http://127.0.0.1:43240/"');
    });

    test('waits for stable M365 upload readiness and never force-sends with Enter', () => {
        const source = read('src/core/PageInteractor.js');
        expect(source).toContain('_waitForM365AttachmentUploadReady');
        expect(source).toContain('consecutiveReadySamples');
        expect(source).toContain("sendError.code = 'M365_SEND_NOT_READY'");
        expect(source).toContain("if (this.backendDefinition.id !== 'm365-web') await this._pressSubmitKeys()");
    });

    test('offers a bottom-left shutdown control that stops the local service and closes the dashboard page', () => {
        const source = read('web-dashboard/src/app/dashboard/layout.tsx');
        expect(source).toContain('aria-label="關閉 M365 Golem"');
        expect(source).toContain('apiUrl("/api/system/shutdown")');
        expect(source).toContain('window.close()');
        expect(source).toContain('window.location.replace("about:blank")');

        const runtime = read('apps/runtime/index.js');
        expect(runtime).toContain('await MCPManager.getInstance().shutdown()');
    });

    test('shows the Copilot-authored plan and current execution phase in a collapsible panel', () => {
        const source = read('web-dashboard/src/app/dashboard/chat/page.tsx');
        expect(source).toContain('<details open className="mt-3 rounded-xl border border-border bg-secondary/35 p-3">');
        expect(source).toContain('Copilot 自主計畫 · v{runDetail.plan.revision}');
        expect(source).toContain('run.status === "COMPLETED" ? (runDetail.plan.status === "complete" ? "計畫已完成" : "已完成（使用者核對）")');
        expect(source).toContain('等待工具核准');
        expect(source).toContain('工具執行中');
        expect(source).toContain('等待 Observation');
        expect(source).toContain('進行中');
        expect(source).toContain('`計畫 ${runDetail.plan.steps.filter');
        expect(source).toContain('宿主執行 ${run.currentStep}/${run.maxSteps}');
        expect(source).toContain('const displayedStatus = step.status;');
        expect(source).toContain('runAction(run, "complete"');
        expect(source).toContain('確認已完成');
        expect(source).toContain('每輪都會先判斷');
        expect(source).toContain('原生 M365 工作也適用，不必先有本機操作');
    });

    test('stops following the latest message when the reader scrolls up and exposes a return button', () => {
        const source = read('web-dashboard/src/app/dashboard/chat/page.tsx');
        expect(source).toContain('onScroll={handleConversationScroll}');
        expect(source).toContain('if (loading || !target || messages.length === 0) return;');
        expect(source).toContain('[latestMessageKey, loading, messages.length, scrollToLatest]');
        expect(source).toContain('window.requestAnimationFrame');
        expect(source).toContain('else if (followingLatestRef.current)');
        expect(source).toContain('scrollToLatest("auto");');
        expect(source).not.toContain('else if (followingLatestRef.current) {\n                scrollToLatest("smooth");');
        expect(source).toContain('aria-label="回到最新對話"');
        expect(source).not.toContain('}, [messages]);\n\n    const toggleReferenceFile');
    });

    test('shows a wave-style Golem activity bubble while a delivered turn awaits a reply', () => {
        const source = read('web-dashboard/src/app/dashboard/chat/page.tsx');
        expect(source).toContain('function GolemActivityBubble()');
        expect(source).toContain('aria-label="Golem 正在處理"');
        expect(source).toContain('[0, 140, 280].map((delay) =>');
        expect(source).toContain('animate-bounce motion-reduce:animate-pulse');
        expect(source).toContain('const showGolemActivity = sending || activeDialogueCount > 0;');
        expect(source).toContain('{showGolemActivity && <GolemActivityBubble />}');
        expect(source).toContain('!pausedResponseRequestIds.has(message.requestId)');
    });

    test('scrolls the conversation to the Golem activity bubble when processing begins', () => {
        const source = read('web-dashboard/src/app/dashboard/chat/page.tsx');
        expect(source).toContain('golemActivityWasVisibleRef.current = false;');
        expect(source).toContain('if (golemActivityWasVisibleRef.current) return;');
        expect(source).toContain('window.requestAnimationFrame(() => scrollToLatest("auto"))');
        expect(source).toContain('[scrollToLatest, showGolemActivity]');
    });

    test('renders Copilot code as a safe artifact card instead of raw M365 gutter text', () => {
        const chatSource = read('web-dashboard/src/app/dashboard/chat/page.tsx');
        const artifactSource = read('web-dashboard/src/components/M365MessageContent.tsx');
        expect(chatSource).toContain('<M365MessageContent content={message.content} />');
        expect(artifactSource).toContain('sandbox=""');
        expect(artifactSource).toContain('安全預覽');
        expect(artifactSource).toContain('下載檔案');
        expect(artifactSource).toContain('複製程式碼');
        expect(artifactSource).toContain('w-full min-w-0 max-w-[760px]');
        expect(artifactSource).not.toContain('w-[min(74vw,760px)]');
    });

    test('opens Golem web links outside the standalone workspace window', () => {
        const chatSource = read('web-dashboard/src/app/dashboard/chat/page.tsx');
        const artifactSource = read('web-dashboard/src/components/M365MessageContent.tsx');
        const linkSource = read('web-dashboard/src/components/ExternalConversationLink.tsx');

        expect(linkSource).toContain('target={external ? "_blank"');
        expect(linkSource).toContain('rel={external ? "noopener noreferrer"');
        expect(linkSource).toContain('^https?:\\/\\/');
        expect(chatSource).toContain('components={externalConversationLinkComponents}');
        expect(artifactSource).toContain('components={externalConversationLinkComponents}');
    });

    test('keeps light-theme hover and selected labels readable for every ops style', () => {
        const source = read('web-dashboard/src/app/globals.css');

        expect(source).toContain(':root:not(.dark)[data-ops-style]');
        expect(source).toContain('--accent: color-mix(in oklch, var(--primary) 14%, white);');
        expect(source).toContain('--accent-foreground: oklch(0.24 0.02 245);');
    });
});
