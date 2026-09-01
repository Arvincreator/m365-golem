const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const KeyChain = require('./KeyChain');

// ============================================================
// 🚑 DOM Doctor (已修復 AI 廢話導致崩潰問題)
// ============================================================
class DOMDoctor {
    constructor(backendDefinition = {}) {
        this.backendDefinition = backendDefinition || {};
        this.allowExternalSelectorHealing = this.backendDefinition.allowExternalSelectorHealing !== false;
        this.keyChain = this.allowExternalSelectorHealing ? new KeyChain() : null;
        const backendId = String(this.backendDefinition.id || 'gemini').replace(/[^a-z0-9_-]/gi, '_');
        const cacheName = backendId === 'gemini'
            ? 'golem_selectors.json'
            : `golem_selectors.${backendId}.json`;
        this.cacheFile = path.join(process.cwd(), cacheName);
        this.defaults = {
            input: 'textarea, div[contenteditable="true"], rich-textarea > div, p[data-placeholder], .ql-editor',
            send: 'button[aria-label*="Send"], button[aria-label*="傳送"], button[aria-label*="Submit"], span[data-icon="send"], button.bg-primary',
            response: '.model-response-text, .message-content, .markdown, div[data-test-id="message-content"], .prose',
            upload: 'input[type="file"], button[aria-label*="Add image"], button[aria-label*="上傳"], button[aria-label*="圖片"]',
            ...(this.backendDefinition.selectors || {}),
        };
    }
    loadSelectors() {
        try {
            if (fs.existsSync(this.cacheFile)) {
                const cached = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
                return { ...this.defaults, ...cached };
            }
        } catch (e) { }
        return { ...this.defaults };
    }
    saveSelectors(newSelectors) {
        try {
            const current = this.loadSelectors();
            const updated = { ...current, ...newSelectors };
            fs.writeFileSync(this.cacheFile, JSON.stringify(updated, null, 2));
            console.log("💾 [Doctor] Selector 已更新並存檔！");
        } catch (e) { }
    }
    async diagnose(htmlSnippet, targetType) {
        // M365 工作頁面可能包含租戶資料。POC 預設禁止把 DOM 傳給外部 Gemini API。
        if (!this.allowExternalSelectorHealing) {
            console.warn(`🛡️ [Doctor] ${this.backendDefinition.label || '此後端'} 已停用外部 Selector 診斷。`);
            return null;
        }
        if (this.keyChain.keys.length === 0) return null;
        const hints = {
            'input': '目標是輸入框。⚠️ 注意：請忽略內層的 <p>, <span> 或 text node。請往上尋找最近的一個「容器 div」，它通常具備 contenteditable="true"、role="textbox" 或 class="ql-editor" 屬性。',
            'send': '目標是發送按鈕。⚠️ 注意：請找出外層的 <button> 或具備互動功能的 <mat-icon>，不要只選取裡面的 <svg> 或 <path>。特徵：aria-label="Send" 或 data-mat-icon-name="send"。',
            'response': '找尋 AI 回覆的文字氣泡。'
        };
        const targetDescription = hints[targetType] || targetType;
        console.log(`🚑 [Doctor] 啟動深層診斷: 目標 [${targetType}]...`);

        let safeHtml = htmlSnippet;
        if (htmlSnippet.length > 60000) {
            const head = htmlSnippet.substring(0, 5000);
            const tail = htmlSnippet.substring(htmlSnippet.length - 55000);
            safeHtml = `${head}\n\n\n\n${tail}`;
        }

        const prompt = `你是 Playwright 自動化專家。目前的 CSS Selector 失效。
請分析 HTML，找出目標: "${targetType}" (${targetDescription}) 的最佳 CSS Selector。

HTML 片段:
\`\`\`html
${safeHtml}
\`\`\`

規則：
1. 只回傳 JSON: {"selector": "your_css_selector"}
2. 選擇器必須具備高特異性 (Specificity)，但不要依賴隨機生成的 ID (如 #xc-123)。
3. 優先使用 id, name, role, aria-label, data-attribute。`;

        let attempts = 0;
        while (attempts < this.keyChain.keys.length) {
            try {
                const apiKey = await this.keyChain.getKey();
                if (!apiKey) {
                    console.warn("⚠️ [Doctor] 無可用 API Key，跳過診斷。");
                    return null;
                }
                const genAI = new GoogleGenerativeAI(apiKey);
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                const result = await model.generateContent(prompt);
                const rawText = result.response.text().trim();

                let selector = "";
                try {
                    const jsonStr = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
                    const parsed = JSON.parse(jsonStr);
                    selector = parsed.selector;
                } catch (jsonErr) {
                    console.warn(`⚠️ [Doctor] JSON 解析失敗，嘗試暴力提取 (Raw: ${rawText.substring(0, 50)}...)`);
                    const lines = rawText.split('\n').filter(l => l.trim().length > 0);
                    const lastLine = lines[lines.length - 1].trim();
                    if (!lastLine.includes(' ')) selector = lastLine;
                }

                if (selector && selector.length > 0 && selector.length < 150 && !selector.includes('問題')) {
                    console.log(`✅ [Doctor] 診斷成功，新 Selector: ${selector}`);
                    return selector;
                } else {
                    console.warn(`⚠️ [Doctor] AI 提供的 Selector 無效或包含雜訊: ${selector}`);
                }
            } catch (e) {
                console.error(`❌ [Doctor] 診斷 API 錯誤: ${e.message}`);
                attempts++;
            }
        }
        return null;
    }
}

module.exports = DOMDoctor;
