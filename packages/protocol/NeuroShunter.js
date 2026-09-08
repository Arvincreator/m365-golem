const ResponseParser = require('../../src/utils/ResponseParser');
const { getMemoryFirewallService } = require('../../src/services/MemoryFirewallService');
const MultiAgentHandler = require('../../src/core/action_handlers/MultiAgentHandler');
const SkillHandler = require('../../src/core/action_handlers/SkillHandler');
const CommandHandler = require('../../src/core/action_handlers/CommandHandler');
const ActionExecutionGate = require('../../src/managers/ActionExecutionGate');
const { toolsetManager } = require('../../src/managers/ToolsetManager');
const { CONFIG } = require('../../src/config');
const skillManager = require('../../src/managers/SkillManager');
const COMMAND_DEFS = require('../../src/config/commands');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { buildM365PlanObservation } = require('../../src/services/M365PlanProtocol');
const { mayAutoApproveM365Actions } = require('../../src/services/M365AutomationPolicy');
const { buildExecutionProgressText } = require('../../src/services/M365ExecutionContract');

const MCP_CONFIG_PATH = path.resolve(process.cwd(), 'data', 'mcp-servers.json');

function normalizeToken(value) {
    return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function loadEnabledMcpTools() {
    try {
        if (!fs.existsSync(MCP_CONFIG_PATH)) return [];
        const parsed = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'));
        const servers = Array.isArray(parsed) ? parsed.filter((item) => item && item.enabled !== false) : [];
        const output = [];
        for (const server of servers) {
            for (const tool of (server.cachedTools || [])) {
                if (!tool || !tool.name) continue;
                output.push({
                    server: String(server.name || '').trim(),
                    name: String(tool.name || '').trim(),
                    description: String(tool.description || '').trim()
                });
            }
        }
        return output.filter((item) => item.server && item.name);
    } catch (_) {
        return [];
    }
}

function loadSlashCommandAliases() {
    const aliases = new Set();
    for (const item of (Array.isArray(COMMAND_DEFS) ? COMMAND_DEFS : [])) {
        const cmd = String(item && item.command ? item.command : '').trim();
        if (!cmd.startsWith('/')) continue;
        const noSlash = cmd.slice(1).trim();
        if (!noSlash) continue;
        aliases.add(normalizeToken(noSlash));
    }
    return aliases;
}

const SLASH_COMMAND_ALIASES = loadSlashCommandAliases();

function sanitizeReply(text) {
    if (!text) return "";
    if (typeof ResponseParser.sanitizeProtocolTags === 'function' && !ResponseParser.sanitizeProtocolTags._isMockFunction) {
        return ResponseParser.sanitizeProtocolTags(text);
    }
    return String(text)
        .replace(/\[{1,2}\s*(?:BEGIN|END)\s*:[^\]\n\r]+?\]{1,2}/gi, '')
        .replace(/\[\s*(?:BEGIN|END)\s*:[^\]\n\r]+?\]\]/gi, '')
        .replace(/\[\[?\s*(?:BEGIN|END)\s*:[^\]\n\r]+?\]?\]?/gi, '')
        .replace(/\[\/?GOLEM_(?:MEMORY|PROJECT_MEMORY|USER_MEMORY|CONVERSATION_TITLE|ACTION|PLAN|REPLY)\]/gi, '')
        .trim();
}

function hasMarkdownHttpLink(text) {
    return /\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/.test(String(text || ''));
}

function buildReplyOptions(ctx, finalReply, extra = {}) {
    const options = { ...extra };
    if (ctx.platform === 'telegram' && hasMarkdownHttpLink(finalReply)) {
        options._telegramHtmlLinks = true;
    }
    return options;
}

