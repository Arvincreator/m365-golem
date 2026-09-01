"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
    Bot,
    BrainCircuit,
    CalendarDays,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    FileText,
    Folder,
    FolderKanban,
    Gauge,
    Library,
    MessageSquarePlus,
    MessageSquareText,
    MoreHorizontal,
    Plus,
    Plug,
    Settings,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    SquareTerminal,
    UserRoundCog,
    Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api-client";
import { apiUrl } from "@/lib/api";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
    M365WorkspaceProvider,
    useM365WorkspaceSelection,
} from "@/components/M365WorkspaceContext";
import type {
    M365Conversation,
    M365Project,
    M365WorkspaceStatus,
} from "@/lib/m365-workspace";

const TOOL_ITEMS = [
    { label: "MCP 工具", href: "/dashboard/mcp", icon: Plug },
    { label: "Skills", href: "/dashboard/skills", icon: Sparkles },
    { label: "Action Gate", href: "/dashboard/action-gate", icon: ShieldCheck },
    { label: "多代理", href: "/dashboard/agents", icon: Users },
    { label: "人格設定", href: "/dashboard/persona", icon: UserRoundCog },
    { label: "Prompt 指令池", href: "/dashboard/prompt-pool", icon: Library },
    { label: "Prompt 趨勢", href: "/dashboard/prompt-trends", icon: Gauge },
    { label: "記憶", href: "/dashboard/memory", icon: BrainCircuit },
    { label: "記憶防火牆", href: "/dashboard/memory-firewall", icon: ShieldCheck },
    { label: "參考檔案", href: "/dashboard/reference-files", icon: FileText },
    { label: "協作日曆", href: "/dashboard/calendar", icon: CalendarDays },
    { label: "虛擬辦公室", href: "/dashboard/office", icon: Bot },
    { label: "終端", href: "/dashboard/terminal", icon: SquareTerminal },
    { label: "系統設定", href: "/dashboard/settings", icon: Settings },
] as const;

