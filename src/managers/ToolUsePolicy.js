function normalize(value) {
    return String(value || '').toLowerCase();
}

const EXPLICIT_ACTION_RE = /(幫我|直接|執行|測試|測看看|試試看|試看看|驗證|確認看看|用\s*action|打開|開啟|點擊|輸入|填|建立|建置|製作|開發|實作|編寫|撰寫|新增|儲存|更新|刪除|送出|發送|排程|提醒|查|讀|搜尋|分析|檢查|檢視|盤點|列出|列舉|取得|獲取|找到|下載|上傳|複製|移動|重新命名|改名|簽出|簽入|還原|回收|debug|修|run|execute|test|verify|try\s+(?:it|this)|open|click|fill|create|build|develop|implement|save|update|delete|send|schedule|search|inspect|analy[sz]e|check|list|enumerate|download|upload|copy|move|rename|checkout|checkin|restore)/i;
const PASSIVE_RE = /(怎麼|如何|為什麼|解釋|說明|建議|想法|概念|原理|比較|教我|what is|why|explain|suggest|recommend|compare|idea)/i;
const OPERATIONAL_RE = /(幫我|直接|執行|測試|測看看|試試看|試看看|驗證|確認看看|用\s*action|打開|開啟|點擊|輸入|建立|建置|製作|開發|實作|編寫|撰寫|新增|儲存|更新|刪除|送出|發送|排程|提醒|查|讀|搜尋|分析|檢查|檢視|盤點|列出|列舉|取得|獲取|找到|下載|上傳|複製|移動|重新命名|改名|簽出|簽入|還原|回收|debug|修|run|execute|test|verify|try\s+(?:it|this)|open|click|fill|create|build|develop|implement|save|update|delete|send|schedule|search|inspect|check|list|enumerate|download|upload|copy|move|rename|checkout|checkin|restore)/i;
const VERIFICATION_RE = /(測試|測看看|試試看|試看看|驗證|確認看看|用\s*action|test|verify|try\s+(?:it|this)|probe)/i;
const TOOL_CAPABILITY_RE = /(你有|有沒有|是否有|可用嗎|能用嗎|支援|available|have|has|enabled|啟用).*(mcp|工具|tool|server|skills?|技能|chrome-devtools|devtools)/i;
const SKILL_CATALOG_RE = /(?:(?:有哪些|有什麼|列出|顯示|查看|清單|列表|目前|現在).{0,24}(?:skills?|技能)|(?:skills?|技能).{0,24}(?:有哪些|有什麼|可用|啟用|清單|列表|列出|顯示|查看)|\blist\s+(?:available\s+)?skills?\b|\bwhat\s+skills?\b)/i;
const M365_CAPABILITY_PROBE_RE = /(?:(?:可以|能(?:不能)?|是否能|看(?:得)?到|讀(?:得)?到|存取|連線|使用).{0,32}(?:sharepoint|one\s*drive|onedrive|microsoft\s*365|\bm365\b)|(?:sharepoint|one\s*drive|onedrive|microsoft\s*365|\bm365\b).{0,32}(?:可以|能|可用|看(?:得)?到|讀(?:得)?到|存取|連線)|(?:can\s+you|are\s+you\s+able\s+to|do\s+you\s+have\s+access\s+to).{0,32}(?:sharepoint|one\s*drive|onedrive|microsoft\s*365|\bm365\b))/i;

const HIGH_RISK_RE = /(\bdelete\b|\bremove\b|刪除|\bdestroy\b|\bdrop\b|\breset\b|\brm\b|\bkill\b|\bformat\b|付款|\bpay\b|\bpurchase\b|\bbuy\b|\bsend_email\b|\bsend\b|發送|寄出|\bpost\b|\bpublish\b|公開|\bdeploy\b|\bpush\b|\bmerge\b)/i;
const ACTION_RE = /(click|fill|type|submit|navigate|new_page|close_page|drag|emulate|handle_dialog|create|save|update|write|schedule|commit|push|merge|reincarnate|evolution|moltbot|wiki\/delete|delete|刪除|建立|新增|儲存|更新|點擊|輸入|送出|排程)/i;
const READ_ONLY_RE = /(read|list|get|search|inspect|audit|trace|console|network|log|archive|session-search|memory|reference|wiki|讀|查|搜尋|列表|日誌|紀錄|檢查|分析)/i;
const M365_READ_ONLY_TOOL_RE = /^m365-session-bridge\/(?:m365_bridge_status|m365_get_file_url|m365_list_folder|m365_list_file_versions)$/i;
const M365_HIGH_RISK_TOOL_RE = /^m365-session-bridge\/(?:m365_recycle_file|m365_recycle_folder)$/i;
const M365_ACTION_TOOL_RE = /^m365-session-bridge\/(?:m365_download_file|m365_upload_file|m365_copy_file|m365_move_file|m365_rename_file|m365_create_folder|m365_rename_folder|m365_restore_file_version|m365_checkout_file|m365_checkin_file|m365_discard_checkout|m365_update_file_metadata|create_word_document|create_excel_workbook)$/i;

