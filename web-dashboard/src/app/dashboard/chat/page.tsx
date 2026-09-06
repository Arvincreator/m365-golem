"use client";

import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowDown,
    AlertTriangle,
    Bot,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    CirclePause,
    ExternalLink,
    FileUp,
    FileText,
    FolderUp,
    FolderKanban,
    ListChecks,
    Loader2,
    MessageSquarePlus,
    Play,
    Plus,
    RotateCcw,
    Send,
    ShieldCheck,
    Square,
    Paperclip,
    UserRound,
    X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import M365MessageContent from "@/components/M365MessageContent";
import { apiGet, apiPost } from "@/lib/api-client";
import { apiUrl } from "@/lib/api";
import { isNearChatBottom } from "@/lib/m365-message-rendering";
import { socket } from "@/lib/socket";
import { cn } from "@/lib/utils";
import {
    M365_ATTACHMENT_ACCEPT,
    collectDroppedAttachmentCandidates,
    fileToBase64,
    formatAttachmentSize,
    mergeAttachmentCandidates,
    type AttachmentCandidate,
    type PendingM365Attachment,
} from "@/lib/m365-attachments";
import { useM365WorkspaceSelection } from "@/components/M365WorkspaceContext";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    formatLocalDate,
    getBindingLabel,
    getRunStatusLabel,
    type M365Conversation,
    type M365Message,
    type M365Project,
    type M365ProjectWorkspace,
    type M365Run,
    type M365RunDetail,
} from "@/lib/m365-workspace";

type SocketLog = {
    projectId?: string;
    conversationId?: string;
    requestId?: string;
    type?: string;
};

type PendingLocalAction = {
    id: string;
    type: string;
    title: string;
    summary: string;
    actionCount: number;
    requestedAt: number;
    expiresAt: number;
};

type ActionExecutionItem = {
    id: string;
    status: "queued" | "running";
    position: number;
    title: string;
    summary: string;
    actionCount: number;
    requestedAt: number;
};

type PendingM365Response = {
    requestId: string;
    conversationId: string;
    retryCount: number;
    timedOutAt: number;
    status: "needs_recheck" | "manual_check_required";
};

type ResponseMode = "auto" | "quick" | "thoughtful";
type ApprovalMode = "manual" | "auto";
type ComposerPicker = "files" | "mcp" | "skills" | null;

type ReferenceFileOption = {
    id: string;
    name: string;
    path: string;
    enabled?: boolean;
    status: "pending" | "ready" | "failed";
};

type McpServerOption = {
    name: string;
    description?: string;
    enabled: boolean;
    connected?: boolean;
};

type SkillOption = {
    id: string;
    name: string;
    description?: string;
    action: string;
};

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : "目前無法完成，請稍後再試。";
}

function deliveryLabel(message: M365Message): string {
    if (message.deliveryState === "ambiguous") return "傳送結果不明，請先到 Edge 核對";
    if (message.deliveryState === "failed") return "未送達";
    if (message.deliveryState === "dispatch_started") return "傳送中";
    if (message.deliveryState === "confirmed") return "已送達 M365";
    if (message.deliveryState === "response_confirmed") return "已擷取";
    if (message.role === "user") return "已排隊";
    return "已保存";
}

function isRunTerminal(run: M365Run): boolean {
    return ["FAILED", "CANCELED", "COMPLETED"].includes(run.status);
}

function isCollapsibleActionMessage(message: M365Message): boolean {
    if (message.role === "user") return false;
    return /M365 工作台已暫停一項工具動作|\[GOLEM_ACTION\]|"action"\s*:\s*"(?:command|mcp_call|multi_agent)"/i.test(message.content);
}

function CollapsibleActionMessage({ content }: { content: string }) {
    return (
        <details className="group min-w-[min(68vw,420px)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-1 py-0.5 text-sm font-medium marker:content-none">
                <span className="flex min-w-0 items-center gap-2">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="truncate">工具動作等待核准</span>
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="prose prose-sm mt-3 max-w-none break-words border-t border-border/70 pt-3 text-foreground dark:prose-invert prose-p:my-2 prose-pre:max-h-64 prose-pre:overflow-auto">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
        </details>
    );
}

