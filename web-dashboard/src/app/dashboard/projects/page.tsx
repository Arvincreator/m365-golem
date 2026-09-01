"use client";

import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
    ArrowRight,
    CheckCircle2,
    FolderKanban,
    Loader2,
    MessageSquarePlus,
    Plus,
    ShieldCheck,
} from "lucide-react";
import { apiGet, apiPost } from "@/lib/api-client";
import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useM365WorkspaceSelection } from "@/components/M365WorkspaceContext";
import {
    formatLocalDate,
    getBindingLabel,
    type M365Conversation,
    type M365Project,
} from "@/lib/m365-workspace";

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : "目前無法完成，請稍後再試。";
}

export default function ProjectsPage() {
    const router = useRouter();
    const {
        hydrated,
        activeProjectId,
        activeConversationId,
        selectProject,
        selectConversation,
    } = useM365WorkspaceSelection();
    const [projects, setProjects] = useState<M365Project[]>([]);
    const [conversations, setConversations] = useState<M365Conversation[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingConversations, setLoadingConversations] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [showProjectForm, setShowProjectForm] = useState(false);
    const [showConversationForm, setShowConversationForm] = useState(false);
    const [projectForm, setProjectForm] = useState({ name: "", description: "", instructions: "" });
    const [conversationTitle, setConversationTitle] = useState("");

    const selectedProject = useMemo(
        () => projects.find((project) => project.id === activeProjectId) || null,
        [activeProjectId, projects]
    );

    const loadProjects = useCallback(async () => {
        const data = await apiGet<{ projects: M365Project[] }>(apiUrl("/api/projects"));
        setProjects(data.projects || []);
        return data.projects || [];
    }, []);

    const loadConversations = useCallback(async (projectId: string) => {
        setLoadingConversations(true);
        try {
            const data = await apiGet<{ conversations: M365Conversation[] }>(
                apiUrl(`/api/projects/${encodeURIComponent(projectId)}/conversations`)
            );
            setConversations(data.conversations || []);
        } finally {
            setLoadingConversations(false);
        }
    }, []);

    useEffect(() => {
        if (!hydrated) return;
        let mounted = true;
        setLoading(true);
        loadProjects()
            .then((items) => {
                if (!mounted || items.length === 0) return;
                if (!items.some((project) => project.id === activeProjectId)) {
                    selectProject(items[0].id);
                }
            })
            .catch((requestError) => mounted && setError(errorMessage(requestError)))
            .finally(() => mounted && setLoading(false));
        return () => { mounted = false; };
    }, [activeProjectId, hydrated, loadProjects, selectProject]);

    useEffect(() => {
        if (!activeProjectId) {
            setConversations([]);
            return;
        }
        loadConversations(activeProjectId).catch((requestError) => setError(errorMessage(requestError)));
    }, [activeProjectId, loadConversations]);

    const createProject = async (event: FormEvent) => {
        event.preventDefault();
        if (!projectForm.name.trim()) return;
        setSaving(true);
        setError("");
        try {
            const data = await apiPost<{ project: M365Project }>(apiUrl("/api/projects"), projectForm);
            setProjects((current) => [data.project, ...current]);
            selectProject(data.project.id);
            setProjectForm({ name: "", description: "", instructions: "" });
            setShowProjectForm(false);
        } catch (requestError) {
            setError(errorMessage(requestError));
        } finally {
            setSaving(false);
        }
    };

    const createConversation = async (event: FormEvent) => {
        event.preventDefault();
        if (!selectedProject || !conversationTitle.trim()) return;
        setSaving(true);
        setError("");
        try {
            const data = await apiPost<{ conversation: M365Conversation }>(
                apiUrl(`/api/projects/${encodeURIComponent(selectedProject.id)}/conversations`),
                { title: conversationTitle }
            );
            setConversations((current) => [data.conversation, ...current]);
            selectConversation(selectedProject.id, data.conversation.id);
            setConversationTitle("");
            setShowConversationForm(false);
            router.push("/dashboard/chat");
        } catch (requestError) {
            setError(errorMessage(requestError));
        } finally {
            setSaving(false);
        }
    };

    const openConversation = (conversation: M365Conversation) => {
        selectConversation(conversation.projectId, conversation.id);
        router.push("/dashboard/chat");
    };

    if (loading || !hydrated) {
        return (
            <div className="flex flex-1 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto p-4 md:p-7">
            <div className="mx-auto max-w-7xl space-y-6">
                <header className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
                    <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">M365 Copilot Web</p>
                        <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">專案與對話</h2>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                            每個客戶或工作主題建立獨立專案；每個專案可以保留多個 M365 對話，重新開啟後接續原本脈絡。
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowProjectForm((value) => !value)}
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
                    >
                        <Plus className="h-4 w-4" />
                        新增專案
                    </button>
                </header>

                {error && (
                    <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                        {error}
                    </div>
                )}

                {showProjectForm && (
                    <form onSubmit={createProject} className="enterprise-card grid gap-4 rounded-2xl border border-border p-5 md:grid-cols-2">
                        <div className="md:col-span-2">
                            <h3 className="font-semibold">建立獨立工作空間</h3>
                            <p className="mt-1 text-xs text-muted-foreground">例如：某客戶 2026 年營所稅查核、內部月結流程改善。</p>
                        </div>
                        <label className="space-y-1.5 text-sm">
                            <span className="font-medium">專案名稱 *</span>
                            <input
                                value={projectForm.name}
                                onChange={(event) => setProjectForm((current) => ({ ...current, name: event.target.value }))}
                                maxLength={160}
                                required
                                className="w-full rounded-xl border border-input bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring"
                                placeholder="例：A 客戶－年度查核"
                            />
                        </label>
                        <label className="space-y-1.5 text-sm">
                            <span className="font-medium">用途說明</span>
                            <input
                                value={projectForm.description}
                                onChange={(event) => setProjectForm((current) => ({ ...current, description: event.target.value }))}
                                maxLength={8000}
                                className="w-full rounded-xl border border-input bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring"
                                placeholder="這個專案要處理什麼"
                            />
                        </label>
                        <label className="space-y-1.5 text-sm md:col-span-2">
                            <span className="font-medium">專案固定指示</span>
                            <textarea
                                value={projectForm.instructions}
                                onChange={(event) => setProjectForm((current) => ({ ...current, instructions: event.target.value }))}
                                maxLength={12000}
                                rows={3}
                                className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring"
                                placeholder="例：回答使用繁體中文；法規或會計判斷要列出依據與待人工覆核項目。請勿在此輸入密碼。"
                            />
                        </label>
                        <div className="flex justify-end gap-2 md:col-span-2">
                            <button type="button" onClick={() => setShowProjectForm(false)} className="rounded-xl border border-border px-4 py-2 text-sm">取消</button>
                            <button disabled={saving} className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                                {saving ? "建立中…" : "建立專案"}
                            </button>
                        </div>
                    </form>
                )}

                {projects.length === 0 ? (
                    <section className="enterprise-card flex min-h-[360px] flex-col items-center justify-center rounded-2xl border border-dashed border-border p-8 text-center">
                        <FolderKanban className="mb-4 h-10 w-10 text-primary" />
                        <h3 className="text-lg font-semibold">先建立第一個專案</h3>
                        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">專案是資料隔離的第一層，也讓同一客戶可以保留多條不同工作對話。</p>
                    </section>
                ) : (
                    <div className="grid min-h-[560px] gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
                        <section className="enterprise-card rounded-2xl border border-border p-3">
                            <div className="px-2 py-2">
                                <h3 className="text-sm font-semibold">專案</h3>
                                <p className="text-xs text-muted-foreground">{projects.length} 個使用中專案</p>
                            </div>
                            <div className="mt-2 space-y-1">
                                {projects.map((project) => (
                                    <button
                                        key={project.id}
                                        type="button"
                                        onClick={() => selectProject(project.id)}
                                        className={cn(
                                            "w-full rounded-xl border px-3 py-3 text-left transition-colors",
                                            project.id === activeProjectId
                                                ? "border-primary/40 bg-primary/10"
                                                : "border-transparent hover:border-border hover:bg-accent/60"
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <span className="line-clamp-2 text-sm font-medium">{project.name}</span>
                                            {project.id === activeProjectId && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
                                        </div>
                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{project.description || "尚未填寫用途說明"}</p>
                                    </button>
                                ))}
                            </div>
                        </section>

                        <section className="enterprise-card rounded-2xl border border-border p-4 md:p-5">
                            {selectedProject && (
                                <>
                                    <div className="flex flex-col justify-between gap-4 border-b border-border pb-4 sm:flex-row sm:items-start">
                                        <div>
                                            <h3 className="text-lg font-semibold">{selectedProject.name}</h3>
                                            <p className="mt-1 text-sm text-muted-foreground">{selectedProject.description || "尚未填寫用途說明"}</p>
                                            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                                                <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                                                本機加密保存 · 專案脈絡 v{selectedProject.contextVersion}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setShowConversationForm((value) => !value)}
                                            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground"
                                        >
                                            <MessageSquarePlus className="h-4 w-4" />
                                            新增對話
                                        </button>
                                    </div>

                                    {showConversationForm && (
                                        <form onSubmit={createConversation} className="my-4 flex flex-col gap-2 rounded-xl border border-primary/25 bg-primary/5 p-3 sm:flex-row">
                                            <input
                                                autoFocus
                                                value={conversationTitle}
                                                onChange={(event) => setConversationTitle(event.target.value)}
                                                maxLength={200}
                                                required
                                                className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                                                placeholder="對話名稱，例如：進項稅額抽核"
                                            />
                                            <button disabled={saving} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                                                建立並開啟
                                            </button>
                                        </form>
                                    )}

                                    <div className="mt-4 space-y-2">
                                        {loadingConversations ? (
                                            <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
                                        ) : conversations.length === 0 ? (
                                            <div className="rounded-xl border border-dashed border-border px-6 py-14 text-center">
                                                <MessageSquarePlus className="mx-auto h-8 w-8 text-muted-foreground" />
                                                <p className="mt-3 text-sm font-medium">這個專案還沒有對話</p>
                                                <p className="mt-1 text-xs text-muted-foreground">建立一個明確主題，首次傳送時會連結新的 M365 Copilot 對話。</p>
                                            </div>
                                        ) : conversations.map((conversation) => (
                                            <button
                                                key={conversation.id}
                                                type="button"
                                                onClick={() => openConversation(conversation)}
                                                className={cn(
                                                    "group flex w-full items-center justify-between gap-4 rounded-xl border p-4 text-left transition-colors",
                                                    conversation.id === activeConversationId
                                                        ? "border-primary/35 bg-primary/5"
                                                        : "border-border hover:bg-accent/50"
                                                )}
                                            >
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-medium">{conversation.title}</p>
                                                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                                        <span>{getBindingLabel(conversation.bindingState)}</span>
                                                        <span>最近工作：{formatLocalDate(conversation.lastMessageAt || conversation.updatedAt)}</span>
                                                    </div>
                                                </div>
                                                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                                            </button>
                                        ))}
                                    </div>
                                </>
                            )}
                        </section>
                    </div>
                )}
            </div>
        </div>
    );
}
