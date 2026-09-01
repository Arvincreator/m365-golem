"use client";

import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle,
    Bot,
    CheckCircle2,
    ChevronRight,
    CirclePause,
    ExternalLink,
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
    UserRound,
    X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiGet, apiPost } from "@/lib/api-client";
import { apiUrl } from "@/lib/api";
import { socket } from "@/lib/socket";
import { cn } from "@/lib/utils";
import { useM365WorkspaceSelection } from "@/components/M365WorkspaceContext";
import {
    formatLocalDate,
    getBindingLabel,
    getRunStatusLabel,
    type M365Conversation,
    type M365Message,
    type M365Project,
    type M365Run,
    type M365RunDetail,
} from "@/lib/m365-workspace";

type SocketLog = {
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

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : "目前無法完成，請稍後再試。";
}

function deliveryLabel(message: M365Message): string {
    if (message.deliveryState === "ambiguous") return "傳送結果不明，請先到 Edge 核對";
    if (message.deliveryState === "failed") return "未送達";
    if (message.deliveryState === "dispatch_started") return "傳送中";
    if (message.deliveryState === "confirmed") return "已送達 M365";
    if (message.deliveryState === "response_confirmed") return "已擷取";
    return "已保存";
}

function isRunTerminal(run: M365Run): boolean {
    return ["FAILED", "CANCELED", "COMPLETED"].includes(run.status);
}