function CodexSidebar({ open, setOpen }: { open: boolean; setOpen: (value: boolean) => void }) {
    const pathname = usePathname();
    const router = useRouter();
    const {
        hydrated,
        activeProjectId,
        activeConversationId,
        selectProject,
        selectConversation,
    } = useM365WorkspaceSelection();
    const [workspace, setWorkspace] = useState<M365WorkspaceStatus | null>(null);
    const [projects, setProjects] = useState<M365Project[]>([]);
    const [conversationsByProject, setConversationsByProject] = useState<Record<string, M365Conversation[]>>({});
    const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
    const [toolsOpen, setToolsOpen] = useState(false);
    const [creatingConversation, setCreatingConversation] = useState(false);
    const [sidebarError, setSidebarError] = useState("");

    const loadWorkspace = useCallback(async () => {
        try {
            const data = await apiGet<{ workspace: M365WorkspaceStatus }>(
                apiUrl("/api/m365/workspace/status"),
                undefined,
                { retries: 0 }
            );
            setWorkspace(data.workspace);
        } catch {
            setWorkspace(null);
        }
    }, []);

    const loadProjectTree = useCallback(async () => {
        try {
            const data = await apiGet<{ projects: M365Project[] }>(apiUrl("/api/projects"));
            const projectItems = data.projects || [];
            const conversationEntries = await Promise.all(projectItems.map(async (project) => {
                try {
                    const result = await apiGet<{ conversations: M365Conversation[] }>(
                        apiUrl(`/api/projects/${encodeURIComponent(project.id)}/conversations`)
                    );
                    return [project.id, result.conversations || []] as const;
                } catch {
                    return [project.id, []] as const;
                }
            }));
            setProjects(projectItems);
            setConversationsByProject(Object.fromEntries(conversationEntries));
            setSidebarError("");
        } catch (error) {
            setSidebarError(error instanceof Error ? error.message : "無法讀取專案清單");
        }
    }, []);

    useEffect(() => {
        if (!hydrated) return;
        void loadWorkspace();
        void loadProjectTree();
        const timer = window.setInterval(() => {
            void loadWorkspace();
            void loadProjectTree();
        }, 15000);
        return () => window.clearInterval(timer);
    }, [hydrated, loadProjectTree, loadWorkspace]);

    useEffect(() => {
        if (!activeProjectId) return;
        setExpandedProjectIds((current) => {
            const next = new Set(current);
            next.add(activeProjectId);
            return next;
        });
    }, [activeProjectId]);

    const activeProject = useMemo(
        () => projects.find((project) => project.id === activeProjectId) || null,
        [activeProjectId, projects]
    );
    const ready = workspace?.enabled && workspace.encryptionConfigured;

    const createConversation = async () => {
        if (!activeProject) {
            router.push("/dashboard/projects");
            return;
        }
        setCreatingConversation(true);
        setSidebarError("");
        try {
            const data = await apiPost<{ conversation: M365Conversation }>(
                apiUrl(`/api/projects/${encodeURIComponent(activeProject.id)}/conversations`),
                { title: "新對話" }
            );
            setConversationsByProject((current) => ({
                ...current,
                [activeProject.id]: [data.conversation, ...(current[activeProject.id] || [])],
            }));
            selectConversation(activeProject.id, data.conversation.id);
            router.push("/dashboard/chat");
        } catch (error) {
            setSidebarError(error instanceof Error ? error.message : "目前無法建立對話");
        } finally {
            setCreatingConversation(false);
        }
    };

    const toggleProject = (projectId: string) => {
        setExpandedProjectIds((current) => {
            const next = new Set(current);
            if (next.has(projectId)) next.delete(projectId);
            else next.add(projectId);
            return next;
        });
        if (projectId !== activeProjectId) selectProject(projectId);
    };

    return (
        <aside className={cn(
            "enterprise-sidebar flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200",
            open ? "w-[280px]" : "w-[68px]"
        )}>
            <div className="flex min-h-16 items-center justify-between px-3">
                {open && (
                    <a href="/dashboard/projects" className="flex min-w-0 items-center gap-2 px-1">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                            <ShieldCheck className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                            <h1 className="truncate text-sm font-semibold">M365 Golem</h1>
                            <p className="truncate text-[10px] text-muted-foreground">Copilot Web 工作台</p>
                        </div>
                    </a>
                )}
                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={open ? "收合側邊欄" : "展開側邊欄"}
                >
                    {open ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
            </div>

            <div className="space-y-1 px-3 pb-3">
                <button
                    type="button"
                    onClick={() => void createConversation()}
                    disabled={creatingConversation}
                    title={!open ? "新對話" : undefined}
                    className={cn(
                        "flex h-10 w-full items-center rounded-lg text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50",
                        open ? "gap-3 px-3" : "justify-center"
                    )}
                >
                    <MessageSquarePlus className="h-4 w-4 shrink-0" />
                    {open && <span className="font-medium">{creatingConversation ? "建立中…" : "新對話"}</span>}
                </button>
                <a
                    href="/dashboard/projects"
                    title={!open ? "專案管理" : undefined}
                    className={cn(
                        "flex h-10 items-center rounded-lg text-sm transition-colors",
                        open ? "gap-3 px-3" : "justify-center",
                        pathname.startsWith("/dashboard/projects")
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                >
                    <FolderKanban className="h-4 w-4 shrink-0" />
                    {open && <span className="font-medium">專案管理</span>}
                </a>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                {open ? (
                    <>
                        <div className="mb-1 flex items-center justify-between px-3 py-2">
                            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">專案</span>
                            <a href="/dashboard/projects" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="新增專案">
                                <Plus className="h-3.5 w-3.5" />
                            </a>
                        </div>
                        <div className="space-y-1">
                            {projects.map((project) => {
                                const expanded = expandedProjectIds.has(project.id);
                                const conversations = conversationsByProject[project.id] || [];
                                return (
                                    <div key={project.id}>
                                        <button
                                            type="button"
                                            onClick={() => toggleProject(project.id)}
                                            className={cn(
                                                "group flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors hover:bg-accent",
                                                project.id === activeProjectId && "text-foreground"
                                            )}
                                        >
                                            <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
                                            <Folder className="h-4 w-4 shrink-0" />
                                            <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
                                            <MoreHorizontal className="h-4 w-4 shrink-0 opacity-0 group-hover:opacity-100" />
                                        </button>
                                        {expanded && (
                                            <div className="ml-5 border-l border-border/70 pl-2">
                                                {conversations.length === 0 ? (
                                                    <p className="px-2 py-2 text-[11px] text-muted-foreground">尚無對話</p>
                                                ) : conversations.map((conversation) => (
                                                    <button
                                                        key={conversation.id}
                                                        type="button"
                                                        onClick={() => {
                                                            selectConversation(project.id, conversation.id);
                                                            router.push("/dashboard/chat");
                                                        }}
                                                        className={cn(
                                                            "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors",
                                                            conversation.id === activeConversationId
                                                                ? "bg-accent text-foreground"
                                                                : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                                                        )}
                                                    >
                                                        <MessageSquareText className="h-3.5 w-3.5 shrink-0" />
                                                        <span className="truncate">{conversation.title}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            {projects.length === 0 && (
                                <a href="/dashboard/projects" className="block rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground hover:bg-accent">
                                    建立第一個專案
                                </a>
                            )}
                        </div>

                        <div className="mt-4 border-t border-border/70 pt-2">
                            <button
                                type="button"
                                onClick={() => setToolsOpen((current) => !current)}
                                className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !toolsOpen && "-rotate-90")} />
                                <SlidersHorizontal className="h-4 w-4" />
                                <span className="font-medium">更多工具</span>
                            </button>
                            {toolsOpen && (
                                <nav className="mt-1 space-y-0.5 pl-5">
                                    {TOOL_ITEMS.map((item) => {
                                        const Icon = item.icon;
                                        const active = pathname.startsWith(item.href);
                                        return (
                                            <a
                                                key={item.href}
                                                href={item.href}
                                                className={cn(
                                                    "flex h-8 items-center gap-2 rounded-md px-2 text-xs transition-colors",
                                                    active
                                                        ? "bg-accent text-foreground"
                                                        : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                                                )}
                                            >
                                                <Icon className="h-3.5 w-3.5 shrink-0" />
                                                <span className="truncate">{item.label}</span>
                                            </a>
                                        );
                                    })}
                                </nav>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex flex-col items-center gap-1">
                        <a href="/dashboard/projects" title="專案" className="rounded-lg p-2.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                            <Folder className="h-4 w-4" />
                        </a>
                        <button type="button" onClick={() => { setOpen(true); setToolsOpen(true); }} title="更多工具" className="rounded-lg p-2.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                            <SlidersHorizontal className="h-4 w-4" />
                        </button>
                    </div>
                )}
            </div>

            <div className="space-y-3 border-t border-sidebar-border/70 p-3">
                {sidebarError && open && <p className="line-clamp-2 text-[10px] text-destructive">{sidebarError}</p>}
                <div className={cn("flex items-center", open ? "justify-between" : "justify-center")}>
                    {open && <span className="text-xs text-muted-foreground">顯示模式</span>}
                    <ThemeToggle />
                </div>
                <div className={cn("flex items-center gap-2", !open && "justify-center")} title={ready ? "加密工作區已就緒" : "工作區尚未就緒"}>
                    <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", ready ? "bg-emerald-500" : "bg-amber-500")} />
                    {open && (
                        <div className="min-w-0">
                            <p className="truncate text-xs font-medium">{ready ? "M365 工作區已就緒" : "需要檢查設定"}</p>
                            <p className="truncate text-[10px] text-muted-foreground">
                                {workspace?.activeDispatch ? "Edge 正在處理一個對話" : "等待使用者操作"}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </aside>
    );
}

function DashboardShell({ children }: { children: React.ReactNode }) {
    const [sidebarOpen, setSidebarOpen] = useState(true);

    return (
        <div className="flex h-screen overflow-hidden bg-background text-foreground">
            <CodexSidebar open={sidebarOpen} setOpen={setSidebarOpen} />
            <main className="enterprise-shell relative flex min-w-0 flex-1 flex-col overflow-auto bg-background">
                {children}
            </main>
        </div>
    );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    return (
        <M365WorkspaceProvider>
            <DashboardShell>{children}</DashboardShell>
        </M365WorkspaceProvider>
    );
}
