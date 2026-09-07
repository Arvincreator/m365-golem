'use strict';
// Synthetic browser acceptance: never starts Golem, Edge login, or a tenant request.
const { chromium } = require('playwright');
const express = require('express');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');

async function main() {
    const app = express();
    app.get('/dashboard/chat', (_req, res) => res.sendFile(path.resolve('web-dashboard/out/dashboard/chat.html')));
    app.use(express.static(path.resolve('web-dashboard/out'), { extensions: ['html'], redirect: false }));
    const server = app.listen(3137, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let submits = 0;
    let draft = { schemaVersion: 1, revision: 0, text: '', responseMode: 'auto', referenceFileIds: [], mcpServerNames: [], skillIds: [], quote: null, attachmentDescriptors: [] };
    const drafts = new Map();
    const project = { id: 'synthetic-project', name: '合成示範專案', description: '', instructions: '', status: 'active', contextVersion: 1 };
    const conversation = { id: 'synthetic-chat', projectId: project.id, title: '桌面助理體驗驗收', bindingState: 'unbound', status: 'active' };
    const second = { ...conversation, id: 'synthetic-second', title: '另一個合成對話' };
    const run = { id: 'synthetic-run', conversationId: conversation.id, objective: '合成任務：驗證逐步狀態', status: 'COMPLETED', currentStep: 1, maxSteps: 5, updatedAt: '2026-09-07T01:00:00Z' };
    const message = { id: 'synthetic-message', conversationId: conversation.id, role: 'assistant', source: 'm365', content: '## 工作摘要\n\n這是合成資料，用於檢查閱讀、引用和草稿保存。\n\nGOLEM_ACTION 是協定名稱，這段解說不代表待核准動作。\n\n| 步驟 | 狀態 |\n| --- | --- |\n| 整理資料 | 已完成 |\n| 人工核對 | 待確認 |', deliveryState: 'response_confirmed', createdAt: '2026-09-07T01:00:00Z' };
    await page.addInitScript(() => { localStorage.setItem('m365_active_project_id', 'synthetic-project'); localStorage.setItem('m365_active_conversation_id', 'synthetic-chat'); });
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname.includes('/socket.io')) return route.abort();
        if (url.pathname.startsWith('/api/')) {
            const pathname = url.pathname;
            let body = { success: true };
            if (pathname.endsWith('/draft')) {
                const stored = drafts.get(pathname) || { ...draft, text: '', revision: 0, quote: null };
                if (route.request().method() === 'POST') {
                    const data = route.request().postDataJSON();
                    if (data.expectedRevision !== stored.revision) return route.fulfill({ status: 409, json: { message: 'Synthetic conflict' } });
                    drafts.set(pathname, { ...data.draft, revision: stored.revision + 1 });
                }
                body.draft = drafts.get(pathname) || stored;
                if (pathname.includes(conversation.id)) draft = body.draft;
            } else if (pathname === '/api/chat') { submits++; await new Promise(r => setTimeout(r, 250)); body.requestId = `synthetic-request-${submits}`; }
            else if (pathname.endsWith('/messages')) body.messages = [message];
            else if (pathname.endsWith('/runs')) body.runs = [run];
            else if (pathname === `/api/runs/${run.id}`) Object.assign(body, { run, approvals: [], steps: [], plan: { revision: 1, status: 'blocked', steps: [
                { id: 'one', title: '資料整理', status: 'completed', doneWhen: '已有資料' },
                { id: 'two', title: '人工確認', status: 'blocked', doneWhen: '等待使用者核对' },
                { id: 'three', title: '選配步驟', status: 'skipped', doneWhen: '本輪不適用' },
            ] } });
            else if (pathname.endsWith('/reference-bindings')) body.referenceFileIds = [];
            else if (pathname === '/api/projects') body.projects = [project];
            else if (pathname.endsWith('/conversations')) body.conversations = [conversation, second];
            else if (pathname === `/api/conversations/${conversation.id}`) body.conversation = conversation;
            else if (pathname === `/api/conversations/${second.id}`) body.conversation = second;
            else if (pathname === `/api/projects/${project.id}`) body.project = project;
            else if (pathname.endsWith('/workspace/status')) body.workspace = { enabled: true, runnerEnabled: true, encryptionConfigured: true };
            else if (pathname.endsWith('/workspace')) body.workspace = { projectId: project.id, rootPath: 'Synthetic workspace', agentsContent: '合成規則', memoryEntries: [], memoryCount: 0, managedBy: 'golem' };
            else if (pathname.endsWith('/pending-actions')) Object.assign(body, { items: [], actionsEnabled: true, executionQueue: [] });
            else if (pathname.endsWith('/pending-responses')) body.items = [];
            else if (pathname.endsWith('/reference-files')) body.files = [];
            else if (pathname.endsWith('/servers')) body.servers = [];
            else if (pathname.endsWith('/skill-options')) body.skills = [];
            else if (pathname.endsWith('/prompt-pool')) body.items = [];
            else if (pathname.endsWith('/preferences')) body.automationMode = 'guided';
            return route.fulfill({ json: body });
        }
        if (url.origin !== 'http://127.0.0.1:3137') return route.abort();
        return route.continue();
    });
    try {
        await page.goto('http://127.0.0.1:3137/dashboard/chat');
        const input = page.getByRole('textbox', { name: '訊息草稿' });
        await input.waitFor();
        await input.fill('中文組字測試');
        await input.dispatchEvent('compositionstart');
        await input.press('Enter');
        assert.equal(submits, 0);
        await input.dispatchEvent('compositionend');
        await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
        assert.equal(submits, 0);
        await input.fill('第一行'); await input.press('Shift+Enter');
        assert.match(await input.inputValue(), /\n/);
        await input.fill('A');
        await page.getByRole('button', { name: '傳送', exact: true }).click();
        await page.waitForTimeout(50); await input.fill('B：新的草稿不可被清除');
        await page.waitForTimeout(1000);
        assert.equal(submits, 1); assert.equal(await input.inputValue(), 'B：新的草稿不可被清除');
        assert.equal(draft.text, 'B：新的草稿不可被清除');
        await page.getByRole('button', { name: '引用追問', exact: true }).click();
        assert.equal(submits, 1);
        await page.getByRole('button', { name: '移除引用', exact: true }).waitFor();
        await page.getByRole('button', { name: second.title, exact: true }).click();
        await input.waitFor();
        assert.equal(await input.inputValue(), '');
        await input.fill('另一個對話自己的草稿');
        await page.getByRole('button', { name: conversation.title, exact: true }).click();
        await input.waitFor();
        assert.equal(await input.inputValue(), 'B：新的草稿不可被清除');
        await page.getByRole('button', { name: '移除引用', exact: true }).waitFor();
        assert.equal(await page.getByText('工具動作等待核准', { exact: true }).count(), 0);
        const output = path.resolve('output/playwright/ux-rebuild'); fs.mkdirSync(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'chat-1366.png'), fullPage: true });
        const trigger = page.getByRole('button', { name: '來源與執行', exact: true });
        const before = await input.boundingBox();
        await trigger.click();
        const panel = page.getByRole('region', { name: '來源與執行', exact: true });
        await panel.waitFor();
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.equal(await panel.getByRole('heading', { name: '來源與執行', exact: true }).count(), 1);
        assert.equal(await panel.getByRole('button', { name: '關閉來源與執行', exact: true }).count(), 1);
        const after = await input.boundingBox();
        const bounds = await panel.boundingBox();
        assert.ok(after.width < before.width);
        assert.ok(after.x + after.width <= bounds.x);
        await input.click();
        assert.equal(await input.evaluate(node => node === document.activeElement), true);
        assert.match(await panel.innerText(), /受阻/);
        assert.match(await panel.innerText(), /已略過/);
        assert.match(await panel.innerText(), /1\/3/);
        await page.screenshot({ path: path.join(output, 'inspector-1366.png'), fullPage: true });
        await panel.getByRole('button', { name: '關閉來源與執行', exact: true }).focus();
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'hidden' });
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
        await trigger.click();
        await panel.getByRole('button', { name: '關閉來源與執行', exact: true }).click();
        await panel.waitFor({ state: 'hidden' });
        await trigger.click(); await trigger.click();
        await panel.waitFor({ state: 'hidden' });
        await page.setViewportSize({ width: 911, height: 768 });
        await trigger.click();
        await page.getByRole('dialog').waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.screenshot({ path: path.join(output, 'chat-1920.png'), fullPage: true });
        for (const width of [1093, 911]) {
            await page.setViewportSize({ width, height: 615 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
            await page.screenshot({ path: path.join(output, `chat-${width}.png`), fullPage: true });
        }
        await page.reload(); await input.waitFor();
        assert.equal(await input.inputValue(), 'B：新的草稿不可被清除');
        assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('新的草稿不可被清除')), false);
        assert.deepEqual(errors, []);
        console.log('PASS: mock browser IME, 229, Shift+Enter, one submit, ACK/new draft, quote, inspector/Escape, 1366/1920 and narrow viewport overflow. No tenant requests.');
    } catch (error) {
        console.error('Browser page:', await page.locator('body').innerText(), errors);
        throw error;
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