export default function M365ChatPage() {
    const {
        hydrated,
        activeProjectId,
        activeConversationId,
    } = useM365WorkspaceSelection();
    const [project, setProject] = useState<M365Project | null>(null);
    const [conversation, setConversation] = useState<M365Conversation | null>(null);
    const [messages, setMessages] = useState<M365Message[]>([]);
    const [runs, setRuns] = useState<M365Run[]>([]);
    const [pendingLocalActions, setPendingLocalActions] = useState<PendingLocalAction[]>([]);
    const [toolActionsEnabled, setToolActionsEnabled] = useState(true);
    const [decidingActionId, setDecidingActionId] = useState("");
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [activating, setActivating] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [pendingRequestId, setPendingRequestId] = useState("");
    const [showRunForm, setShowRunForm] = useState(false);
    const [showRuns, setShowRuns] = useState(true);
    const [runSaving, setRunSaving] = useState(false);
    const [runDetail, setRunDetail] = useState<M365RunDetail | null>(null);
    const [runInput, setRunInput] = useState("");
    const [runForm, setRunForm] = useState({
        objective: "",
        constraints: "僅使用目前的 M365 Copilot Web 對話；不要執行外部動作；不確定時停下詢問。",
        verification: "列出完成結果、依據、未解事項與需要人工覆核的判斷。",
        maxSteps: 6,
    });
    const scrollRef = useRef<HTMLDivElement>(null);
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const pendingStartedAt = useRef(0);

    const currentRun = useMemo(
        () => runs.find((run) => !isRunTerminal(run)) || runs[0] || null,
        [runs]
    );
    const pendingApproval = useMemo(
        () => runDetail?.approvals.find((approval) => approval.status === "pending") || null,
        [runDetail]
    );
    const latestAssistantMessage = useMemo(
        () => messages.slice().reverse().find((message) => message.role === "assistant") || null,
        [messages]
    );

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
            return;
        }
        const data = await apiGet<{ actionsEnabled: boolean; items: PendingLocalAction[] }>(
            apiUrl(`/api/chat/pending-actions?golemId=golem_A&conversationId=${encodeURIComponent(activeConversationId)}`),
            undefined,
            { retries: 0 }
        );
        setToolActionsEnabled(data.actionsEnabled !== false);
        setPendingLocalActions(data.items || []);
    }, [activeConversationId]);

    const loadContext = useCallback(async () => {
        if (!activeProjectId || !activeConversationId) return;
        const [projectData, conversationData] = await Promise.all([
            apiGet<{ project: M365Project }>(apiUrl(`/api/projects/${encodeURIComponent(activeProjectId)}`)),
            apiGet<{ conversation: M365Conversation }>(apiUrl(`/api/conversations/${encodeURIComponent(activeConversationId)}`)),
        ]);
        if (conversationData.conversation.projectId !== projectData.project.id) {
            throw new Error("目前選取的對話不屬於這個專案，請回到專案頁重新選擇。");
        }
        setProject(projectData.project);
        setConversation(conversationData.conversation);
        await Promise.all([loadMessages(), loadRuns(), loadPendingLocalActions()]);
    }, [activeConversationId, activeProjectId, loadMessages, loadPendingLocalActions, loadRuns]);

    useEffect(() => {
        if (!hydrated || !activeProjectId || !activeConversationId) {
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
        const handleLog = (payload: SocketLog) => {
            if (payload?.conversationId !== activeConversationId) return;
            loadMessages().catch(() => undefined);
            loadRuns().catch(() => undefined);
            loadPendingLocalActions().catch(() => undefined);
        };
        socket.on("log", handleLog);
        return () => { socket.off("log", handleLog); };
    }, [activeConversationId, loadMessages, loadPendingLocalActions, loadRuns]);

    useEffect(() => {
        if (!activeConversationId) return;
        const timer = window.setInterval(() => {
            loadPendingLocalActions().catch(() => undefined);
        }, 2500);
        return () => window.clearInterval(timer);
    }, [activeConversationId, loadPendingLocalActions]);

    useEffect(() => {
        if (!pendingRequestId) return;
        const timer = window.setInterval(async () => {
            try {
                const items = await loadMessages();
                const responseArrived = items.some(
                    (message) => message.requestId === pendingRequestId && message.role === "assistant"
                );
                const sendFailed = items.some(
                    (message) => message.requestId === pendingRequestId
                        && message.role === "user"
                        && ["ambiguous", "failed"].includes(message.deliveryState)
                );
                if (responseArrived || sendFailed) {
                    setSending(false);
                    setPendingRequestId("");
                    loadContext().catch(() => undefined);
                    return;
                }
                if (Date.now() - pendingStartedAt.current > 90000) {
                    setSending(false);
                    setPendingRequestId("");
                    setNotice("仍未收到可確認的回覆；系統不會自動重送。請先查看 Edge 中的實際狀態。");
                }
            } catch {
                // Keep the current request visible; the next poll can recover.
            }
        }, 1500);
        return () => window.clearInterval(timer);
    }, [loadContext, loadMessages, pendingRequestId]);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }, [messages]);

    const sendMessage = async (event: FormEvent) => {
        event.preventDefault();
        const text = input.trim();
        if (!text || !project || !conversation || sending) return;
        if (conversation.bindingState === "reconcile_required") {
            setError("這個對話的上次傳送結果不明。請先在 Edge 核對，再使用人工核對功能恢復。系統不會自動重送。");
            return;
        }
        setSending(true);
        setError("");
        setNotice("");
        try {
            const data = await apiPost<{ requestId: string }>(apiUrl("/api/chat"), {
                golemId: "golem_A",
                projectId: project.id,
                conversationId: conversation.id,
                message: text,
            });
            setInput("");
            pendingStartedAt.current = Date.now();
            setPendingRequestId(data.requestId);
            await loadMessages();
        } catch (requestError) {
            setSending(false);
            setError(errorMessage(requestError));
            await loadContext().catch(() => undefined);
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

    const createRun = async (event: FormEvent) => {
        event.preventDefault();
        if (!conversation || !runForm.objective.trim() || !runForm.verification.trim()) return;
        setRunSaving(true);
        setError("");
        try {
            await apiPost(apiUrl(`/api/conversations/${encodeURIComponent(conversation.id)}/runs`), runForm);
            setRunForm((current) => ({ ...current, objective: "" }));
            setShowRunForm(false);
            setShowRuns(true);
            setNotice("已建立工作執行單；必須由你按下「確認開始」後才會送出第一步。");
            await loadRuns();
        } catch (requestError) {
            setError(errorMessage(requestError));
        } finally {
            setRunSaving(false);
        }
    };

    const runAction = async (
        run: M365Run,
        action: "start" | "pause" | "resume" | "cancel" | "reconcile",
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
                    <h2 className="mt-4 text-xl font-semibold">先選擇一個專案對話</h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">對話會綁定獨立的 M365 Copilot 網頁對話，避免不同客戶的內容混在一起。</p>
                    <a href="/dashboard/projects" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground">
                        <FolderKanban className="h-4 w-4" />前往專案
                    </a>
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
                                <a href="/dashboard/projects" className="truncate hover:text-primary">{project.name}</a>
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
                                <ListChecks className="h-3.5 w-3.5" />輸出與來源
                            </button>
                        </div>
                    </div>
                </header>

                {(error || notice || conversation.bindingState === "reconcile_required") && (
                    <div className="mb-3 space-y-2">
                        {error && <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{error}</div>}
                        {notice && <div className="rounded-xl border border-primary/25 bg-primary/5 px-4 py-2.5 text-sm">{notice}</div>}
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
                <div ref={scrollRef} className="custom-scrollbar flex-1 overflow-y-auto p-4">
                    <div className="mx-auto max-w-4xl space-y-4">
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
                                            <div className="prose prose-sm max-w-none break-words text-foreground dark:prose-invert prose-p:my-2 prose-pre:overflow-x-auto">
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                                            </div>
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
                                    M365 Copilot 正在處理…
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <form onSubmit={sendMessage} className="border-t border-border bg-card/50 p-3">
                    <div className="mx-auto max-w-4xl">
                        <div className="relative flex items-end gap-2">
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
                                className="max-h-32 min-h-[44px] flex-1 resize-none rounded-lg border border-border bg-secondary/50 px-4 py-3 pr-12 text-sm text-foreground outline-none transition-all placeholder:text-muted-foreground/50 focus:border-primary/50 focus:ring-1 focus:ring-primary/50 disabled:cursor-not-allowed"
                                placeholder={conversation.bindingState === "reconcile_required" ? "請先完成人工核對" : "傳送訊息給此專案的 M365 Copilot 對話…"}
                            />
                            <button
                                type="submit"
                                disabled={!input.trim() || sending || conversation.bindingState === "reconcile_required"}
                                className="absolute bottom-1.5 right-1.5 flex h-8 w-8 items-center justify-center rounded-md text-cyan-500 transition-all hover:bg-cyan-900/10 hover:text-cyan-400 disabled:cursor-not-allowed disabled:text-muted-foreground/40"
                                aria-label="傳送"
                            >
                                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                            </button>
                        </div>
                        <p className="mt-2 text-center text-[11px] text-muted-foreground">M365 純文字傳輸 · 本機工具需可見核准 · 不使用 Copilot Chat API · 重要判斷須由專業人員覆核</p>
                    </div>
                </form>
                </div>
            </section>

            {showRuns && (
                <aside className="custom-scrollbar absolute inset-y-0 right-0 z-30 w-[min(92vw,380px)] shrink-0 overflow-y-auto border-l border-border bg-background p-4 shadow-2xl xl:static xl:w-[360px] xl:bg-card/40 xl:shadow-none">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Workspace</p>
                            <h3 className="mt-1 font-semibold">輸出、來源與執行</h3>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">像 Codex 一樣，把對話、專案脈絡、工具與執行狀態放在同一工作區。</p>
                        </div>
                        <div className="flex gap-1.5">
                            <button type="button" onClick={() => setShowRunForm((value) => !value)} className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground" aria-label="新增工作">
                                <Plus className="h-4 w-4" />
                            </button>
                            <button type="button" onClick={() => setShowRuns(false)} className="flex h-9 w-9 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-accent" aria-label="關閉輸出與來源面板">
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    </div>

                    <div className="mt-4 space-y-3">
                        <section className={cn(
                            "rounded-2xl border bg-card p-4",
                            pendingLocalActions.length > 0 ? "border-amber-500/40" : "border-border"
                        )}>
                            <div className="flex items-center justify-between gap-3">
                                <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">待核准工具動作</h4>
                                <span className={cn(
                                    "rounded-full px-2 py-1 text-[10px] font-medium",
                                    pendingLocalActions.length > 0
                                        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                        : "bg-secondary text-muted-foreground"
                                )}>
                                    {pendingLocalActions.length > 0 ? `${pendingLocalActions.length} 項待處理` : "無待辦"}
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
                        </section>

                        <section className="rounded-2xl border border-border bg-card p-4">
                            <div className="flex items-center justify-between gap-3">
                                <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">輸出內容</h4>
                                <span className="text-[10px] text-muted-foreground">{messages.length} 則記錄</span>
                            </div>
                            {latestAssistantMessage ? (
                                <div className="mt-3">
                                    <div className="flex items-center gap-2 text-xs font-medium">
                                        <Bot className="h-3.5 w-3.5 text-primary" />
                                        最新 M365 回覆
                                    </div>
                                    <p className="mt-2 line-clamp-5 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                                        {latestAssistantMessage.content}
                                    </p>
                                </div>
                            ) : (
                                <p className="mt-3 text-xs leading-5 text-muted-foreground">尚無輸出；第一次送出前只會建立本機對話，不會自動傳送到 M365。</p>
                            )}
                            {currentRun && (
                                <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs">
                                    <span className="text-muted-foreground">目前工作</span>
                                    <span className="rounded-full bg-secondary px-2 py-1 font-medium">{getRunStatusLabel(currentRun.status)}</span>
                                </div>
                            )}
                        </section>

                        <section className="rounded-2xl border border-border bg-card p-4">
                            <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">來源</h4>
                            <div className="mt-3 space-y-2 text-xs">
                                <a href="/dashboard/projects" className="flex items-start gap-2 rounded-lg p-2 hover:bg-accent">
                                    <FolderKanban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                                    <span className="min-w-0">
                                        <span className="block truncate font-medium">{project.name}</span>
                                        <span className="block text-[10px] text-muted-foreground">專案脈絡 v{project.contextVersion}</span>
                                    </span>
                                </a>
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

                    {showRunForm && (
                        <form onSubmit={createRun} className="mt-4 space-y-3 rounded-2xl border border-border bg-card p-4">
                            <label className="block space-y-1.5 text-xs">
                                <span className="font-medium">要完成的結果 *</span>
                                <textarea required rows={3} maxLength={20000} value={runForm.objective} onChange={(event) => setRunForm((current) => ({ ...current, objective: event.target.value }))} className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring" placeholder="例：整理本案稅務風險、缺件與下一步清單" />
                            </label>
                            <label className="block space-y-1.5 text-xs">
                                <span className="font-medium">限制條件</span>
                                <textarea rows={3} maxLength={20000} value={runForm.constraints} onChange={(event) => setRunForm((current) => ({ ...current, constraints: event.target.value }))} className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring" />
                            </label>
                            <label className="block space-y-1.5 text-xs">
                                <span className="font-medium">完成檢查 *</span>
                                <textarea required rows={3} maxLength={20000} value={runForm.verification} onChange={(event) => setRunForm((current) => ({ ...current, verification: event.target.value }))} className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring" />
                            </label>
                            <label className="flex items-center justify-between gap-3 text-xs">
                                <span className="font-medium">最多步驟</span>
                                <input type="number" min={1} max={12} value={runForm.maxSteps} onChange={(event) => setRunForm((current) => ({ ...current, maxSteps: Number(event.target.value) }))} className="w-20 rounded-lg border border-input bg-background px-2 py-1.5 text-right" />
                            </label>
                            <button disabled={runSaving} className="w-full rounded-xl bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">建立工作執行單</button>
                        </form>
                    )}

                    <div className="mt-4 space-y-3">
                        {runs.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-border p-6 text-center">
                                <ListChecks className="mx-auto h-7 w-7 text-muted-foreground" />
                                <p className="mt-2 text-sm font-medium">尚無多步驟工作</p>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">一般問答仍可直接使用；複雜任務再建立工作執行單。</p>
                            </div>
                        ) : runs.map((run) => (
                            <article key={run.id} className={cn("rounded-2xl border bg-card p-4", run.id === currentRun?.id ? "border-primary/35" : "border-border")}>
                                <div className="flex items-start justify-between gap-3">
                                    <p className="line-clamp-3 text-sm font-medium leading-5">{run.objective}</p>
                                    {run.status === "COMPLETED" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" /> : <ListChecks className="h-4 w-4 shrink-0 text-primary" />}
                                </div>
                                <div className="mt-3 flex items-center justify-between text-xs">
                                    <span className="rounded-full bg-secondary px-2 py-1 font-medium">{getRunStatusLabel(run.status)}</span>
                                    <span className="text-muted-foreground">步驟 {run.currentStep}/{run.maxSteps}</span>
                                </div>
                                {run.id === currentRun?.id && runDetail?.steps.length ? (
                                    <div className="mt-3 space-y-1.5 rounded-xl bg-secondary/55 p-3">
                                        {runDetail.steps.slice(-3).map((step) => (
                                            <div key={step.id} className="flex gap-2 text-[11px] leading-4">
                                                <span className="shrink-0 font-semibold text-primary">{step.stepNumber}.</span>
                                                <span className="line-clamp-2 text-muted-foreground">{step.summary || (step.status === "running" ? "M365 Copilot 處理中" : "等待執行")}</span>
                                            </div>
                                        ))}
                                    </div>
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
        </div>
    );
}
