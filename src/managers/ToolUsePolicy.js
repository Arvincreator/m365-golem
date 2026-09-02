function normalize(value) {
    return String(value || '').toLowerCase();
}

const EXPLICIT_ACTION_RE = /(幫我|直接|執行|打開|開啟|點擊|輸入|填|建立|新增|儲存|更新|刪除|送出|發送|排程|提醒|查|讀|搜尋|分析|檢查|列出|列舉|取得|下載|上傳|複製|移動|重新命名|改名|簽出|簽入|還原|回收|debug|修|run|execute|open|click|fill|create|save|update|delete|send|schedule|search|inspect|analy[sz]e|check|list|enumerate|download|upload|copy|move|rename|checkout|checkin|restore)/i;
const PASSIVE_RE = /(怎麼|如何|為什麼|解釋|說明|建議|想法|概念|原理|比較|教我|what is|why|explain|suggest|recommend|compare|idea)/i;
const OPERATIONAL_RE = /(幫我|直接|執行|打開|開啟|點擊|輸入|建立|新增|儲存|更新|刪除|送出|發送|排程|提醒|查|讀|搜尋|分析|檢查|列出|列舉|取得|下載|上傳|複製|移動|重新命名|改名|簽出|簽入|還原|回收|debug|修|run|execute|open|click|fill|create|save|update|delete|send|schedule|search|inspect|check|list|enumerate|download|upload|copy|move|rename|checkout|checkin|restore)/i;
const TOOL_CAPABILITY_RE = /(你有|有沒有|是否有|可用嗎|能用嗎|支援|available|have|has|enabled|啟用).*(mcp|工具|tool|server|skills?|技能|chrome-devtools|devtools)/i;
const SKILL_CATALOG_RE = /(?:(?:有哪些|有什麼|列出|顯示|查看|清單|列表|目前|現在).{0,24}(?:skills?|技能)|(?:skills?|技能).{0,24}(?:有哪些|有什麼|可用|啟用|清單|列表|列出|顯示|查看)|\blist\s+(?:available\s+)?skills?\b|\bwhat\s+skills?\b)/i;

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
        const skillCatalog = SKILL_CATALOG_RE.test(text);
        const capabilityProbe = TOOL_CAPABILITY_RE.test(text) || skillCatalog;
        const passive = PASSIVE_RE.test(text) && !OPERATIONAL_RE.test(text);
        const casual = !explicitAction && !PASSIVE_RE.test(text) && text.length < 80;

        return {
            explicitAction,
            capabilityProbe,
            skillCatalog,
            passive,
            casual,
            shouldRoute: (explicitAction || capabilityProbe) && !passive,
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

        if (!request.shouldRoute) {
            // 向量語意高度命中時，即使不是明確操作指令也推薦；
            // 純關鍵字高分仍需尊重「概念解釋不要用工具」。
            if (candidate.semanticBoost && score >= 20) {
                return { include: true, strength: 'consider', risk, requiresConfirmation: false, reason: 'vector_semantic_match' };
            }
            return {
                include: false,
                strength: 'none',
                risk,
                requiresConfirmation: false,
                reason: request.passive ? 'passive_request' : 'not_actionable',
            };
        }

        if (score < 5) {
            return { include: false, strength: 'none', risk, requiresConfirmation: false, reason: 'low_score' };
        }

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
            '- 使用者只是問概念、要解釋、要建議或閒聊時，不要使用工具。',
            '- 只有在使用者明確要查資料、讀紀錄、操作外部系統、排程、修改或執行專門能力時才使用工具。',
            '- read 類工具可直接使用；action/write/delete/send/publish 類工具若不是使用者明確要求，先詢問確認。',
            '- 高風險或不可逆操作必須先說明影響並等待使用者確認。',
            '- 工具結果回來後不要自動連續呼叫工具，除非使用者明確要求繼續。'
        ];
    }
}

module.exports = ToolUsePolicy;