export default function M365ChatPage() {
    const {
        hydrated,
        activeProjectId,
        activeConversationId,
    } = useM365WorkspaceSelection();
    const [project, setProject] = useState<M365Project | null>(null);
    const [projectWorkspace, setProjectWorkspace] = useState<M365ProjectWorkspace | null>(null);
    const [conversation, setConversation] = useState<M365Conversation | null>(null);
    const [messages, setMessages] = useState<M365Message[]>([]);
    const [runs, setRuns] = useState<M365Run[]>([]);
    const [pendingLocalActions, setPendingLocalActions] = useState<PendingLocalAction[]>([]);
    const [actionExecutionQueue, setActionExecutionQueue] = useState<ActionExecutionItem[]>([]);
    const [pendingResponses, setPendingResponses] = useState<PendingM365Response[]>([]);
    const [recheckingRequestId, setRecheckingRequestId] = useState("");
    const [toolActionsEnabled, setToolActionsEnabled] = useState(true);
    const [decidingActionId, setDecidingActionId] = useState("");
    const [input, setInput] = useState("");
    const [responseMode, setResponseMode] = useState<ResponseMode>("auto");
    const [approvalMode, setApprovalMode] = useState<ApprovalMode>("manual");
    const [savingApprovalMode, setSavingApprovalMode] = useState(false);
    const [composerMenuOpen, setComposerMenuOpen] = useState(false);
    const [composerPicker, setComposerPicker] = useState<ComposerPicker>(null);
    const [composerResourcesLoading, setComposerResourcesLoading] = useState(true);
    const [composerResourceError, setComposerResourceError] = useState("");
    const [referenceFiles, setReferenceFiles] = useState<ReferenceFileOption[]>([]);
    const [mcpServers, setMcpServers] = useState<McpServerOption[]>([]);
    const [skills, setSkills] = useState<SkillOption[]>([]);
    const [selectedReferenceFileIds, setSelectedReferenceFileIds] = useState<string[]>([]);
    const [selectedMcpServerNames, setSelectedMcpServerNames] = useState<string[]>([]);
    const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
    const [pendingAttachments, setPendingAttachments] = useState<PendingM365Attachment[]>([]);
    const [attachmentWarnings, setAttachmentWarnings] = useState<string[]>([]);
    const [attachmentProgress, setAttachmentProgress] = useState("");
    const [dragActive, setDragActive] = useState(false);
    const [showAgentsEditor, setShowAgentsEditor] = useState(false);
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [activating, setActivating] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [showRuns, setShowRuns] = useState(true);
    const [runSaving, setRunSaving] = useState(false);
    const [runDetail, setRunDetail] = useState<M365RunDetail | null>(null);
    const [runInput, setRunInput] = useState("");
    const [followingLatest, setFollowingLatest] = useState(true);
    const scrollRef = useRef<HTMLDivElement>(null);
    const followingLatestRef = useRef(true);
    const initialConversationScrollRef = useRef(false);
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);

    const currentRun = useMemo(
        () => runs.find((run) => !isRunTerminal(run)) || runs[0] || null,
        [runs]
    );
    const pendingApproval = useMemo(
        () => runDetail?.approvals.find((approval) => approval.status === "pending") || null,
        [runDetail]
    );
    const completedRequestIds = useMemo(() => new Set(
        messages.filter((message) => message.role === "assistant" && message.requestId).map((message) => message.requestId as string)
    ), [messages]);
    const queuedDialogueCount = useMemo(() => messages.filter(
        (message) => message.role === "user" && message.deliveryState === "local"
    ).length, [messages]);
    const activeDialogueCount = useMemo(() => messages.filter(
        (message) => message.role === "user"
            && ["dispatch_started", "confirmed"].includes(message.deliveryState)
            && (!message.requestId || !completedRequestIds.has(message.requestId))
    ).length, [completedRequestIds, messages]);
    const latestMessageKey = useMemo(() => {
        const latest = messages[messages.length - 1];
        return latest
            ? `${activeConversationId || "none"}:${latest.id}:${latest.deliveryState}:${latest.content.length}:${latest.createdAt}`
            : `${activeConversationId || "none"}:empty`;
    }, [activeConversationId, messages]);

    const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
        const target = scrollRef.current;
        if (!target) return;
        followingLatestRef.current = true;
        setFollowingLatest(true);
        target.scrollTo({ top: target.scrollHeight, behavior });
    }, []);

    const handleConversationScroll = useCallback(() => {
        const target = scrollRef.current;
        if (!target) return;
        const next = isNearChatBottom(target);
        followingLatestRef.current = next;
        setFollowingLatest((current) => current === next ? current : next);
    }, []);

    const loadMessages = useCallback(async () => {
        if (!activeConversationId) return [];
        const data = await apiGet<{ messages: M365Message[] }>(
            apiUrl(`/api/conversations/${encodeURIComponent(activeConversationId)}/messages?limit=500`),
            undefined,
            { retries: 0 }
        );
        const items = data.messages || [];
        setMessages(items);
        return items;
    }, [activeConversationId]);

    const loadRuns = useCallback(async () => {
        if (!activeConversationId) return;
        const data = await apiGet<{ runs: M365Run[] }>(
            apiUrl(`/api/conversations/${encodeURIComponent(activeConversationId)}/runs`),
            undefined,
            { retries: 0 }
        );
        const items = data.runs || [];
        setRuns(items);
        const selected = items.find((run) => !isRunTerminal(run)) || items[0] || null;
        if (!selected) {
            setRunDetail(null);
            return;
        }
        const detail = await apiGet<M365RunDetail>(
            apiUrl(`/api/runs/${encodeURIComponent(selected.id)}`),
            undefined,
            { retries: 0 }
        );
        setRunDetail(detail);
    }, [activeConversationId]);

    const loadPendingLocalActions = useCallback(async () => {
        if (!activeConversationId) {
            setPendingLocalActions([]);
            setActionExecutionQueue([]);
            return;
        }
        const data = await apiGet<{ actionsEnabled: boolean; items: PendingLocalAction[]; executionQueue?: ActionExecutionItem[] }>(
            apiUrl(`/api/chat/pending-actions?golemId=golem_A&conversationId=${encodeURIComponent(activeConversationId)}`),
            undefined,
            { retries: 0 }
        );
        setToolActionsEnabled(data.actionsEnabled !== false);
        setPendingLocalActions(data.items || []);
        setActionExecutionQueue(data.executionQueue || []);
    }, [activeConversationId]);

    const loadPendingResponses = useCallback(async () => {
        if (!activeConversationId) {
            setPendingResponses([]);
            return;
        }
        const data = await apiGet<{ items: PendingM365Response[] }>(
            apiUrl(`/api/chat/pending-responses?conversationId=${encodeURIComponent(activeConversationId)}`),
            undefined,
            { retries: 0 }
        );
        setPendingResponses(data.items || []);
    }, [activeConversationId]);

    const loadProjectWorkspace = useCallback(async () => {
        if (!activeProjectId) return null;
        const data = await apiGet<{ workspace: M365ProjectWorkspace }>(
            apiUrl(`/api/projects/${encodeURIComponent(activeProjectId)}/workspace`),
            undefined,
            { retries: 0 }
        );
        setProjectWorkspace(data.workspace);
        return data.workspace;
    }, [activeProjectId]);

    const loadContext = useCallback(async () => {
        if (!activeProjectId || !activeConversationId) return;
        const [projectData, conversationData] = await Promise.all([
            apiGet<{ project: M365Project }>(apiUrl(`/api/projects/${encodeURIComponent(activeProjectId)}`)),
            apiGet<{ conversation: M365Conversation }>(apiUrl(`/api/conversations/${encodeURIComponent(activeConversationId)}`)),
            loadProjectWorkspace(),
        ]);
        if (conversationData.conversation.projectId !== projectData.project.id) {
            throw new Error("目前選取的對話不屬於這個專案，請回到專案頁重新選擇。");
        }
        setProject(projectData.project);
        setConversation(conversationData.conversation);
        await Promise.all([loadMessages(), loadRuns(), loadPendingLocalActions(), loadPendingResponses()]);
        setError("");
    }, [activeConversationId, activeProjectId, loadMessages, loadPendingLocalActions, loadPendingResponses, loadProjectWorkspace, loadRuns]);

    useEffect(() => {
        if (!hydrated || !activeProjectId || !activeConversationId) {
            setProject(null);
            setConversation(null);
            setProjectWorkspace(null);
            setMessages([]);
            setRuns([]);
            setRunDetail(null);
            setPendingLocalActions([]);
            setActionExecutionQueue([]);
            setPendingResponses([]);
            setError("");
            setLoading(false);
            return;
        }
        let mounted = true;
        setLoading(true);
        loadContext()
            .catch((requestError) => mounted && setError(errorMessage(requestError)))
            .finally(() => mounted && setLoading(false));
        return () => { mounted = false; };
    }, [activeConversationId, activeProjectId, hydrated, loadContext]);

    useEffect(() => {
        setPendingAttachments([]);
        setAttachmentWarnings([]);
        setAttachmentProgress("");
        setDragActive(false);
    }, [activeConversationId, activeProjectId]);

    useEffect(() => {
        followingLatestRef.current = true;
        initialConversationScrollRef.current = false;
        setFollowingLatest(true);
    }, [activeConversationId]);

    useEffect(() => {
        let mounted = true;
        const savedMode = window.localStorage.getItem("m365-golem-response-mode");
        if (["auto", "quick", "thoughtful"].includes(String(savedMode))) {
            setResponseMode(savedMode as ResponseMode);
        }

        setComposerResourcesLoading(true);
        Promise.allSettled([
            apiGet<{ files?: ReferenceFileOption[] }>(apiUrl("/api/reference-files"), undefined, { retries: 0 }),
            apiGet<{ servers?: McpServerOption[] }>(apiUrl("/api/mcp/servers"), undefined, { retries: 0 }),
            apiGet<{ skills?: SkillOption[] }>(apiUrl("/api/chat/skill-options"), undefined, { retries: 0 }),
            apiGet<{ approvalMode?: ApprovalMode }>(apiUrl("/api/chat/preferences"), undefined, { retries: 0 }),
        ]).then((results) => {
            if (!mounted) return;
            const [fileResult, mcpResult, skillResult, preferenceResult] = results;
            if (fileResult.status === "fulfilled") {
                setReferenceFiles((fileResult.value.files || []).filter((file) => (
                    file.enabled !== false
                    && file.status === "ready"
                    && !/(^|[\\/])\.env(?:\.|$)/i.test(file.path)
                )));
            }
            if (mcpResult.status === "fulfilled") {
                setMcpServers((mcpResult.value.servers || []).filter((server) => server.enabled !== false));
            }
            if (skillResult.status === "fulfilled") {
                setSkills(skillResult.value.skills || []);
            }
            if (preferenceResult.status === "fulfilled" && ["manual", "auto"].includes(String(preferenceResult.value.approvalMode))) {
                setApprovalMode(preferenceResult.value.approvalMode as ApprovalMode);
            }
            if (results.some((result) => result.status === "rejected")) {
                setComposerResourceError("部分工具清單暫時無法載入；一般文字對話仍可使用。");
            }
        }).finally(() => {
            if (mounted) setComposerResourcesLoading(false);
        });

        return () => { mounted = false; };
    }, []);

    useEffect(() => {
        const handleWorkspaceUpdate = (event: Event) => {
            const detail = (event as CustomEvent<{ conversationId?: string }>).detail;
            if (detail?.conversationId && detail.conversationId !== activeConversationId) return;
            setError("");
            loadContext().catch((requestError) => setError(errorMessage(requestError)));
        };
        window.addEventListener("m365-workspace-updated", handleWorkspaceUpdate);
        return () => window.removeEventListener("m365-workspace-updated", handleWorkspaceUpdate);
    }, [activeConversationId, loadContext]);

    useEffect(() => {
        const handleLog = (payload: SocketLog) => {
            if (payload?.conversationId !== activeConversationId) return;
            loadMessages().catch(() => undefined);
            loadRuns().catch(() => undefined);
            loadPendingLocalActions().catch(() => undefined);
            loadPendingResponses().catch(() => undefined);
            loadProjectWorkspace().catch(() => undefined);
        };
        socket.on("log", handleLog);
        return () => { socket.off("log", handleLog); };
    }, [activeConversationId, loadMessages, loadPendingLocalActions, loadPendingResponses, loadProjectWorkspace, loadRuns]);

    useEffect(() => {
        if (!activeConversationId) return;
        const timer = window.setInterval(() => {
            loadPendingLocalActions().catch(() => undefined);
            loadPendingResponses().catch(() => undefined);
            loadMessages().catch(() => undefined);
        }, 2500);
        return () => window.clearInterval(timer);
    }, [activeConversationId, loadMessages, loadPendingLocalActions, loadPendingResponses]);

    useEffect(() => {
        const target = scrollRef.current;
        if (loading || !target || messages.length === 0) return;
        const isInitialPosition = !initialConversationScrollRef.current;
        if (!initialConversationScrollRef.current) {
            initialConversationScrollRef.current = true;
        }
        const frame = window.requestAnimationFrame(() => {
            if (isInitialPosition) {
                scrollToLatest("auto");
            } else if (followingLatestRef.current) {
                scrollToLatest("smooth");
            }
        });
        return () => window.cancelAnimationFrame(frame);
    }, [latestMessageKey, loading, messages.length, scrollToLatest]);

    const toggleReferenceFile = (id: string) => {
        setComposerResourceError("");
        setSelectedReferenceFileIds((current) => {
            if (current.includes(id)) return current.filter((item) => item !== id);
            if (current.length >= 3) {
                setComposerResourceError("每次最多選擇 3 個參考檔案。");
                return current;
            }
            return [...current, id];
        });
    };

    const toggleMcpServer = (name: string) => {
        setComposerResourceError("");
        setSelectedMcpServerNames((current) => {
            if (current.includes(name)) return current.filter((item) => item !== name);
            if (current.length >= 3) {
                setComposerResourceError("每次最多選擇 3 個 MCP 工具來源。");
                return current;
            }
            return [...current, name];
        });
    };

    const toggleSkill = (id: string) => {
        setComposerResourceError("");
        setSelectedSkillIds((current) => {
            if (current.includes(id)) return current.filter((item) => item !== id);
            if (current.length >= 3) {
                setComposerResourceError("每次最多選擇 3 個 Skills。");
                return current;
            }
            return [...current, id];
        });
    };

    const addAttachmentCandidates = useCallback((candidates: AttachmentCandidate[]) => {
        setAttachmentWarnings([]);
        setPendingAttachments((current) => {
            const merged = mergeAttachmentCandidates(current, candidates);
            setAttachmentWarnings(merged.warnings);
            return merged.attachments;
        });
    }, []);

    const addFiles = (files: FileList | null) => {
        if (!files) return;
        addAttachmentCandidates(Array.from(files).map((file) => ({
            file,
            displayPath: file.webkitRelativePath || file.name,
        })));
    };

    const removePendingAttachment = (id: string) => {
        setPendingAttachments((current) => current.filter((item) => item.id !== id));
        setAttachmentWarnings([]);
    };

    const handleAttachmentDrop = async (event: React.DragEvent<HTMLFormElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setDragActive(false);
        if (sending || conversation?.bindingState === "reconcile_required") return;
        try {
            const candidates = await collectDroppedAttachmentCandidates(event.dataTransfer);
            addAttachmentCandidates(candidates);
        } catch (dropError) {
            setAttachmentWarnings([errorMessage(dropError)]);
        }
    };

    const cancelStagedAttachmentBatch = async (batchId: string) => {
        if (!project || !conversation || !batchId) return;
        await apiPost(
            apiUrl(`/api/m365/attachments/batches/${encodeURIComponent(batchId)}/cancel`),
            { projectId: project.id, conversationId: conversation.id },
            undefined,
            { retries: 0 }
        ).catch(() => undefined);
    };

    const stagePendingAttachmentBatch = async (): Promise<string> => {
        if (!project || !conversation || pendingAttachments.length === 0) return "";
        const batch = await apiPost<{ batchId: string }>(
            apiUrl("/api/m365/attachments/batches"),
            { projectId: project.id, conversationId: conversation.id },
            undefined,
            { retries: 0 }
        );
        try {
            for (let index = 0; index < pendingAttachments.length; index += 1) {
                const item = pendingAttachments[index];
                setAttachmentProgress(`準備附件 ${index + 1}/${pendingAttachments.length}：${item.file.name}`);
                const base64Data = await fileToBase64(item.file);
                await apiPost(
                    apiUrl(`/api/m365/attachments/batches/${encodeURIComponent(batch.batchId)}/files`),
                    {
                        projectId: project.id,
                        conversationId: conversation.id,
                        fileName: item.file.name,
                        base64Data,
                    },
                    undefined,
                    { retries: 0 }
                );
            }
            return batch.batchId;
        } catch (stageError) {
            await cancelStagedAttachmentBatch(batch.batchId);
            throw stageError;
        }
    };

    const changeResponseMode = (mode: ResponseMode) => {
        setResponseMode(mode);
        window.localStorage.setItem("m365-golem-response-mode", mode);
    };

    const changeApprovalMode = async (mode: ApprovalMode) => {
        if (mode === approvalMode || savingApprovalMode) return;
        if (mode === "auto" && !window.confirm(
            "自動核准會讓新提出的工具動作通過安全閘後直接執行，可能修改本機檔案或外部系統。破壞性規則仍會攔截。確定開啟嗎？"
        )) return;

        setSavingApprovalMode(true);
        setError("");
        try {
            const result = await apiPost<{ approvalMode: ApprovalMode }>(apiUrl("/api/chat/preferences"), { approvalMode: mode });
            setApprovalMode(result.approvalMode);
            setNotice(mode === "auto" ? "已開啟自動核准；工具仍須通過本機安全閘。" : "已切回逐項核准工具動作。");
            await loadPendingLocalActions().catch(() => undefined);
        } catch (requestError) {
            setError(errorMessage(requestError));
        } finally {
            setSavingApprovalMode(false);
        }
    };

    const sendMessage = async (event: FormEvent) => {
        event.preventDefault();
        const text = input.trim();
        if ((!text && pendingAttachments.length === 0) || !project || !conversation || sending) return;
        if (conversation.bindingState === "reconcile_required") {
            setError("這個對話的上次傳送結果不明。請先在 Edge 核對，再使用人工核對功能恢復。系統不會自動重送。");
            return;
        }
        setSending(true);
        setError("");
        setNotice("");
        setAttachmentWarnings([]);
        let attachmentBatchId = "";
        try {
            attachmentBatchId = await stagePendingAttachmentBatch();
            await apiPost<{ requestId: string }>(apiUrl("/api/chat"), {
                golemId: "golem_A",
                projectId: project.id,
                conversationId: conversation.id,
                message: text,
                responseMode,
                selectedMcpServers: selectedMcpServerNames,
                selectedSkillIds,
                referenceFileIds: selectedReferenceFileIds,
                attachmentBatchId: attachmentBatchId || undefined,
            });
            setInput("");
            setPendingAttachments([]);
            setAttachmentProgress(attachmentBatchId
                ? "附件已交給可見 Edge；正在等待 M365 完成 OneDrive 上傳並啟用送出鍵，請勿手動補按 Enter。"
                : "");
            setSelectedReferenceFileIds([]);
            setSelectedMcpServerNames([]);
            setSelectedSkillIds([]);
            setComposerMenuOpen(false);
            setNotice("訊息已加入對話隊列；你可以繼續輸入下一則，Golem 會依序送往 M365。");
            await loadMessages();
        } catch (requestError) {
            if (attachmentBatchId) await cancelStagedAttachmentBatch(attachmentBatchId);
            setSending(false);
            setAttachmentProgress("");
            setError(errorMessage(requestError));
            await loadContext().catch(() => undefined);
        } finally {
            setSending(false);
        }
    };

    const recheckPendingResponse = async (item: PendingM365Response) => {
        if (!conversation || recheckingRequestId) return;
        setRecheckingRequestId(item.requestId);
        setError("");
        try {
            const result = await apiPost<{ status: string }>(
                apiUrl(`/api/chat/pending-responses/${encodeURIComponent(item.requestId)}/recheck`),
                { conversationId: conversation.id }
            );
            if (result.status === "recovered") {
                setNotice("已從 Edge 找到這一輪的信封回覆並補回對話，不會重送。");
            } else if (result.status === "retried") {
                setNotice("頁面已停止產生且找不到這一輪信封；已依你的確認安全重送一次。若再次逾時，系統會請你檢查 Copilot。");
            } else if (result.status === "still_generating") {
                setNotice("Copilot 仍在產生內容；系統沒有重送，稍後可再按一次確認。");
            } else if (result.status === "queue_busy") {
                setNotice("前方仍有對話正在處理；這輪保留在隊列中，稍後再確認即可。");
            } else {
                setNotice("這輪已連續兩次超過等待時間，請在 Edge 檢查 Copilot 是否出現特殊提示、權限或下載問題。");
            }
            await Promise.all([loadMessages(), loadPendingResponses()]);
        } catch (requestError) {
            setError(errorMessage(requestError));
            await loadPendingResponses().catch(() => undefined);
        } finally {
            setRecheckingRequestId("");
        }
    };

    const activateInEdge = async () => {
        if (!conversation) return;
        setActivating(true);
        setError("");
        try {
            await apiPost(apiUrl(`/api/conversations/${encodeURIComponent(conversation.id)}/activate`), {
                golemId: "golem_A",
            });
            setNotice(conversation.bindingState === "bound" ? "已在可見 Edge 開啟這個 M365 對話。" : "已準備新的 M365 對話頁面；首次傳送後才會正式連結。" );
            await loadContext();
        } catch (requestError) {
            setError(errorMessage(requestError));
        } finally {
            setActivating(false);
        }
    };

    const runAction = async (
        run: M365Run,
        action: "start" | "pause" | "resume" | "cancel" | "complete" | "reconcile",
        body: Record<string, unknown> = {}
    ) => {
        setRunSaving(true);
        setError("");
        try {
            await apiPost(apiUrl(`/api/runs/${encodeURIComponent(run.id)}/${action}`), body);
            await Promise.all([loadRuns(), loadMessages()]);
        } catch (requestError) {
            setError(errorMessage(requestError));
        } finally {
            setRunSaving(false);
        }
    };

    const decideRunApproval = async (approvalId: string, status: "approved" | "denied") => {
        setRunSaving(true);
        setError("");
        try {
            await apiPost(apiUrl(`/api/approvals/${encodeURIComponent(approvalId)}/decision`), {
                status,
                decision: status === "approved" ? "使用者在本機工作台核准繼續。" : "使用者在本機工作台拒絕繼續。",
            });
            await loadRuns();
        } catch (requestError) {
            setError(errorMessage(requestError));
        } finally {
            setRunSaving(false);
        }
    };

    const decideLocalAction = async (taskId: string, decision: "approved" | "denied") => {
        if (!conversation || decidingActionId) return;
        setDecidingActionId(taskId);
        setError("");
        try {
            await apiPost(apiUrl(`/api/chat/pending-actions/${encodeURIComponent(taskId)}/decision`), {
                golemId: "golem_A",
                conversationId: conversation.id,
                decision,
            });
            setNotice(decision === "approved"
                ? "已核准這項工具動作；原版 Action Gate 正在執行，結果會回到同一個專案對話。"
                : "已拒絕這項工具動作，系統沒有執行。"
            );
            await Promise.all([loadPendingLocalActions(), loadMessages()]);
        } catch (requestError) {
            setError(errorMessage(requestError));
            await loadPendingLocalActions().catch(() => undefined);
        } finally {
            setDecidingActionId("");
        }
    };

    const reconcileConversation = async (resolution: "not_sent" | "sent") => {
        const retryText = resolution === "not_sent"
            ? [...messages].reverse().find(
                (message) => message.role === "user" && message.deliveryState === "ambiguous"
            )?.content || ""
            : "";
        setError("");
        setActivating(true);
        try {
            await apiPost(apiUrl(`/api/conversations/${encodeURIComponent(conversation!.id)}/reconcile`), { resolution });
            await loadContext();
            if (retryText) {
                setInput(retryText);
                setNotice("已記錄人工核對：上一則未送出，內容已還原到輸入框。請確認後按傳送；系統不會自動送出。");
            } else {
                setNotice(resolution === "not_sent"
                    ? "已記錄人工核對：上一則未送出。請重新輸入後再傳送；系統不會自動送出。"
                    : "已記錄人工核對：上一則已送出。系統沒有重送。"
                );
            }
        } catch (requestError) {
            setError(errorMessage(requestError));
        } finally {
            setActivating(false);
            if (retryText) {
                window.setTimeout(() => composerRef.current?.focus(), 0);
            }
        }
    };

    if (!hydrated || loading) {
        return <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
    }

    if (!activeProjectId || !activeConversationId || !project || !conversation) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <div className="enterprise-card max-w-md rounded-2xl border border-border p-8 text-center">
                    <MessageSquarePlus className="mx-auto h-10 w-10 text-primary" />
                    <h2 className="mt-4 text-xl font-semibold">從左側選擇一個專案對話</h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        展開既有專案並選擇對話，或使用專案旁的「＋」建立新對話；專案清單就是唯一管理入口。
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
            <section className="flex min-w-0 flex-1 flex-col bg-background p-4 md:p-6">
                <header className="mb-4 flex-shrink-0">
                    <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
                        <div className="min-w-0">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span className="truncate">{project.name}</span>
                                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{conversation.title}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                                <h2 className="truncate bg-gradient-to-r from-primary to-blue-500 bg-clip-text text-2xl font-bold text-transparent">{conversation.title}</h2>
                                <span className={cn(
                                    "rounded-full border px-2 py-0.5 text-[11px]",
                                    conversation.bindingState === "bound" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                                    conversation.bindingState === "unbound" && "border-border text-muted-foreground",
                                    conversation.bindingState === "reconcile_required" && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                                    conversation.bindingState === "broken" && "border-destructive/30 bg-destructive/10 text-destructive"
                                )}>
                                    {getBindingLabel(conversation.bindingState)}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={activateInEdge}
                                disabled={activating || sending}
                                className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs font-medium hover:bg-accent disabled:opacity-50"
                            >
                                {activating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                                在 Edge 開啟
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowRuns((value) => !value)}
                                className="inline-flex h-9 items-center gap-2 rounded-xl bg-primary px-3 text-xs font-medium text-primary-foreground"
                            >
                                <ListChecks className="h-3.5 w-3.5" />來源與執行
                            </button>
                        </div>
                    </div>
                </header>

                {(error || notice || pendingResponses.length > 0 || conversation.bindingState === "reconcile_required") && (
                    <div className="mb-3 space-y-2">
                        {error && <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{error}</div>}
                        {notice && <div className="rounded-xl border border-primary/25 bg-primary/5 px-4 py-2.5 text-sm">{notice}</div>}
                        {pendingResponses.map((item) => (
                            <div key={item.requestId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                                <div className="flex min-w-0 items-start gap-2">
                                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                                    <p>
                                        {item.status === "manual_check_required"
                                            ? "這一輪重送後仍超過 60 秒；請到 Copilot 檢查是否有權限、下載或特殊提示。"
                                            : "M365 回覆已超過 60 秒。按「再次確認」後，系統會先找這一輪信封；只有頁面已空閒且確實找不到時，才會重送一次。"}
                                    </p>
                                </div>
                                {item.status === "manual_check_required" ? (
                                    <button type="button" onClick={activateInEdge} className="shrink-0 rounded-lg border border-amber-600/35 bg-background/70 px-3 py-1.5 text-xs font-medium">在 Edge 檢查</button>
                                ) : (
                                    <button
                                        type="button"
                                        disabled={Boolean(recheckingRequestId)}
                                        onClick={() => void recheckPendingResponse(item)}
                                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50"
                                    >
                                        {recheckingRequestId === item.requestId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                                        再次確認
                                    </button>
                                )}
                            </div>
                        ))}
                        {conversation.bindingState === "reconcile_required" && (
                            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                                <div>
                                    <p>上次操作的結果無法確定。為避免重複送出，這個對話已停止自動傳送，請先查看 Edge。</p>
                                    {currentRun?.status === "RECONCILE_REQUIRED" ? (
                                        <button type="button" onClick={() => setShowRuns(true)} className="mt-2 rounded-lg border border-amber-600/30 bg-background/70 px-3 py-1.5 text-xs font-medium">到執行面板完成核對</button>
                                    ) : (
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <button disabled={activating} type="button" onClick={() => reconcileConversation("not_sent")} className="rounded-lg border border-amber-600/30 bg-background/70 px-3 py-1.5 text-xs font-medium">已確認未送出</button>
                                            <button disabled={activating} type="button" onClick={() => reconcileConversation("sent")} className="rounded-lg border border-amber-600/30 bg-background/70 px-3 py-1.5 text-xs font-medium">已確認有送出</button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
                <div className="relative min-h-0 flex-1">
                <div ref={scrollRef} onScroll={handleConversationScroll} className="custom-scrollbar h-full overflow-y-auto p-4">
                    <div className="mx-auto max-w-4xl space-y-4">
                        {(activeDialogueCount > 0 || queuedDialogueCount > 0) && (
                            <div className="flex items-center gap-2 rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-800 dark:text-cyan-200">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                對話隊列：{activeDialogueCount > 0 ? `${activeDialogueCount} 則處理中` : "目前空閒"}{queuedDialogueCount > 0 ? `，${queuedDialogueCount} 則等待中` : ""}
                            </div>
                        )}
                        {messages.length === 0 ? (
                            <div className="enterprise-card rounded-2xl border border-border p-8 text-center">
                                <Bot className="mx-auto h-9 w-9 text-primary" />
                                <h3 className="mt-3 font-semibold">開始這個專案對話</h3>
                                <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                                    首次傳送會在可見 Edge 建立新的 M365 Copilot 對話，並加入本專案的固定指示。帳密、MFA 與敏感資訊仍由你親自操作。
                                </p>
                            </div>
                        ) : messages.map((message) => {
                            const isUser = message.role === "user";
                            const isWarning = ["ambiguous", "failed"].includes(message.deliveryState) || message.role === "system";
                            return (
                                <article key={message.id} className={cn(
                                    "flex max-w-[86%] flex-col",
                                    isUser ? "ml-auto items-end" : "mr-auto items-start"
                                )}>
                                    <div className={cn("mb-1 flex items-center gap-2", isUser && "flex-row-reverse")}>
                                        <div className={cn(
                                            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                                            isUser ? "border-blue-500/20 bg-blue-600/10" : "border-primary/20 bg-primary/10"
                                        )}>
                                            {isUser ? <UserRound className="h-3 w-3 text-blue-600 dark:text-blue-300" /> : <Bot className="h-3 w-3 text-primary" />}
                                        </div>
                                        <span className={cn("text-xs font-bold", isUser ? "text-blue-600 dark:text-blue-400" : "text-primary")}>
                                            {isUser ? "User" : message.role === "assistant" ? "golem_A" : "System"}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground">{formatLocalDate(message.createdAt)}</span>
                                    </div>
                                    <div className="min-w-0">
                                        <div className={cn(
                                            "inline-block rounded-2xl border p-3 text-left text-sm shadow-sm",
                                            isUser
                                                ? "rounded-tr-none border-blue-500/20 bg-blue-600/10 text-blue-900 dark:text-blue-100"
                                                : "rounded-tl-none border-border bg-secondary/50 text-foreground/90",
                                            isWarning && "border-amber-500/35 bg-amber-500/10"
                                        )}>
                                            {isCollapsibleActionMessage(message) ? (
                                                <CollapsibleActionMessage content={message.content} />
                                            ) : message.role === "assistant" ? (
                                                <M365MessageContent content={message.content} />
                                            ) : (
                                                <div className="prose prose-sm max-w-none break-words text-foreground dark:prose-invert prose-p:my-2 prose-pre:overflow-x-auto">
                                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                                                </div>
                                            )}
                                        </div>
                                        <div className={cn("mt-1 flex items-center gap-2 text-[10px] text-muted-foreground", isUser && "justify-end")}>
                                            <span className={cn(isWarning && "text-amber-700 dark:text-amber-300")}>{deliveryLabel(message)}</span>
                                        </div>
                                    </div>
                                </article>
                            );
                        })}
                        {sending && (
                            <div className="flex items-center gap-3 text-sm text-muted-foreground">
                                <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card"><Bot className="h-4 w-4" /></div>
                                <div className="flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3">
                                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                                    正在把訊息加入對話隊列…
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                {!followingLatest && messages.length > 0 && (
                    <button
                        type="button"
                        onClick={() => scrollToLatest("smooth")}
                        aria-label="回到最新對話"
                        title="回到最新對話"
                        className="absolute bottom-4 left-1/2 z-20 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background/95 text-foreground shadow-lg backdrop-blur transition hover:-translate-y-0.5 hover:bg-secondary"
                    >
                        <ArrowDown className="h-4 w-4" />
                    </button>
                )}
                </div>

                <form
                    onSubmit={sendMessage}
                    onDragEnter={(event) => { event.preventDefault(); if (!sending) setDragActive(true); }}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                    onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
                    }}
                    onDrop={(event) => void handleAttachmentDrop(event)}
                    className="relative border-t border-border bg-card/50 p-3"
                >
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept={M365_ATTACHMENT_ACCEPT}
                        className="hidden"
                        onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }}
                    />
                    <input
                        ref={(node) => {
                            folderInputRef.current = node;
                            if (node) {
                                node.setAttribute("webkitdirectory", "");
                                node.setAttribute("directory", "");
                            }
                        }}
                        type="file"
                        multiple
                        accept={M365_ATTACHMENT_ACCEPT}
                        className="hidden"
                        onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }}
                    />
                    {dragActive && (
                        <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/95 text-sm font-medium text-primary shadow-xl">
                            <FileUp className="mr-2 h-5 w-5" />放開即可加入檔案或資料夾
                        </div>
                    )}
                    <div className="mx-auto max-w-4xl">
                        <div className="rounded-2xl border border-border bg-secondary/35 p-2 shadow-sm transition focus-within:border-primary/45 focus-within:ring-1 focus-within:ring-primary/30">
                            <textarea
                                ref={composerRef}
                                value={input}
                                onChange={(event) => setInput(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && !event.shiftKey) {
                                        event.preventDefault();
                                        event.currentTarget.form?.requestSubmit();
                                    }
                                }}
                                rows={1}
                                maxLength={100000}
                                disabled={sending || conversation.bindingState === "reconcile_required"}
                                className="max-h-32 min-h-[42px] w-full resize-none bg-transparent px-2 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed"
                                placeholder={conversation.bindingState === "reconcile_required" ? "請先完成人工核對" : "傳送訊息給此專案的 M365 Copilot 對話…"}
                            />

                            {(pendingAttachments.length > 0 || selectedReferenceFileIds.length > 0 || selectedMcpServerNames.length > 0 || selectedSkillIds.length > 0) && (
                                <div className="mb-2 flex flex-wrap gap-1.5 px-1">
                                    {pendingAttachments.map((item) => (
                                        <button
                                            key={item.id}
                                            type="button"
                                            onClick={() => removePendingAttachment(item.id)}
                                            disabled={sending}
                                            className="inline-flex max-w-64 items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 text-[11px] hover:bg-cyan-500/10 disabled:opacity-60"
                                            title={`移除附件：${item.displayPath}`}
                                        >
                                            <Paperclip className="h-3 w-3 shrink-0 text-cyan-500" />
                                            <span className="truncate">{item.displayPath}</span>
                                            <span className="shrink-0 text-muted-foreground">{formatAttachmentSize(item.file.size)}</span>
                                            <X className="h-3 w-3 shrink-0 text-muted-foreground" />
                                        </button>
                                    ))}
                                    {selectedReferenceFileIds.map((id) => {
                                        const file = referenceFiles.find((item) => item.id === id);
                                        return (
                                            <button key={id} type="button" onClick={() => toggleReferenceFile(id)} className="inline-flex max-w-48 items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-[11px] hover:bg-accent" title="移除參考檔案">
                                                <FileText className="h-3 w-3 shrink-0 text-primary" />
                                                <span className="truncate">{file?.name || id}</span>
                                                <X className="h-3 w-3 shrink-0 text-muted-foreground" />
                                            </button>
                                        );
                                    })}
                                    {selectedMcpServerNames.map((name) => (
                                        <button key={name} type="button" onClick={() => toggleMcpServer(name)} className="inline-flex max-w-48 items-center gap-1 rounded-lg border border-primary/25 bg-primary/5 px-2 py-1 text-[11px] hover:bg-primary/10" title="移除 MCP 工具來源">
                                            <ListChecks className="h-3 w-3 shrink-0 text-primary" />
                                            <span className="truncate">{name}</span>
                                            <X className="h-3 w-3 shrink-0 text-muted-foreground" />
                                        </button>
                                    ))}
                                    {selectedSkillIds.map((id) => {
                                        const skill = skills.find((item) => item.id === id);
                                        return (
                                            <button key={id} type="button" onClick={() => toggleSkill(id)} className="inline-flex max-w-48 items-center gap-1 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-2 py-1 text-[11px] hover:bg-emerald-500/10" title="移除 Skill">
                                                <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-500" />
                                                <span className="truncate">{skill?.name || id}</span>
                                                <X className="h-3 w-3 shrink-0 text-muted-foreground" />
                                            </button>
                                        );
                                    })}
                                </div>
                            )}

                            <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
                                <div className="relative">
                                    <button
                                        type="button"
                                        onClick={() => setComposerMenuOpen((open) => !open)}
                                        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                                        aria-label="加入檔案或 MCP 工具"
                                        aria-expanded={composerMenuOpen}
                                    >
                                        <Plus className="h-4 w-4" />
                                    </button>
                                    {composerMenuOpen && (
                                        <div className="absolute bottom-10 left-0 z-40 w-56 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl">
                                            <button type="button" onClick={() => { fileInputRef.current?.click(); setComposerMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-accent">
                                                <FileUp className="h-4 w-4 text-cyan-500" />新增檔案
                                            </button>
                                            <button type="button" onClick={() => { folderInputRef.current?.click(); setComposerMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-accent">
                                                <FolderUp className="h-4 w-4 text-cyan-500" />新增資料夾
                                            </button>
                                            <button type="button" onClick={() => { setComposerPicker("files"); setComposerMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-accent">
                                                <FileText className="h-4 w-4 text-primary" />選擇參考檔案
                                            </button>
                                            <button type="button" onClick={() => { setComposerPicker("mcp"); setComposerMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-accent">
                                                <ListChecks className="h-4 w-4 text-primary" />選擇 MCP 工具
                                            </button>
                                            <button type="button" onClick={() => { setComposerPicker("skills"); setComposerMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-accent">
                                                <ShieldCheck className="h-4 w-4 text-emerald-500" />選擇 Skills
                                            </button>
                                            <a href="/dashboard/reference-files" className="mt-1 block border-t border-border px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground">管理參考檔案…</a>
                                        </div>
                                    )}
                                </div>

                                <select
                                    aria-label="回應模式"
                                    value={responseMode}
                                    onChange={(event) => changeResponseMode(event.target.value as ResponseMode)}
                                    className="h-8 rounded-lg border border-transparent bg-transparent px-2 text-[11px] font-medium text-muted-foreground outline-none hover:bg-accent focus:border-primary/40"
                                >
                                    <option value="auto">自動回應</option>
                                    <option value="quick">快速回應</option>
                                    <option value="thoughtful">自動思考</option>
                                </select>

                                <select
                                    aria-label="工具核准模式"
                                    value={approvalMode}
                                    disabled={savingApprovalMode}
                                    onChange={(event) => void changeApprovalMode(event.target.value as ApprovalMode)}
                                    className={cn(
                                        "h-8 rounded-lg border border-transparent bg-transparent px-2 text-[11px] font-medium outline-none hover:bg-accent focus:border-primary/40 disabled:opacity-50",
                                        approvalMode === "auto" ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground"
                                    )}
                                >
                                    <option value="manual">逐項核准</option>
                                    <option value="auto">自動核准</option>
                                </select>

                                <div className="ml-auto">
                                    <button
                                        type="submit"
                                        disabled={(!input.trim() && pendingAttachments.length === 0) || sending || conversation.bindingState === "reconcile_required"}
                                        className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/40"
                                        aria-label="傳送"
                                    >
                                        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                                    </button>
                                </div>
                            </div>
                        </div>
                        {attachmentProgress && <p className="mt-1.5 text-center text-[11px] text-cyan-600 dark:text-cyan-300">{attachmentProgress}</p>}
                        {attachmentWarnings.length > 0 && (
                            <div className="mt-1.5 space-y-0.5 text-center text-[11px] text-amber-700 dark:text-amber-300">
                                {attachmentWarnings.map((warning) => <p key={warning}>{warning}</p>)}
                            </div>
                        )}
                        {composerResourceError && <p className="mt-1.5 text-center text-[11px] text-amber-700 dark:text-amber-300">{composerResourceError}</p>}
                        <p className="mt-2 text-center text-[11px] text-muted-foreground">
                            可見 M365 網頁傳輸 · 附件會上傳到目前的 M365 對話 · {approvalMode === "auto" ? "工具經安全閘後自動執行" : "本機工具需可見核准"} · 不使用 Copilot Chat API
                        </p>
                    </div>
                </form>

                <Dialog open={composerPicker !== null} onOpenChange={(open) => !open && setComposerPicker(null)}>
                    <DialogContent className="sm:max-w-xl">
                        <DialogHeader>
                            <DialogTitle>{composerPicker === "files" ? "選擇參考檔案" : composerPicker === "mcp" ? "選擇 MCP 工具" : "選擇 Skills"}</DialogTitle>
                            <DialogDescription>
                                {composerPicker === "files"
                                    ? "只會把勾選檔案的已索引文字送進這一輪 M365 提示，不會上傳原始檔。請勿選擇密碼、Token 或其他機密資料。"
                                    : composerPicker === "mcp"
                                        ? "選取本輪優先路由的 MCP 來源；實際呼叫仍須符合工具規格、Action Gate 與目前核准模式。"
                                        : "選取本輪優先使用的已安裝 Skill；系統會載入它的使用規格，但仍須通過 Action Gate 與目前核准模式。"}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="custom-scrollbar max-h-[52vh] space-y-2 overflow-y-auto py-1">
                            {composerResourcesLoading ? (
                                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />載入工具清單…</div>
                            ) : composerPicker === "files" ? (
                                referenceFiles.length > 0 ? referenceFiles.map((file) => (
                                    <label key={file.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-accent/60">
                                        <input type="checkbox" checked={selectedReferenceFileIds.includes(file.id)} onChange={() => toggleReferenceFile(file.id)} className="mt-1 accent-cyan-500" />
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm font-medium">{file.name}</span>
                                            <span className="mt-1 block truncate text-xs text-muted-foreground">{file.path}</span>
                                        </span>
                                    </label>
                                )) : <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">尚無可用且已索引的參考檔案。</p>
                            ) : composerPicker === "mcp" ? (
                                mcpServers.length > 0 ? mcpServers.map((server) => (
                                    <label key={server.name} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-accent/60">
                                        <input type="checkbox" checked={selectedMcpServerNames.includes(server.name)} onChange={() => toggleMcpServer(server.name)} className="mt-1 accent-cyan-500" />
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-2 text-sm font-medium">
                                                <span className="truncate">{server.name}</span>
                                                <span className={cn("h-2 w-2 shrink-0 rounded-full", server.connected ? "bg-emerald-500" : "bg-amber-500")} />
                                            </span>
                                            <span className="mt-1 block text-xs leading-5 text-muted-foreground">{server.description || "尚未提供用途說明"}</span>
                                        </span>
                                    </label>
                                )) : <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">尚無已啟用的 MCP Server。</p>
                            ) : (
                                skills.length > 0 ? skills.map((skill) => (
                                    <label key={skill.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-accent/60">
                                        <input type="checkbox" checked={selectedSkillIds.includes(skill.id)} onChange={() => toggleSkill(skill.id)} className="mt-1 accent-emerald-500" />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-medium">{skill.name}</span>
                                            <span className="mt-1 block text-xs leading-5 text-muted-foreground">{skill.description || `Action: ${skill.action}`}</span>
                                        </span>
                                    </label>
                                )) : <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">尚無已啟用且可執行的 Skills。</p>
                            )}
                        </div>
                        {composerResourceError && <p className="text-xs text-amber-700 dark:text-amber-300">{composerResourceError}</p>}
                        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                            <span className="text-xs text-muted-foreground">最多選擇 3 項</span>
                            <button type="button" onClick={() => setComposerPicker(null)} className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground">完成</button>
                        </div>
                    </DialogContent>
                </Dialog>
                </div>
            </section>

            {showRuns && (
                <aside className="custom-scrollbar absolute inset-y-0 right-0 z-30 w-[min(92vw,380px)] shrink-0 overflow-y-auto border-l border-border bg-background p-4 shadow-2xl xl:static xl:w-[360px] xl:bg-card/40 xl:shadow-none">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Workspace</p>
                            <h3 className="mt-1 font-semibold">來源與執行</h3>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">把專案脈絡、工具核准與多步驟工作放在同一工作區。</p>
                        </div>
                        <div className="flex gap-1.5">
                            <button type="button" onClick={() => setShowRuns(false)} className="flex h-9 w-9 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-accent" aria-label="關閉來源與執行面板">
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    </div>

                    <div className="mt-4 space-y-3">
                        <section className={cn(
                            "rounded-2xl border bg-card p-4",
                            pendingLocalActions.length > 0 || actionExecutionQueue.length > 0 ? "border-amber-500/40" : "border-border"
                        )}>
                            <div className="flex items-center justify-between gap-3">
                                <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">待核准工具動作</h4>
                                <span className={cn(
                                    "rounded-full px-2 py-1 text-[10px] font-medium",
                                    pendingLocalActions.length > 0
                                        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                        : "bg-secondary text-muted-foreground"
                                )}>
                                    {pendingLocalActions.length > 0
                                        ? `${pendingLocalActions.length} 項待核准`
                                        : actionExecutionQueue.length > 0
                                            ? `${actionExecutionQueue.length} 項執行中`
                                            : "無待辦"}
                                </span>
                            </div>
                            {!toolActionsEnabled ? (
                                <p className="mt-3 text-xs leading-5 text-muted-foreground">本機工具目前關閉；MCP、Skills 與命令不會執行。</p>
                            ) : pendingLocalActions.length === 0 ? (
                                <p className="mt-3 text-xs leading-5 text-muted-foreground">工具只會在 M365 提出動作後出現在這裡；未經你核准不會執行。</p>
                            ) : (
                                <div className="mt-3 space-y-3">
                                    {pendingLocalActions.map((action) => (
                                        <article key={action.id} className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3">
                                            <div className="flex items-start gap-2">
                                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-xs font-semibold">{action.title}</p>
                                                    <pre className="custom-scrollbar mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/80 p-2 text-[10px] leading-4 text-muted-foreground">{action.summary}</pre>
                                                    <p className="mt-2 text-[10px] text-muted-foreground">
                                                        {action.actionCount} 個動作 · 約 {Math.max(0, Math.ceil((action.expiresAt - Date.now()) / 60000))} 分鐘後失效
                                                    </p>
                                                    <div className="mt-2 flex gap-2">
                                                        <button
                                                            type="button"
                                                            disabled={Boolean(decidingActionId)}
                                                            onClick={() => decideLocalAction(action.id, "approved")}
                                                            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                                                        >
                                                            {decidingActionId === action.id ? "處理中…" : "核准執行"}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={Boolean(decidingActionId)}
                                                            onClick={() => decideLocalAction(action.id, "denied")}
                                                            className="rounded-lg border border-destructive/30 bg-background px-3 py-1.5 text-xs text-destructive disabled:opacity-50"
                                                        >
                                                            拒絕
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </article>
                                    ))}
                                </div>
                            )}
                            {actionExecutionQueue.length > 0 && (
                                <div className="mt-3 space-y-2 border-t border-border/70 pt-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Action Queue</p>
                                    {actionExecutionQueue.map((action) => (
                                        <div key={action.id} className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-3">
                                            <div className="flex items-center gap-2 text-xs font-medium">
                                                {action.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-500" /> : <ListChecks className="h-3.5 w-3.5 text-cyan-500" />}
                                                <span>{action.title}</span>
                                            </div>
                                            <p className="mt-1 text-[10px] text-muted-foreground">
                                                {action.status === "running" ? "執行中" : `隊列第 ${action.position} 位`} · {action.actionCount} 個動作
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>

                        <section className="rounded-2xl border border-border bg-card p-4">
                            <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">來源</h4>
                            <div className="mt-3 space-y-2 text-xs">
                                <div className="flex items-start gap-2 rounded-lg p-2">
                                    <FolderKanban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                                    <span className="min-w-0">
                                        <span className="block truncate font-medium">{project.name}</span>
                                        <span className="block text-[10px] text-muted-foreground">專案脈絡 v{project.contextVersion}</span>
                                    </span>
                                </div>
                                {conversation.remoteConversationUrl ? (
                                    <a href={conversation.remoteConversationUrl} target="_blank" rel="noreferrer" className="flex items-start gap-2 rounded-lg p-2 hover:bg-accent">
                                        <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                                        <span>
                                            <span className="block font-medium">M365 Copilot 對話</span>
                                            <span className="block text-[10px] text-muted-foreground">{getBindingLabel(conversation.bindingState)}</span>
                                        </span>
                                    </a>
                                ) : (
                                    <div className="flex items-start gap-2 rounded-lg p-2 text-muted-foreground">
                                        <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                        <span>首次人工傳送後建立 M365 對話連結</span>
                                    </div>
                                )}
                                <a href="/dashboard/reference-files" className="flex items-center gap-2 rounded-lg p-2 hover:bg-accent">
                                    <FolderKanban className="h-3.5 w-3.5 text-primary" />參考檔案管理
                                </a>
                                {projectWorkspace && (
                                    <button
                                        type="button"
                                        onClick={() => setShowAgentsEditor(true)}
                                        className="flex w-full items-start gap-2 rounded-lg p-2 text-left hover:bg-accent"
                                    >
                                        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                                        <span className="min-w-0">
                                            <span className="block font-medium">AGENTS.md</span>
                                            <span className="block text-[10px] text-muted-foreground">Golem 自主管理 · {projectWorkspace.memoryCount} 則專案記憶</span>
                                        </span>
                                    </button>
                                )}
                            </div>
                        </section>

                        <section className="rounded-2xl border border-border bg-card p-4">
                            <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">工具</h4>
                            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                                <a href="/dashboard/mcp" className="rounded-lg border border-border px-3 py-2 text-center hover:bg-accent">MCP 工具</a>
                                <a href="/dashboard/skills" className="rounded-lg border border-border px-3 py-2 text-center hover:bg-accent">Skills</a>
                                <a href="/dashboard/action-gate" className="rounded-lg border border-border px-3 py-2 text-center hover:bg-accent">Action Gate</a>
                                <a href="/dashboard/persona" className="rounded-lg border border-border px-3 py-2 text-center hover:bg-accent">人格設定</a>
                            </div>
                        </section>

                        <div className="flex items-center justify-between border-t border-border pt-4">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Harness</p>
                                <h4 className="mt-1 text-sm font-semibold">多步驟工作</h4>
                            </div>
                            <span className="text-[10px] text-muted-foreground">有界步數 · 可暫停</span>
                        </div>
                    </div>

                    <div className="mt-4 space-y-3">
                        {runs.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-border p-6 text-center">
                                <ListChecks className="mx-auto h-7 w-7 text-muted-foreground" />
                                <p className="mt-2 text-sm font-medium">尚無多步驟工作</p>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">一般問答不建立計畫；需要跨輪處理的複雜任務會由 Copilot 自行判斷並規劃，包含原生 M365 能力、本機工具與 MCP。</p>
                            </div>
                        ) : runs.map((run) => (
                            <article key={run.id} className={cn("rounded-2xl border bg-card p-4", run.id === currentRun?.id ? "border-primary/35" : "border-border")}>
                                <div className="flex items-start justify-between gap-3">
                                    <p className="line-clamp-3 text-sm font-medium leading-5">{run.objective}</p>
                                    {run.status === "COMPLETED" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" /> : <ListChecks className="h-4 w-4 shrink-0 text-primary" />}
                                </div>
                                <div className="mt-3 flex items-center justify-between text-xs">
                                    <span className="rounded-full bg-secondary px-2 py-1 font-medium">{getRunStatusLabel(run.status)}</span>
                                    <span className="text-right text-muted-foreground">
                                        {run.id === currentRun?.id && runDetail?.plan
                                            ? `計畫 ${run.status === "COMPLETED" ? runDetail.plan.steps.length : runDetail.plan.steps.filter((step) => ["completed", "skipped"].includes(step.status)).length}/${runDetail.plan.steps.length} · 宿主執行 ${run.currentStep}/${run.maxSteps}`
                                            : `宿主執行 ${run.currentStep}/${run.maxSteps}`}
                                    </span>
                                </div>
                                {run.id === currentRun?.id && runDetail?.plan ? (
                                    <details open className="mt-3 rounded-xl border border-border bg-secondary/35 p-3">
                                        <summary className="cursor-pointer select-none text-xs font-semibold text-primary">
                                            <span className="ml-1 inline-flex max-w-[calc(100%-1rem)] flex-col align-middle">
                                                <span>Copilot 自主計畫 · v{runDetail.plan.revision} · {run.status === "COMPLETED" ? runDetail.plan.steps.length : runDetail.plan.steps.filter((step) => ["completed", "skipped"].includes(step.status)).length}/{runDetail.plan.steps.length}</span>
                                                <span className="mt-0.5 truncate text-[11px] font-normal text-foreground">
                                                    目前：{run.status === "COMPLETED" ? (runDetail.plan.status === "complete" ? "計畫已完成" : "已完成（使用者核對）") : runDetail.plan.status === "complete" ? "計畫已完成" : runDetail.plan.steps.find((step) => step.id === runDetail.plan?.currentStepId)?.title || (runDetail.plan.status === "wait_user" ? "等待你的補充" : runDetail.plan.status === "wait_approval" ? "等待核准" : runDetail.plan.status === "blocked" ? "計畫受阻" : "正在更新計畫")}
                                                    {run.status === "COMPLETED" ? "" : pendingLocalActions.length > 0 ? " · 等待工具核准" : actionExecutionQueue.length > 0 ? " · 工具執行中" : run.status === "PAUSED" ? " · 已暫停" : runDetail.plan.status === "running" ? " · 等待 Observation" : ""}
                                                </span>
                                            </span>
                                        </summary>
                                        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background">
                                            <div
                                                className="h-full rounded-full bg-primary transition-all"
                                                style={{ width: `${run.status === "COMPLETED" ? 100 : Math.round((runDetail.plan.steps.filter((step) => ["completed", "skipped"].includes(step.status)).length / runDetail.plan.steps.length) * 100)}%` }}
                                            />
                                        </div>
                                        <p className="mt-2 text-xs leading-5 text-muted-foreground">完成條件：{runDetail.plan.completionCriteria}</p>
                                        <ol className="mt-3 space-y-2">
                                            {runDetail.plan.steps.map((step, index) => {
                                                const displayedStatus = run.status === "COMPLETED" ? "completed" : step.status;
                                                return (
                                                    <li key={step.id} className="flex gap-2 text-xs leading-5">
                                                        <span className={cn(
                                                            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                                                            displayedStatus === "completed" ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-500" :
                                                                displayedStatus === "in_progress" ? "border-primary/45 bg-primary/15 text-primary" :
                                                                    displayedStatus === "blocked" ? "border-amber-500/40 bg-amber-500/15 text-amber-500" :
                                                                        "border-border text-muted-foreground"
                                                        )}>{displayedStatus === "completed" ? "✓" : index + 1}</span>
                                                        <span>
                                                            <span className={cn("font-medium", displayedStatus === "completed" && "text-muted-foreground line-through")}>{step.title}</span>
                                                            {displayedStatus === "in_progress" && <span className="ml-2 text-[10px] font-semibold text-primary">進行中</span>}
                                                            <span className="block text-[11px] text-muted-foreground">{step.doneWhen}</span>
                                                        </span>
                                                    </li>
                                                );
                                            })}
                                        </ol>
                                    </details>
                                ) : null}
                                {run.id === currentRun?.id && runDetail?.steps.length ? (
                                    <details className="mt-2 rounded-xl bg-secondary/55 p-3">
                                        <summary className="cursor-pointer text-[11px] font-medium">宿主執行紀錄（{runDetail.steps.length}）</summary>
                                        <div className="mt-2 space-y-1.5">
                                            {runDetail.steps.slice(-5).map((step) => (
                                                <div key={step.id} className="flex gap-2 text-[11px] leading-4">
                                                    <span className="shrink-0 font-semibold text-primary">{step.stepNumber}.</span>
                                                    <span className="line-clamp-3 text-muted-foreground">{step.summary || (step.status === "running" ? "等待工具 Observation" : "等待執行")}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </details>
                                ) : null}
                                {!isRunTerminal(run) && (
                                    <div className="mt-3 space-y-2 border-t border-border pt-3">
                                        {run.status === "WAITING_APPROVAL" && pendingApproval && (
                                            <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5">
                                                <p>{pendingApproval.request}</p>
                                                <div className="mt-2 flex gap-2">
                                                    <button disabled={runSaving} onClick={() => decideRunApproval(pendingApproval.id, "approved")} className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground">核准繼續</button>
                                                    <button disabled={runSaving} onClick={() => decideRunApproval(pendingApproval.id, "denied")} className="rounded-lg border border-destructive/30 px-3 py-1.5 text-destructive">拒絕並停止</button>
                                                </div>
                                            </div>
                                        )}
                                        {["WAITING_USER", "BLOCKED"].includes(run.status) && (
                                            <div className="space-y-2">
                                                <textarea
                                                    value={runInput}
                                                    onChange={(event) => setRunInput(event.target.value)}
                                                    rows={3}
                                                    maxLength={20000}
                                                    className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                                                    placeholder="補充缺少的資訊或人工判斷後再繼續"
                                                />
                                                <button
                                                    disabled={runSaving || !runInput.trim()}
                                                    onClick={() => {
                                                        runAction(run, "resume", { input: runInput }).then(() => setRunInput(""));
                                                    }}
                                                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
                                                >
                                                    <RotateCcw className="h-3 w-3" />加入補充並繼續
                                                </button>
                                            </div>
                                        )}
                                        {run.status === "RECONCILE_REQUIRED" && (
                                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5">
                                                <p className="font-medium">請先查看可見 Edge 中的實際結果，再選一項：</p>
                                                <div className="mt-2 flex flex-col gap-1.5">
                                                    <button disabled={runSaving} onClick={() => runAction(run, "reconcile", { resolution: "not_sent", note: "使用者已在 Edge 確認前一步未送出。" })} className="rounded-lg border border-border bg-background px-3 py-1.5 text-left">確認未送出，可安全重試</button>
                                                    <button disabled={runSaving} onClick={() => runAction(run, "reconcile", { resolution: "completed" })} className="rounded-lg border border-border bg-background px-3 py-1.5 text-left">已在 Edge 確認工作完成</button>
                                                    <button disabled={runSaving} onClick={() => runAction(run, "reconcile", { resolution: "abandon" })} className="rounded-lg border border-destructive/30 bg-background px-3 py-1.5 text-left text-destructive">停止這次工作</button>
                                                </div>
                                            </div>
                                        )}
                                        <div className="flex flex-wrap gap-2">
                                        {run.status === "WAITING_START_APPROVAL" && (
                                            <button disabled={runSaving} onClick={() => runAction(run, "start")} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"><Play className="h-3 w-3" />確認開始</button>
                                        )}
                                        {run.status === "RUNNING" && (
                                            <button disabled={runSaving} onClick={() => runAction(run, "pause")} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs"><CirclePause className="h-3 w-3" />暫停</button>
                                        )}
                                        {run.status === "PAUSED" && (
                                            <button disabled={runSaving} onClick={() => runAction(run, "resume")} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"><RotateCcw className="h-3 w-3" />繼續</button>
                                        )}
                                        {["RUNNING", "PAUSED", "WAITING_USER", "BLOCKED"].includes(run.status)
                                            && (runDetail?.steps || []).length > 0
                                            && (runDetail?.steps || []).every((step) => !["queued", "running", "reconcile_required"].includes(step.status)) && (
                                            <button
                                                disabled={runSaving}
                                                onClick={() => {
                                                    if (window.confirm("只有在你已檢查 M365 回覆與宿主執行紀錄，確認工作真的完成時才繼續。")) {
                                                        void runAction(run, "complete", {
                                                            confirmed: true,
                                                            note: "使用者已在本機工作台確認完成。",
                                                        });
                                                    }
                                                }}
                                                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/35 px-3 py-1.5 text-xs text-emerald-600 dark:text-emerald-400"
                                            >
                                                <CheckCircle2 className="h-3 w-3" />確認已完成
                                            </button>
                                        )}
                                        <button disabled={runSaving} onClick={() => runAction(run, "cancel")} className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1.5 text-xs text-destructive"><Square className="h-3 w-3" />取消</button>
                                        </div>
                                    </div>
                                )}
                                <p className="mt-2 text-[11px] text-muted-foreground">更新：{formatLocalDate(run.updatedAt)}</p>
                            </article>
                        ))}
                    </div>

                    <div className="mt-4 flex gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-xs leading-5 text-emerald-800 dark:text-emerald-200">
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                        每一步都保存狀態；需要判斷、核准或傳送結果不明時會停下，不會偷偷重送。
                    </div>
                </aside>
            )}

            <Dialog open={showAgentsEditor} onOpenChange={setShowAgentsEditor}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>專案 AGENTS.md</DialogTitle>
                        <DialogDescription>
                            這份檔案由目前專案中的 Golem 自主累積，供同專案的所有對話共用；其他專案不會載入。每輪只會用本機向量索引挑出相關內容送給 M365，使用者不能在此直接改寫。
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        <p className="truncate text-xs text-muted-foreground" title={projectWorkspace?.agentsPath}>{projectWorkspace?.agentsPath}</p>
                        <textarea
                            value={projectWorkspace?.agentsContent || ""}
                            readOnly
                            rows={18}
                            className="custom-scrollbar w-full resize-y rounded-xl border border-input bg-muted/30 px-3 py-2 font-mono text-xs leading-5 outline-none"
                        />
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-xs text-muted-foreground">{projectWorkspace?.memoryCount || 0} 則 · 工具動作仍由 Action Gate 管理</span>
                            <div className="flex gap-2">
                                <button type="button" onClick={() => setShowAgentsEditor(false)} className="rounded-lg border border-border px-4 py-2 text-xs">關閉</button>
                            </div>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