function hasProjectMemoryOperations(value) {
    const payload = String(value || '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
    if (!payload || /^(?:null|\[\s*\]|\{\s*\}|\(無\))$/i.test(payload)) return false;
    try {
        let parsed = JSON.parse(payload);
        if (parsed && Array.isArray(parsed.entries)) parsed = parsed.entries;
        if (Array.isArray(parsed)) return parsed.length > 0;
        return Boolean(parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0);
    } catch (_) {
        // A malformed non-empty payload is handled by the scoped memory validator.
        return true;
    }
}

// ============================================================
// 🧬 NeuroShunter (神經分流中樞 - 核心路由器)
// ============================================================
class NeuroShunter {
    static _normalize(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s._/-]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    static _score(query, candidate) {
        const q = this._normalize(query);
        const c = this._normalize(candidate);
        if (!q || !c) return 0;

        let score = 0;
        if (c.includes(q)) score += 8;
        const tokens = q.split(' ').filter((token) => token.length >= 2);
        for (const token of tokens) {
            if (c.includes(token)) score += token.length >= 4 ? 3 : 2;
        }
        return score;
    }

    static _isPlanCheckpointAction(act) {
        return normalizeToken(act && act.action) === 'plan-checkpoint';
    }

    static async _executePlanCheckpoint(ctx, act, brain, controller, options = {}) {
        const summary = String(act.summary || '').trim();
        const evidence = Array.isArray(act.evidence) ? act.evidence.map((item) => String(item).trim()) : [];
        const result = JSON.stringify({
            type: 'native_copilot_checkpoint',
            summary,
            evidence,
        }, null, 2);
        if (typeof ctx.onGolemObservation !== 'function') {
            await ctx.reply('⚠️ 原生步驟已完成，但宿主無法記錄計畫檢查點；自主計畫已安全暫停。');
            return;
        }
        const recorded = await ctx.onGolemObservation({
            runId: options.workspaceRunId,
            stepId: options.workspaceStepId,
            actionId: options.workspaceActionId,
            planStepId: options.workspacePlanStepId,
            lane: 'plan_checkpoint',
            status: 'succeeded',
            result,
        });
        if (brain?.webBackend?.id === 'm365-web' && ctx) {
            ctx.workspaceProjectMemoryRequired = true;
        }

        const nextDepth = Number(options.actionDepth || 0) + 1;
        const maxDepth = Number(options.maxActionDepth || CONFIG.MAX_AUTO_TURNS || 5);
        const mayContinue = nextDepth < maxDepth
            && !['PAUSED', 'CANCELED', 'COMPLETED', 'RECONCILE_REQUIRED'].includes(recorded?.run?.status);
        const feedbackPrompt = buildM365PlanObservation({
            planId: options.workspacePlanId || recorded?.planId,
            planRevision: options.workspacePlanRevision || recorded?.planRevision,
            stepId: options.workspaceStepId,
            planStepId: options.workspacePlanStepId,
            actionId: options.workspaceActionId,
            lane: 'plan_checkpoint',
            status: 'succeeded',
            result,
        });
        const feedbackOptions = {
            isPriority: true,
            bypassDebounce: true,
            isSystemFeedback: true,
            allowActions: mayContinue,
            actionDepth: nextDepth,
            maxActionDepth: maxDepth,
            maxAutoTurns: maxDepth + 1,
            planMode: true,
            workspaceConversationId: ctx.workspaceConversationId || null,
            workspaceRunId: options.workspaceRunId,
            workspaceStepId: options.workspaceStepId,
            workspacePlanId: options.workspacePlanId || recorded?.planId,
            workspacePlanRevision: options.workspacePlanRevision || recorded?.planRevision,
            workspacePlanStepId: options.workspacePlanStepId,
            workspaceActionId: options.workspaceActionId,
            m365ProjectMemoryRequired: brain?.webBackend?.id === 'm365-web',
        };

        let convoManager = controller && controller.convoManager;
        if (!convoManager) {
            try {
                const getOrCreate =
                    (typeof global.getOrCreateGolem === 'function' && global.getOrCreateGolem)
                    || require('../../index').getOrCreateGolem;
                convoManager = getOrCreate(controller && controller.golemId).convoManager;
            } catch (error) {
                console.warn('[NeuroShunter] Unable to resolve the conversation queue for plan_checkpoint:', error.message);
            }
        }

        if (convoManager && typeof convoManager.enqueue === 'function') {
            await convoManager.enqueue(ctx, feedbackPrompt, feedbackOptions);
            return;
        }
        if (brain && typeof brain.sendMessage === 'function') {
            const finalResponse = await brain.sendMessage(feedbackPrompt, false, feedbackOptions);
            await this.dispatch(ctx, finalResponse, brain, controller, feedbackOptions);
            return;
        }
        await ctx.reply('⚠️ 原生步驟已完成，但找不到可用的對話佇列；自主計畫已停在目前檢查點。');
    }

    static _tryRecoverSlashAction(act) {
        if (!act || typeof act !== 'object') return null;
        const actionName = String(act.action || '').trim();
        if (!actionName) return null;
        if (['command', 'mcp_call', 'multi_agent'].includes(actionName)) return null;

        const normalized = normalizeToken(actionName.replace(/^\//, ''));
        if (!SLASH_COMMAND_ALIASES.has(normalized)) return null;

        const tail =
            typeof act.parameter === 'string' ? act.parameter.trim() :
                (typeof act.parameters === 'string' ? act.parameters.trim() : '');
        const slashCommand = `/${normalized.replace(/-/g, '_')}${tail ? ` ${tail}` : ''}`;
        return {
            action: {
                action: 'command',
                parameter: slashCommand
            },
            note: `🧭 [Routing] 偵測到 action **${actionName}** 是斜線指令，已改寫為 shell lane：\`${slashCommand}\``
        };
    }

    static _tryRecoverAsMcpCall(act) {
        if (!act || typeof act !== 'object') return null;
        const actionName = String(act.action || '').trim();
        if (!actionName) return null;
        if (['command', 'mcp_call', 'multi_agent'].includes(actionName)) return null;

        const tools = loadEnabledMcpTools();
        const normalizedAction = normalizeToken(actionName);
        const exactMatches = tools.filter((item) => normalizeToken(item.name) === normalizedAction);
        if (exactMatches.length === 0) return null;
        if (exactMatches.length > 1) {
            const choices = exactMatches
                .slice(0, 4)
                .map((item) => `\`${item.server}/${item.name}\``)
                .join(', ');
            return {
                ambiguous: true,
                note: `⚠️ [Routing] action **${actionName}** 對應多個 MCP 工具，請指定 server：${choices}`
            };
        }

        const matched = exactMatches[0];
        const parameters = act.parameters && typeof act.parameters === 'object'
            ? act.parameters
            : (act.args && typeof act.args === 'object' ? act.args : {});

        return {
            action: {
                action: 'mcp_call',
                server: matched.server,
                tool: matched.name,
                parameters,
            },
            note: `🧭 [Routing] 偵測到 action **${actionName}** 為 MCP 工具名稱，已改寫為 **mcp_call ${matched.server}/${matched.name}**`
        };
    }

    static _buildUnknownActionMessage(actionName) {
        const skills = (() => {
            try {
                return skillManager.listSkills();
            } catch (_) {
                return [];
            }
        })();
        const mcpTools = loadEnabledMcpTools();

        const skillHints = (Array.isArray(skills) ? skills : [])
            .map((skill) => ({
                name: String(skill && skill.name ? skill.name : '').trim(),
                score: this._score(actionName, `${skill && skill.name ? skill.name : ''} ${skill && skill.description ? skill.description : ''}`),
            }))
            .filter((item) => item.name && item.score > 0)
            .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
            .slice(0, 3)
            .map((item) => `\`${item.name}\``);

        const mcpHints = mcpTools
            .map((tool) => ({
                id: `${tool.server}/${tool.name}`,
                score: this._score(actionName, `${tool.server} ${tool.name} ${tool.description}`),
            }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
            .slice(0, 3)
            .map((item) => `\`${item.id}\``);

        return `❌ 無法識別 action **${actionName}**。\n建議改用以下之一：\n- command: \`{"action":"command","parameter":"<native command>"}\`\n- skill action: ${skillHints.join(', ') || '（無）'}\n- mcp_call: ${mcpHints.join(', ') || '（無）'}`;
    }

    static async dispatch(ctx, rawResponse, brain, controller, options = {}) {
        let textToParse = rawResponse;
        let attachments = options.attachments || [];
        let responseReplyOptions = null;
        let responseStatus = '';

        // 📥 [v9.1.10] 支援結構化回應物件 { text, attachments }
        if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
            textToParse = rawResponse.text || "";
            attachments = [...attachments, ...(rawResponse.attachments || [])];
            responseStatus = String(rawResponse.status || '');
            if (rawResponse.replyOptions && typeof rawResponse.replyOptions === 'object') {
                responseReplyOptions = rawResponse.replyOptions;
            }
        }

        const parsed = ResponseParser.parse(textToParse);
        let shouldSuppressReply = options.suppressReply === true;
        const localContextEnabled = !brain || typeof brain.isLocalContextEnabled !== 'function'
            ? true
            : brain.isLocalContextEnabled();
        const runtimeActionsEnabled = !brain || typeof brain.areActionsEnabled !== 'function'
            ? true
            : brain.areActionsEnabled();
        let protocolRepair = null;
        let projectMemoryRepair = null;
        let projectMemoryUpdateCount = 0;

        if (parsed.conversationTitle && typeof ctx?.onGolemConversationTitle === 'function') {
            try {
                await ctx.onGolemConversationTitle({
                    conversationTitle: parsed.conversationTitle,
                    isSystemFeedback: options.isSystemFeedback === true,
                });
            } catch (titleError) {
                console.warn('[NeuroShunter] Conversation title update skipped:', titleError.message);
            }
        }

        if (runtimeActionsEnabled && typeof ctx?.onGolemProtocolResponse === 'function') {
            try {
                const protocolResult = await ctx.onGolemProtocolResponse({
                    rawResponse: textToParse,
                    parsed,
                    actionCount: parsed.actions.length,
                    downloadAttachmentCount: attachments.filter((item) => item && item.kind === 'download').length,
                    isSystemFeedback: options.isSystemFeedback === true,
                    toolRoute: options.m365ToolRoute || null,
                    responseStatus,
                });
                if (protocolResult && protocolResult.planMode) {
                    options = {
                        ...options,
                        planMode: true,
                        allowActions: protocolResult.allowActions === true,
                        maxActionDepth: Number(protocolResult.maxActionDepth || options.maxActionDepth || CONFIG.MAX_AUTO_TURNS || 5),
                        workspaceRunId: protocolResult.runId || options.workspaceRunId || null,
                        workspaceStepId: protocolResult.stepId || options.workspaceStepId || null,
                        workspacePlanId: protocolResult.planId || options.workspacePlanId || null,
                        workspacePlanRevision: protocolResult.planRevision ?? options.workspacePlanRevision ?? 0,
                        workspacePlanStepId: protocolResult.planStepId || options.workspacePlanStepId || null,
                        workspaceActionId: protocolResult.actionId || options.workspaceActionId || null,
                        resetAutoTurnBudget: protocolResult.resetAutoTurnBudget === true,
                    };
                    if (protocolResult.accepted === false) parsed.actions = [];
                    if (protocolResult.warning) {
                        if (protocolResult.accepted === false && protocolResult.stopRepair === true) {
                            parsed.reply = '';
                        } else if (protocolResult.accepted === false && !protocolResult.protocolRepair) {
                            protocolRepair = {
                                status: 'retry',
                                prompt: [
                                    '[GOLEM_HOST_CONSTRAINT]',
                                    'The host rejected the previous plan or action. No new tool action was dispatched by this rejection.',
                                    `Constraint code: ${String(protocolResult.code || 'M365_PLAN_REJECTED')}.`,
                                    `Host feedback: ${String(protocolResult.warning || '').replace(/^⚠️\s*/, '')}`,
                                    'Adjust your posture and return the next valid GOLEM_PLAN revision for the same plan_id.',
                                    'If work can continue, include the corrected GOLEM_ACTION block with the ordered actions needed for the current step.',
                                    'If human authorization or essential information is genuinely required, use wait_approval or wait_user with a concise question. Do not repeat the rejected response.',
                                    '[/GOLEM_HOST_CONSTRAINT]',
                                ].join('\n'),
                                toolRoutingQuery: String(ctx?.toolRoutingQuery || ''),
                                message: '',
                            };
                            parsed.reply = '';
                        } else {
                            parsed.reply = `${parsed.reply || ''}\n\n${protocolResult.warning}`.trim();
                        }
                    }
                }
                if (protocolResult?.protocolRepair) {
                    const preserveVisibleResult = protocolResult.protocolRepair.preserveVisibleResult === true
                        || /^FALLBACK_(?:DIFF|RECOVERED)$/i.test(responseStatus);
                    const visibleReply = parsed.reply;
                    const visibleAttachments = attachments;
                    protocolRepair = protocolResult.protocolRepair;
                    parsed.actions = [];
                    if (preserveVisibleResult) {
                        // The visible M365 answer is still useful even when Copilot
                        // omitted the protocol envelope. Show it now, then repair only
                        // the missing control metadata in the background.
                        parsed.reply = visibleReply;
                        attachments = visibleAttachments;
                    } else {
                        parsed.reply = String(protocolRepair.message || '').trim();
                        // A rejected response may still carry M365-generated downloads or
                        // citations. They are part of the unaccepted claim, so presenting
                        // them beside the host repair message would make a fake completion
                        // look trustworthy to the user.
                        attachments = [];
                    }
                }
            } catch (error) {
                console.error('[NeuroShunter] GOLEM_PLAN host callback failed:', error);
                if (parsed.plan || parsed.planError) {
                    parsed.actions = [];
                    parsed.reply = `${parsed.reply || ''}\n\n⚠️ 自主計畫已暫停：本機持久化或狀態驗證失敗。`.trim();
                }
            }
        } else if (parsed.plan || parsed.planError) {
            parsed.actions = [];
            parsed.reply = `${parsed.reply || ''}\n\n⚠️ 自主計畫已暫停：目前沒有可用的本機計畫控制器。`.trim();
        }

        const projectMemoryRequired = ctx?.workspaceProjectMemoryRequired === true
            || options.m365ProjectMemoryRequired === true;
        const canRepairProjectMemory = projectMemoryRequired
            && parsed.actions.length === 0
            && !protocolRepair
            && brain?.webBackend?.id === 'm365-web';
        const projectMemoryRepairAttempt = Number(options.projectMemoryRepairAttempt || 0);
        const requestProjectMemoryRepair = (reason) => {
            if (!canRepairProjectMemory || projectMemoryRepair) return 'not_applicable';
            const repairReason = String(reason || '').trim();
            if (projectMemoryRepairAttempt < 1) {
                projectMemoryRepair = {
                    prompt: [
                        '[GOLEM_PROJECT_MEMORY_REPAIR]',
                        'The prior response did not persist project memory required by this turn. A prose promise is not a write.',
                        repairReason ? `Host validation: ${repairReason}` : '',
                        'Return exactly one non-empty [GOLEM_PROJECT_MEMORY] JSON array using the allowed schema, plus one concise [GOLEM_REPLY] that says what project state was recorded.',
                        'Record the project-scoped work record, rule, decision, current status, preference or habit, or reusable experience/lesson/pitfall established by the turn. Do not mark unverified work complete and do not include a GOLEM_PLAN or GOLEM_ACTION.',
                        '[/GOLEM_PROJECT_MEMORY_REPAIR]',
                    ].filter(Boolean).join('\n'),
                    attempt: projectMemoryRepairAttempt + 1,
                };
                shouldSuppressReply = true;
                return 'queued';
            }
            parsed.reply = `${parsed.reply || ''}\n\n⚠️ 本輪應更新專案記憶，但模型沒有提供可寫入的專案紀錄。`.trim();
            return 'exhausted';
        };
        const hasProjectMemoryWrite = hasProjectMemoryOperations(parsed.projectMemory);
        if (projectMemoryRequired && !hasProjectMemoryWrite) {
            requestProjectMemoryRepair('The project-memory block was missing, null, or empty.');
        }

        if (options.planMode === true && parsed.actions.length > 0 && !parsed.plan && options.m365ActionApproved !== true) {
            parsed.actions = [];
            protocolRepair = {
                status: 'retry',
                prompt: [
                    '[GOLEM_HOST_CONSTRAINT]',
                    'The host rejected the previous tool actions. No tool action was dispatched.',
                    'Constraint code: M365_SAME_REVISION_PLAN_REQUIRED.',
                    'Host feedback: Follow-up tool actions must include the matching GOLEM_PLAN revision.',
                    'Return the current GOLEM_PLAN with the same plan_id and a revised revision, plus the corrected GOLEM_ACTION block for the current step.',
                    'If human authorization or essential information is genuinely required, use wait_approval or wait_user with a concise question.',
                    '[/GOLEM_HOST_CONSTRAINT]',
                ].join('\n'),
                toolRoutingQuery: String(ctx?.toolRoutingQuery || ''),
                message: '',
            };
            parsed.reply = '';
        }

        const isSystemFeedback = options.isSystemFeedback === true;
        const allowActions = options.allowActions === true;
        const actionDepth = Number(options.actionDepth || 0);
        const maxActionDepth = Math.max(1, Number(options.maxActionDepth || CONFIG.MAX_AUTO_TURNS || 5));

        if (!runtimeActionsEnabled && parsed.actions.length > 0) {
            console.warn(`🛡️ [NeuroShunter] 此後端的自動動作已停用，已忽略 ${parsed.actions.length} 個模型提議動作。`);
            parsed.actions = [];
        }

        if (!localContextEnabled) {
            parsed.memory = null;
            parsed.avoidMemory = null;
        }

        const hostCheckpointOnly = options.planMode === true
            && parsed.actions.length > 0
            && parsed.actions.every((action) => this._isPlanCheckpointAction(action));
        const useM365ActionProgressReply = runtimeActionsEnabled
            && parsed.actions.length > 0
            && brain
            && brain.webBackend
            && brain.webBackend.id === 'm365-web'
            && !hostCheckpointOnly;
        const needsM365Approval = runtimeActionsEnabled
            && parsed.actions.length > 0
            && brain
            && brain.webBackend
            && brain.webBackend.id === 'm365-web'
            && brain.webBackend.safeMode
            && !mayAutoApproveM365Actions(parsed.actions)
            && options.m365ActionApproved !== true
            && !hostCheckpointOnly;

        if (needsM365Approval) {
            if (controller && controller.pendingTasks) {
                const approvalId = uuidv4();
                controller.pendingTasks.set(approvalId, {
                    type: 'M365_ACTION_APPROVAL',
                    ctx,
                    timestamp: Date.now(),
                    proposedActions: parsed.actions,
                    dispatchOptions: {
                        suppressReply: options.suppressReply === true,
                        isSystemFeedback: options.isSystemFeedback === true,
                        allowActions: options.allowActions === true,
                        actionDepth: Number(options.actionDepth || 0),
                        maxActionDepth: Number(options.maxActionDepth || CONFIG.MAX_AUTO_TURNS || 5),
                        preferredSkillIds: Array.isArray(options.preferredSkillIds) ? options.preferredSkillIds : [],
                        preferredSkillActions: Array.isArray(options.preferredSkillActions) ? options.preferredSkillActions : [],
                        preferredMcpServers: Array.isArray(options.preferredMcpServers) ? options.preferredMcpServers : [],
                        planMode: options.planMode === true,
                        workspaceRunId: options.workspaceRunId || null,
                        workspaceStepId: options.workspaceStepId || null,
                        workspacePlanId: options.workspacePlanId || null,
                        workspacePlanRevision: Number(options.workspacePlanRevision || 0),
                        workspacePlanStepId: options.workspacePlanStepId || null,
                        workspaceActionId: options.workspaceActionId || null,
                    },
                });
                const compactActions = JSON.stringify(parsed.actions, null, 2).slice(0, 6000);
                await ctx.reply(
                    `🛡️ M365 工作台已暫停一項工具動作，等待你在右側「待核准工具動作」確認。\n\n` +
                    `\`\`\`json\n${compactActions}\n\`\`\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ 核准工具動作', callback_data: `APPROVE_${approvalId}` },
                                { text: '❌ 拒絕工具動作', callback_data: `DENY_${approvalId}` },
                            ]],
                        },
                    }
                );
            } else {
                await ctx.reply('⚠️ 工具動作已停止：目前沒有可用的本機核准控制器。');
            }
            parsed.actions = [];
        }

        // 🎯 [v9.1.13] 靜默模式自癒：如果沒有後續動作 (Action)，代表任務結束，強制解除靜默以顯示最終回覆
        if (shouldSuppressReply && parsed.actions.length === 0 && !projectMemoryRepair) {
            console.log(`📢 [NeuroShunter] 偵測到任務結束或無後續動作，自動解除靜默模式。`);
            shouldSuppressReply = false;
        }

        // 核心：偵測 [INTERVENE] 標籤以實現觀察者模式自主介入
        if (textToParse.includes('[INTERVENE]')) {
            console.log(`🚀 [NeuroShunter] 偵測到 AI 自主介入請求 [INTERVENE]！`);
            shouldSuppressReply = false;
        }

        if (parsed.reply && parsed.reply.includes('[INTERVENE]')) {
            parsed.reply = parsed.reply.replace(/\[INTERVENE\]/g, '').trim();
        }
        if (parsed.reply) {
            parsed.reply = sanitizeReply(parsed.reply);
        }

        // 1. 處理長期記憶寫入
        if (parsed.memory) {
            console.log(`[GOLEM_MEMORY]\n${parsed.memory}`);
            await brain.memorize(parsed.memory, { type: 'fact', timestamp: Date.now() });
        }

        // 1a. M365 專案／使用者記憶是非執行型協議：像原版 GOLEM_MEMORY
        // 一樣由模型自主維護，但由宿主限制可寫欄位、敏感資料與專案範圍。
        // 這兩條記憶 lane 不進入 Action Gate；工具與外部副作用仍照常核准。
        if (parsed.projectMemory && hasProjectMemoryWrite) {
            try {
                if (!brain || !brain.webBackend || brain.webBackend.id !== 'm365-web'
                    || !ctx || !ctx.workspaceProjectId
                    || !ctx.m365ProjectWorkspaceService
                    || typeof ctx.m365ProjectWorkspaceService.applyMemoryBlock !== 'function') {
                    throw new Error('No scoped M365 project workspace is active.');
                }
                const result = ctx.m365ProjectWorkspaceService.applyMemoryBlock(
                    ctx.workspaceProjectId,
                    parsed.projectMemory,
                    {
                        conversationId: ctx.workspaceConversationId,
                        requestId: ctx.workspaceRequestId,
                        workspacePath: ctx.workspaceRoot,
                    }
                );
                const memoryResults = Array.isArray(result?.results) ? result.results : [];
                projectMemoryUpdateCount = memoryResults.filter((item) => item.changed).length;
                console.log(`[GOLEM_PROJECT_MEMORY] updated=${projectMemoryUpdateCount} project=${ctx.workspaceProjectId}`);
                if (projectMemoryRequired && projectMemoryUpdateCount === 0) {
                    requestProjectMemoryRepair('The project-memory block produced no stored change.');
                }
            } catch (error) {
                console.warn(`[GOLEM_PROJECT_MEMORY] rejected: ${error.code || error.message}`);
                const repairStatus = requestProjectMemoryRepair(
                    `The project-memory block failed host validation (${error.code || 'invalid payload'}).`
                );
                if (repairStatus === 'not_applicable') {
                    parsed.reply = `${parsed.reply || ''}\n\n⚠️ 專案記憶未寫入：格式、敏感資料或專案邊界檢查未通過。`.trim();
                }
            }
        }

        if (parsed.userMemory) {
            try {
                if (!brain || !brain.webBackend || brain.webBackend.id !== 'm365-web'
                    || !ctx || !ctx.workspaceProjectId
                    || !brain.userProfile
                    || typeof brain.userProfile.applyM365MemoryBlock !== 'function') {
                    throw new Error('M365 user profile service is unavailable.');
                }
                const results = brain.userProfile.applyM365MemoryBlock(parsed.userMemory);
                console.log(`[GOLEM_USER_MEMORY] updated=${results.filter((item) => item.changed).length}`);
            } catch (error) {
                console.warn(`[GOLEM_USER_MEMORY] rejected: ${error.code || error.message}`);
                parsed.reply = `${parsed.reply || ''}\n\n⚠️ 使用者偏好記憶未寫入：格式或敏感資料檢查未通過。`.trim();
            }
        }

        // 1b. 處理記憶防火牆標籤（僅在服務啟用時）
        if (parsed.avoidMemory) {
            const firewall = getMemoryFirewallService();
            if (firewall && firewall.isEnabled()) {
                const pattern = String(parsed.avoidMemory || '').trim();
                if (pattern) {
                    console.log(`[AVOID_MEMORY]\n${pattern}`);
                    await brain.memorize(pattern, {
                        type: 'avoid_memory',
                        source: 'memory_firewall',
                        timestamp: Date.now(),
                        visible: true
                    });
                    const scope = `golem:${(controller && controller.convoManager && controller.convoManager.golemId) || 'default'}`;
                    const addResult = firewall.addRule({
                        pattern,
                        scope,
                        matchMode: 'contains',
                        enabled: true
                    });
                    if (addResult && addResult.success) {
                        console.log(`🛡️ [MemoryFirewall] 已自動建立規則: ${pattern}`);
                    }
                }
            }
        }

        // M365 使用者只需要看到簡潔的執行狀態。Observation、harness 與
        // 核准協議仍保留在宿主內部與專用狀態卡，不讓模型以操作細節打斷對話。
        // plan_checkpoint 的回覆本身就是原生 M365 產出，不能被狀態文字蓋掉。
        if (useM365ActionProgressReply && !needsM365Approval) {
            parsed.reply = parsed.actions.length > 1
                ? `執行本步驟的 ${parsed.actions.length} 個動作，正在執行並確認中…`
                : buildExecutionProgressText(parsed.actions[0]);
        } else if (needsM365Approval) {
            // The approval card above is the complete user-facing status. Avoid
            // following it with a second message that incorrectly says execution
            // has already started.
            parsed.reply = '';
        }
        if (projectMemoryUpdateCount > 0 && !useM365ActionProgressReply && !needsM365Approval) {
            parsed.reply = `${parsed.reply || ''}\n\n✓ 已更新此專案的狀態紀錄（${projectMemoryUpdateCount} 則）`.trim();
        }

        // 1. 處理直接回覆 (讓 AI 的解說文字在行動之前出現)
        if (parsed.reply && !shouldSuppressReply) {
            let finalReply = parsed.reply;
            if (ctx.platform === 'telegram' && ctx.shouldMentionSender) {
                finalReply = `${ctx.senderMention} ${parsed.reply}`;
            }
            if (localContextEnabled) {
                console.log(`[TERMINAL] 🤖 [Golem] 說: ${finalReply}${attachments.length > 0 ? ' 📎 含有附件' : ''}`);
            } else {
                console.log(`🛡️ [NeuroShunter] M365 POC 回覆 ${String(finalReply || '').length} 字元；內容不寫入本機預覽日誌。`);
            }

            // ✨ [Log] 記錄 AI 回應
            if (brain && typeof brain._appendChatLog === 'function') {
                brain._appendChatLog({
                    sender: 'Golem',
                    content: finalReply,
                    type: 'ai',
                    role: 'Assistant',
                    isSystem: false,
                    attachments: attachments
                });
            }

            // 附件處理：若無附件則維持單參數呼叫，相容既有上下文與測試
            if (attachments.length > 0) {
                await ctx.reply(finalReply, buildReplyOptions(ctx, finalReply, { attachments: attachments, ...(responseReplyOptions || {}) }));
            } else {
                const replyOptions = buildReplyOptions(ctx, finalReply, responseReplyOptions || {});
                if (Object.keys(replyOptions).length > 0) {
                    await ctx.reply(finalReply, replyOptions);
                } else {
                    await ctx.reply(finalReply);
                }
            }
        } else if (parsed.reply && shouldSuppressReply) {
            console.log(`🤫 [NeuroShunter] 檢測到靜默模式，已攔截回覆內容。`);
        }

        if (protocolRepair?.status === 'retry' && protocolRepair.prompt) {
            const convoManager = controller && controller.convoManager;
            if (convoManager && typeof convoManager.enqueue === 'function') {
                await convoManager.enqueue(ctx, protocolRepair.prompt, {
                    isPriority: true,
                    bypassDebounce: true,
                    isSystemFeedback: true,
                    allowActions: true,
                    planMode: true,
                    actionDepth: Number(options.actionDepth || 0),
                    maxActionDepth: Number(options.maxActionDepth || CONFIG.MAX_AUTO_TURNS || 5),
                    workspaceConversationId: ctx.workspaceConversationId || null,
                    workspaceRunId: options.workspaceRunId || null,
                    workspacePlanId: options.workspacePlanId || null,
                    workspacePlanRevision: Number(options.workspacePlanRevision || 0),
                    resetAutoTurnBudget: options.resetAutoTurnBudget === true,
                    toolRoutingQuery: String(protocolRepair.toolRoutingQuery || ''),
                });
            } else if (!protocolRepair.message) {
                await ctx.reply('⚠️ 工作需要修正下一步，但目前找不到可用的對話佇列；已安全暫停。');
            }
        }

        if (projectMemoryRepair?.prompt) {
            const convoManager = controller && controller.convoManager;
            const repairOptions = {
                isPriority: true,
                bypassDebounce: true,
                isSystemFeedback: true,
                allowActions: false,
                planMode: false,
                m365ProjectMemoryRequired: true,
                projectMemoryRepairAttempt: projectMemoryRepair.attempt,
                workspaceConversationId: ctx.workspaceConversationId || null,
                toolRoutingQuery: String(ctx.toolRoutingQuery || ''),
            };
            if (convoManager && typeof convoManager.enqueue === 'function') {
                await convoManager.enqueue(ctx, projectMemoryRepair.prompt, repairOptions);
            } else if (brain && typeof brain.sendMessage === 'function') {
                const repaired = await brain.sendMessage(projectMemoryRepair.prompt, false, repairOptions);
                await this.dispatch(ctx, repaired, brain, controller, repairOptions);
            } else {
                await ctx.reply('⚠️ 本輪需要更新專案記憶，但目前找不到可用的補正佇列。');
            }
        }

        const blockedObservationActions = isSystemFeedback
            && parsed.actions.length > 0
            && (!allowActions || actionDepth >= maxActionDepth);

        if (blockedObservationActions) {
            console.warn(
                `[NeuroShunter] System Observation 產生 ${parsed.actions.length} 個 action，已阻擋。` +
                ` allowActions=${allowActions}, depth=${actionDepth}/${maxActionDepth}`
            );

            if (!shouldSuppressReply) {
                const retryAttempt = Number(options.observationRetryAttempt || 0);
                const compactActions = JSON.stringify(parsed.actions, null, 2);
                // 第一次錯誤：不需要使用者批准，先要求 Golem 依範例重寫並自動再執行一次
                if (retryAttempt < 1 && controller && controller.convoManager) {
                    const rewritePrompt = `[System Observation]\n` +
                        `你上一輪輸出的 [GOLEM_ACTION] 無法執行，請先重寫成正確格式後再執行一次。\n\n` +
                        `[PREVIOUS_INVALID_ACTIONS]\n` +
                        `${compactActions}\n\n` +
                        `修正規則：\n` +
                        `- 輸出完成目前步驟所需的最小 action 陣列；可包含多個依序執行的動作。\n` +
                        `- 若是行事曆，請用：{"action":"collab-calendar","args":{"action":"add","title":"...","start":"...","end":"..."}}\n` +
                        `- mcp_call 必須包含 server + tool + parameters。\n` +
                        `- command 必須放在 parameter 欄位。\n`;
                    await ctx.reply(
                        `⚠️ 系統偵測到指令格式錯誤，已先要求 Golem 依範例重寫並自動再試一次。`
                    );
                    await controller.convoManager.enqueue(ctx, rewritePrompt, {
                        isPriority: true,
                        bypassDebounce: true,
                        isSystemFeedback: true,
                        allowActions: true,
                        actionDepth: Number(actionDepth || 0) + 1,
                        maxActionDepth: Number(maxActionDepth || CONFIG.MAX_AUTO_TURNS || 5),
                        observationRetryAttempt: retryAttempt + 1,
                        m365ProjectMemoryRequired: brain?.webBackend?.id === 'm365-web',
                    });
                } else if (controller && controller.pendingTasks) {
                    // 第二次仍錯：才出現通訊端批准按鈕
                    const approvalId = uuidv4();
                    controller.pendingTasks.set(approvalId, {
                        type: 'OBSERVATION_ACTION_APPROVAL',
                        ctx,
                        timestamp: Date.now(),
                        proposedActions: parsed.actions,
                        actionDepth: Number(actionDepth || 0),
                        maxActionDepth: Number(maxActionDepth || CONFIG.MAX_AUTO_TURNS || 5),
                    });
                    await ctx.reply(
                        `⚠️ 指令重寫後仍然失敗，系統已暫停自動再執行。\n\n` +
                        `以下是被擋下的候選 action：\n` +
                        `\`\`\`json\n${compactActions.slice(0, 3500)}\n\`\`\`\n` +
                        `是否要要求 Golem 依範例重寫後再執行？`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '✅ 要求 Golem 重寫再執行', callback_data: `RETRYOBS_${approvalId}` },
                                    { text: '🛑 停止本輪 action', callback_data: `STOPOBS_${approvalId}` }
                                ]]
                            }
                        }
                    );
                } else {
                    await ctx.reply(
                        `⚠️ 指令重寫後仍失敗，系統已阻擋自動再執行。\n` +
                        `請在通訊端明確批准下一步（例如回覆「再來一次」或按審批按鈕）後才會繼續。`
                    );
                }
            }
            parsed.actions = [];
        }

        // 2. 處理結構化 Action 分配 (讓批准視窗在回覆之後彈出)
        if (parsed.actions.length > 0) {
            console.log(`[GOLEM_ACTION] (${shouldSuppressReply ? 'Silent' : 'Normal'})\n${JSON.stringify(parsed.actions, null, 2)}`);
            const commandActions = [];
            const rejectedActions = [];
            const turnActiveTools = [
                ...toolsetManager.getActiveTools(),
                ...(Array.isArray(options.preferredSkillIds) ? options.preferredSkillIds : []),
                ...(Array.isArray(options.preferredSkillActions) ? options.preferredSkillActions : []),
            ];

            for (const originalAct of parsed.actions) {
                let act = originalAct;

                const gateOptions = {
                    activeTools: turnActiveTools,
                    planMode: options.planMode === true,
                };
                if (!ActionExecutionGate.validate(act, gateOptions).ok) {
                    const slashRecovery = this._tryRecoverSlashAction(act);
                    if (slashRecovery && slashRecovery.action) {
                        console.log(slashRecovery.note);
                        act = slashRecovery.action;
                    }
                }

                const gate = ActionExecutionGate.validate(act, gateOptions);
                if (!gate.ok) {
                    rejectedActions.push({ action: act, error: gate.error, code: gate.code });
                    continue;
                }
                if (gate.normalizedAction && gate.normalizedAction !== act.action) {
                    act.action = gate.normalizedAction;
                }
                switch (act.action) {
                    case 'plan_checkpoint':
                        await this._executePlanCheckpoint(ctx, act, brain, controller, options);
                        break;
                    case 'multi_agent':
                        await MultiAgentHandler.execute(ctx, act, controller, brain);
                        break;
                    case 'command':
                    case 'sys-admin':
                        commandActions.push(act);
                        break;
                    default:
                        const isSkillHandled = await SkillHandler.execute(ctx, act, brain, controller, {
                            actionDepth,
                            maxActionDepth,
                            allowActions,
                            planMode: options.planMode === true,
                            workspaceRunId: options.workspaceRunId || null,
                            workspaceStepId: options.workspaceStepId || null,
                            workspacePlanId: options.workspacePlanId || null,
                            workspacePlanRevision: Number(options.workspacePlanRevision || 0),
                            workspacePlanStepId: options.workspacePlanStepId || null,
                            workspaceActionId: options.workspaceActionId || null,
                        });
                        if (!isSkillHandled) {
                            rejectedActions.push({
                                action: act,
                                code: 'ACTION_HANDLER_UNAVAILABLE',
                                error: `Validated action "${act.action}" was not handled by its registered handler.`,
                            });
                        }
                        break;
                }
            }

            if (rejectedActions.length > 0) {
                const reasonText = rejectedActions
                    .map((item, idx) => {
                        const compactAction = JSON.stringify(item.action || {})
                            .replace(/\s+/g, ' ')
                            .slice(0, 220);
                        return `- [${idx + 1}] ${item.code}: ${item.error} | action=${compactAction}`;
                    })
                    .join('\n');
                console.warn(`[ActionGate] Rejected ${rejectedActions.length} invalid actions:\n${reasonText}`);

                // ── 建構結構化的 [System Observation] 回饋給 Golem ──────────
                // 讓 Golem 知道哪些 action 失敗、原因是什麼，並能自行修正
                const observationLines = [
                    `[System Observation] ⚠️ ActionGate 攔截報告：${rejectedActions.length} 個 action 執行失敗`,
                    '',
                ];

                for (const item of rejectedActions) {
                    const actionName = String(item.action?.action || '(unknown)');
                    observationLines.push(`❌ action="${actionName}" → 失敗原因: ${item.code}`);
                    observationLines.push(`   詳情: ${item.error}`);

                    if (item.code === 'TOOLSET_DISABLED') {
                        observationLines.push(`   ⚡ 修正方式: 此技能存在但目前場景未啟用。請告知使用者需要切換場景，或直接輸出 /toolset <場景名稱> 指令。`);
                    } else if (item.code === 'UNKNOWN_ACTION') {
                        observationLines.push(`   ⚡ 修正方式: 此 action 不存在。請改用 command / mcp_call / 已安裝技能的 action 名稱。`);
                        observationLines.push(`   ✅ MCP 複合指令範例(先瀏覽再快照): [{"action":"mcp_call","server":"chrome-devtools","tool":"navigate_page","parameters":{"url":"https://example.com","timeout":60000}},{"action":"mcp_call","server":"chrome-devtools","tool":"take_snapshot","parameters":{}}]`);
                        observationLines.push(`   ✅ MCP 正確範例(搜尋): {"action":"mcp_call","server":"chrome-devtools","tool":"navigate_page","parameters":{"url":"https://html.duckduckgo.com/html/?q=%E9%97%9C%E9%8D%B5%E5%AD%97&kl=tw-tzh","timeout":60000}}`);
                        observationLines.push(`   ✅ MCP 正確範例(抽結果): {"action":"mcp_call","server":"chrome-devtools","tool":"evaluate_script","parameters":{"function":"() => Array.from(document.querySelectorAll('a.result__a')).slice(0, 10).map(a => ({ title: a.textContent.trim(), url: a.href }))"}}`);
                    } else if (item.code === 'INVALID_MCP_CALL') {
                        observationLines.push(`   ⚡ 修正方式: mcp_call 必須包含 server 和 tool 欄位。`);
                        observationLines.push(`   ✅ 格式模板: {"action":"mcp_call","server":"<server>","tool":"<tool>","parameters":{...}}`);
                        observationLines.push(`   ✅ 瀏覽模板(兩步): [{"action":"mcp_call","server":"chrome-devtools","tool":"navigate_page","parameters":{"url":"https://example.com","timeout":60000}},{"action":"mcp_call","server":"chrome-devtools","tool":"take_snapshot","parameters":{}}]`);
                    } else if (item.code === 'ACTION_HANDLER_UNAVAILABLE') {
                        observationLines.push(`   ⚡ 修正方式: 請確認對應 Skill 或 MCP 已安裝並啟用；除非任務本來就是本機命令，否則不要改寫成 shell 指令。`);
                    }
                    observationLines.push('');
                }

                observationLines.push('請根據以上資訊修正你的 [GOLEM_ACTION]，或告知使用者需要的操作。');
                const observationText = observationLines.join('\n');
                const canRetryFromGateFeedback = actionDepth < maxActionDepth;

                // 透過 convoManager 注入 [System Observation]（讓 Golem 的下一輪能看到）
                // ActionGate 回灌後允許進行修正重試（受 actionDepth/maxActionDepth 保護）。
                if (options.planMode === true) {
                    let recorded = null;
                    if (typeof ctx.onGolemObservation === 'function') {
                        recorded = await ctx.onGolemObservation({
                            runId: options.workspaceRunId,
                            stepId: options.workspaceStepId,
                            actionId: options.workspaceActionId,
                            planStepId: options.workspacePlanStepId,
                            lane: 'action_gate',
                            status: 'failed',
                            result: observationText,
                        });
                    }
                    if (brain?.webBackend?.id === 'm365-web' && ctx) {
                        ctx.workspaceProjectMemoryRequired = true;
                    }
                    const nextDepth = actionDepth + 1;
                    const planObservation = buildM365PlanObservation({
                        planId: options.workspacePlanId || recorded?.planId,
                        planRevision: options.workspacePlanRevision || recorded?.planRevision,
                        stepId: options.workspaceStepId,
                        planStepId: options.workspacePlanStepId,
                        actionId: options.workspaceActionId,
                        lane: 'action_gate',
                        status: 'failed',
                        result: observationText,
                    });
                    if (controller && controller.convoManager) {
                        await controller.convoManager.enqueue(ctx, planObservation, {
                            isPriority: true,
                            bypassDebounce: true,
                            isSystemFeedback: true,
                            suppressReply: false,
                            allowActions: nextDepth < maxActionDepth,
                            actionDepth: nextDepth,
                            maxActionDepth,
                            maxAutoTurns: maxActionDepth + 1,
                            planMode: true,
                            workspaceConversationId: ctx.workspaceConversationId || null,
                            workspaceRunId: options.workspaceRunId,
                            workspaceStepId: options.workspaceStepId,
                            workspacePlanId: options.workspacePlanId || recorded?.planId,
                            workspacePlanRevision: options.workspacePlanRevision || recorded?.planRevision,
                            workspacePlanStepId: options.workspacePlanStepId,
                            workspaceActionId: options.workspaceActionId,
                            m365ProjectMemoryRequired: brain?.webBackend?.id === 'm365-web',
                        });
                    }
                } else if (controller && controller.convoManager) {
                    if (brain?.webBackend?.id === 'm365-web' && ctx) {
                        ctx.workspaceProjectMemoryRequired = true;
                    }
                    await controller.convoManager.enqueue(ctx, observationText, {
                        isPriority: true,
                        bypassDebounce: true,
                        isSystemFeedback: true,
                        suppressReply: true,
                        allowActions: canRetryFromGateFeedback,
                        actionDepth: actionDepth + 1,
                        maxActionDepth,
                        m365ProjectMemoryRequired: brain?.webBackend?.id === 'm365-web',
                    });
                } else if (brain && typeof brain.sendMessage === 'function') {
                    try {
                        await brain.sendMessage(observationText, false, {
                            isSystemFeedback: true,
                            allowActions: canRetryFromGateFeedback,
                            disableToolRouting: true,
                            suppressReply: true,
                            actionDepth: actionDepth + 1,
                            maxActionDepth,
                            m365ProjectMemoryRequired: brain?.webBackend?.id === 'm365-web',
                        });
                    } catch (injectErr) {
                        console.warn(`[ActionGate] Failed to inject fallback observation to brain: ${injectErr.message}`);
                    }
                } else if (!shouldSuppressReply) {
                    // fallback：直接 reply 給使用者（不走 feedback loop）
                    const firstUnknown = rejectedActions.find((item) => item.code === 'UNKNOWN_ACTION');
                    if (firstUnknown && firstUnknown.action && firstUnknown.action.action) {
                        await ctx.reply(this._buildUnknownActionMessage(String(firstUnknown.action.action)));
                    }
                    const toolsetRejected = rejectedActions.filter(i => i.code === 'TOOLSET_DISABLED');
                    if (toolsetRejected.length > 0) {
                        const names = toolsetRejected.map(i => `\`${i.action?.action}\``).join(', ');
                        await ctx.reply(`⚠️ 技能 ${names} 在目前場景未啟用。\n${toolsetRejected[0].error}`);
                    } else {
                        await ctx.reply(
                            `⚠️ 已阻擋 ${rejectedActions.length} 個無效行動（格式或權限不符）。\n` +
                            `請改用有效 action（command / mcp_call / 已安裝技能）。`
                        );
                    }
                }
            }

            // 處理剩餘的終端指令序列並自動啟動回饋循環 (Feedback Loop)
            if (commandActions.length > 0) {
                await CommandHandler.execute(ctx, commandActions, controller, brain, (c, r, b, ctrl) => this.dispatch(c, r, b, ctrl, options), {
                    actionDepth,
                    maxActionDepth,
                    allowActions,
                    m365ActionApproved: options.m365ActionApproved === true,
                    actionQueueManaged: options.actionQueueManaged === true,
                    planMode: options.planMode === true,
                    workspaceRunId: options.workspaceRunId || null,
                    workspaceStepId: options.workspaceStepId || null,
                    workspacePlanId: options.workspacePlanId || null,
                    workspacePlanRevision: Number(options.workspacePlanRevision || 0),
                    workspacePlanStepId: options.workspacePlanStepId || null,
                    workspaceActionId: options.workspaceActionId || null,
                });
            }
        }
    }
}

module.exports = NeuroShunter;