class ToolUsePolicy {
    classifyRequest(query) {
        const text = normalize(query);
        const explicitAction = EXPLICIT_ACTION_RE.test(text);
        const verificationIntent = VERIFICATION_RE.test(text);
        const skillCatalog = SKILL_CATALOG_RE.test(text);
        const capabilityProbe = TOOL_CAPABILITY_RE.test(text)
            || M365_CAPABILITY_PROBE_RE.test(text)
            || skillCatalog;
        const passive = PASSIVE_RE.test(text) && !OPERATIONAL_RE.test(text);
        const casual = !explicitAction && !PASSIVE_RE.test(text) && text.length < 80;

        return {
            explicitAction,
            verificationIntent,
            capabilityProbe,
            skillCatalog,
            passive,
            casual,
            // This flag means the user clearly expects an attempted check or
            // operation. It is not a global permission gate for tool routing.
            shouldRoute: explicitAction || capabilityProbe || verificationIntent,
        };
    }

    classifyTool(candidate) {
        const candidateId = String(candidate.id || '');
        if (M365_READ_ONLY_TOOL_RE.test(candidateId)) return 'read';
        if (M365_HIGH_RISK_TOOL_RE.test(candidateId)) return 'high';
        if (M365_ACTION_TOOL_RE.test(candidateId)) return 'action';

        const text = normalize([
            candidate.kind,
            candidate.id,
            candidate.name,
            candidate.description,
            candidate.action,
            candidate.server,
        ].join(' '));

        if (HIGH_RISK_RE.test(text)) return 'high';
        if (ACTION_RE.test(text)) return 'action';
        if (READ_ONLY_RE.test(text)) return 'read';
        return candidate.kind === 'mcp' ? 'action' : 'read';
    }

    evaluateCandidate(query, candidate) {
        const request = this.classifyRequest(query);
        let risk = this.classifyTool(candidate);
        if (risk !== 'high' && HIGH_RISK_RE.test(normalize(query))) risk = 'high';
        const score = Number(candidate.score || 0);

        if (request.capabilityProbe && candidate.kind === 'mcp') {
            return {
                include: true,
                strength: 'consider',
                risk,
                requiresConfirmation: false,
                reason: 'capability_probe_mcp_visibility',
            };
        }

        if (score < 5) {
            return {
                include: false,
                strength: 'none',
                risk,
                requiresConfirmation: false,
                reason: 'low_score',
            };
        }

        // A relevant read-only capability may improve explanations, advice,
        // comparisons, troubleshooting, or casual factual questions. Surface it
        // as optional even when the user did not spell out "use a tool".
        if (!request.shouldRoute && risk === 'read') {
            const autonomousReadMatch = candidate.semanticBoost || score >= 8;
            if (!autonomousReadMatch) {
                return { include: false, strength: 'none', risk, requiresConfirmation: false, reason: 'weak_optional_match' };
            }
            return {
                include: true,
                strength: 'consider',
                risk,
                requiresConfirmation: false,
                reason: candidate.semanticBoost ? 'vector_semantic_match' : 'relevant_optional_read',
            };
        }
        if (!request.shouldRoute) {
            return {
                include: false,
                strength: 'none',
                risk,
                requiresConfirmation: true,
                reason: 'mutation_not_requested',
            };
        }

        // Consequential tools can be made visible for planning, but lack of an
        // explicit requested effect is never authorization to execute them.
        const requiresConfirmation = risk === 'high' || (risk === 'action' && !request.explicitAction);
        let strength = score >= 12 ? 'strong' : 'consider';
        if (risk === 'high') strength = 'confirm_first';
        else if (requiresConfirmation) strength = 'ask_first';

        return {
            include: true,
            strength,
            risk,
            requiresConfirmation,
            reason: 'matched',
        };
    }

    filter(query, candidates) {
        return candidates
            .map(candidate => ({
                ...candidate,
                policy: this.evaluateCandidate(query, candidate)
            }))
            .filter(candidate => candidate.policy.include);
    }

    buildRules() {
        return [
            '- 工具使用由你依任務效益自行判斷，不以「使用者有沒有明說要用工具」作為唯一條件。',
            '- 概念、解釋、建議、比較、除錯或閒聊不等於禁用工具；若即時資料、專案內容、紀錄、來源或專門能力能明顯提高正確性，就使用相關工具。若既有知識已足夠，則直接回答，不要為了展示工具而呼叫。',
            '- read/discovery 類工具可在相關且有助益時主動使用，包括查證事實、取得必要背景、確認能力與診斷狀態；回覆時只陳述實際取得的證據。',
            '- action/write/delete/send/publish/install 等會改變外部狀態的工具，只有使用者已要求該效果時才能直接提出；否則先說明預期效果並詢問確認，不得把工具相關性當成操作授權。',
            '- 高風險或不可逆操作必須先說明影響並等待使用者確認。',
            '- 一般工具結果回來後不要自行連續呼叫工具；但若宿主已接受 GOLEM_PLAN，且本輪收到與目前步驟綁定的 host Observation，必須依計畫規則自行輸出下一版計畫與至多一個下一步 Action，不必等待使用者再說「繼續」。'
        ];
    }
}

module.exports = ToolUsePolicy;
