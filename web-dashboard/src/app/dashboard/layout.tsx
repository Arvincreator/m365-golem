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
    Gauge,
    Library,
    MessageSquarePlus,
    MessageSquareText,
    MoreHorizontal,
    Pencil,
    Plus,
    Plug,
    Search,
    Settings,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    SquareTerminal,
    Trash2,
    UserRoundCog,
    Users,
} from "lucide-react";
import {
    DropdownMenu as DropdownMenuPrimitive,
    Popover as PopoverPrimitive,
} from "radix-ui";
import { cn } from "@/lib/utils";
import { apiGet, apiPost, apiWrite } from "@/lib/api-client";
import { apiUrl } from "@/lib/api";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ConfirmModal } from "@/components/ConfirmModal";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    M365WorkspaceProvider,
    useM365WorkspaceSelection,
} from "@/components/M365WorkspaceContext";
import type {
    M365Conversation,
    M365Project,
    M365WorkspaceStatus,
} from "@/lib/m365-workspace";

type ProjectSort = "recent" | "name";

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
    const [creatingConversationProjectId, setCreatingConversationProjectId] = useState("");
    const [showProjectDialog, setShowProjectDialog] = useState(false);
    const [savingProject, setSavingProject] = useState(false);
    const [projectForm, setProjectForm] = useState({ name: "", description: "", instructions: "" });
    const [projectFilter, setProjectFilter] = useState("");
    const [projectSort, setProjectSort] = useState<ProjectSort>("recent");
    const [renamingConversation, setRenamingConversation] = useState<M365Conversation | null>(null);
    const [renameTitle, setRenameTitle] = useState("");
    const [savingRename, setSavingRename] = useState(false);
    const [deletingConversation, setDeletingConversation] = useState<M365Conversation | null>(null);
    const [deletingConversationId, setDeletingConversationId] = useState("");
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
    const visibleProjects = useMemo(() => {
        const query = projectFilter.trim().toLocaleLowerCase("zh-TW");
        const filtered = query
            ? projects.filter((project) => `${project.name}\n${project.description}`.toLocaleLowerCase("zh-TW").includes(query))
            : projects;
        return [...filtered].sort((left, right) => {
            if (projectSort === "name") return left.name.localeCompare(right.name, "zh-Hant");
            return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
        });
    }, [projectFilter, projectSort, projects]);
    const ready = workspace?.enabled && workspace.encryptionConfigured;

    const createProject = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!projectForm.name.trim()) return;
        setSavingProject(true);
        setSidebarError("");
        try {
            const data = await apiPost<{ project: M365Project }>(apiUrl("/api/projects"), {
                name: projectForm.name.trim(),
                description: projectForm.description.trim(),
                instructions: projectForm.instructions.trim(),
            });
            setProjects((current) => [data.project, ...current]);
            setConversationsByProject((current) => ({ ...current, [data.project.id]: [] }));
            setExpandedProjectIds((current) => new Set(current).add(data.project.id));
            selectProject(data.project.id);
            setProjectForm({ name: "", description: "", instructions: "" });
            setShowProjectDialog(false);
        } catch (error) {
            setSidebarError(error instanceof Error ? error.message : "目前無法建立專案");
        } finally {
            setSavingProject(false);
        }
    };

    const createConversation = async (project: M365Project | null = activeProject) => {
        if (!project) {
            setShowProjectDialog(true);
            return;
        }
        setCreatingConversationProjectId(project.id);
        setSidebarError("");
        try {
            const data = await apiPost<{ conversation: M365Conversation }>(
                apiUrl(`/api/projects/${encodeURIComponent(project.id)}/conversations`),
                { title: "新對話" }
            );
            setConversationsByProject((current) => ({
                ...current,
                [project.id]: [data.conversation, ...(current[project.id] || [])],
            }));
            setProjects((current) => current.map((item) => (
                item.id === project.id ? { ...item, updatedAt: data.conversation.updatedAt } : item
            )));
            setExpandedProjectIds((current) => new Set(current).add(project.id));
            selectConversation(project.id, data.conversation.id);
            router.push("/dashboard/chat");
        } catch (error) {
            setSidebarError(error instanceof Error ? error.message : "目前無法建立對話");
        } finally {
            setCreatingConversationProjectId("");
        }
    };

    const openRenameConversation = (conversation: M365Conversation) => {
        setRenamingConversation(conversation);
        setRenameTitle(conversation.title);
        setSidebarError("");
    };

    const saveConversationRename = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!renamingConversation || !renameTitle.trim()) return;
        setSavingRename(true);
        setSidebarError("");
        try {
            const data = await apiWrite<{ conversation: M365Conversation }>(
                apiUrl(`/api/conversations/${encodeURIComponent(renamingConversation.id)}`),
                { method: "PATCH", body: { title: renameTitle.trim() } }
            );
            setConversationsByProject((current) => ({
                ...current,
                [data.conversation.projectId]: (current[data.conversation.projectId] || []).map((item) => (
                    item.id === data.conversation.id ? data.conversation : item
                )),
            }));
            window.dispatchEvent(new CustomEvent("m365-workspace-updated", {
                detail: { conversationId: data.conversation.id },
            }));
            setRenamingConversation(null);
            setRenameTitle("");
        } catch (error) {
            setSidebarError(error instanceof Error ? error.message : "目前無法重新命名對話");
        } finally {
            setSavingRename(false);
        }
    };

    const archiveConversation = async () => {
        if (!deletingConversation) return;
        const target = deletingConversation;
        setDeletingConversationId(target.id);
        setSidebarError("");
        try {
            await apiPost(apiUrl(`/api/conversations/${encodeURIComponent(target.id)}/archive`), {});
            const remaining = (conversationsByProject[target.projectId] || []).filter((item) => item.id !== target.id);
            setConversationsByProject((current) => ({ ...current, [target.projectId]: remaining }));
            if (target.id === activeConversationId) {
                if (remaining[0]) selectConversation(target.projectId, remaining[0].id);
                else selectProject(target.projectId);
                router.push("/dashboard/chat");
            }
            setDeletingConversation(null);
        } catch (error) {
            setSidebarError(error instanceof Error ? error.message : "目前無法刪除對話");
        } finally {
            setDeletingConversationId("");
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
                    <a href="/dashboard/chat" className="flex min-w-0 items-center gap-2 px-1">
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
                    disabled={Boolean(creatingConversationProjectId)}
                    title={!open ? "新對話" : undefined}
                    className={cn(
                        "flex h-10 w-full items-center rounded-lg text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50",
                        open ? "gap-3 px-3" : "justify-center"
                    )}
                >
                    <MessageSquarePlus className="h-4 w-4 shrink-0" />
                    {open && <span className="font-medium">{creatingConversationProjectId ? "建立中…" : "新對話"}</span>}
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                {open ? (
                    <>
                        <div className="mb-1 flex items-center justify-between px-3 py-2">
                            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">專案</span>
                            <div className="flex items-center gap-0.5">
                                <button
                                    type="button"
                                    onClick={() => setShowProjectDialog(true)}
                                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                    aria-label="新增專案"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                </button>
                                <PopoverPrimitive.Root>
                                    <PopoverPrimitive.Trigger asChild>
                                        <button
                                            type="button"
                                            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                            aria-label="排序與篩選專案"
                                        >
                                            <MoreHorizontal className="h-3.5 w-3.5" />
                                        </button>
                                    </PopoverPrimitive.Trigger>
                                    <PopoverPrimitive.Portal>
                                        <PopoverPrimitive.Content
                                            align="end"
                                            sideOffset={8}
                                            className="z-[70] w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
                                        >
                                            <label className="block text-xs font-medium">
                                                篩選專案
                                                <span className="mt-2 flex items-center gap-2 rounded-lg border border-input bg-background px-2.5">
                                                    <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                                    <input
                                                        value={projectFilter}
                                                        onChange={(event) => setProjectFilter(event.target.value)}
                                                        className="h-9 min-w-0 flex-1 bg-transparent text-xs outline-none"
                                                        placeholder="輸入名稱或用途"
                                                    />
                                                </span>
                                            </label>
                                            <div className="mt-3">
                                                <p className="mb-1.5 text-xs font-medium">排序</p>
                                                <div className="grid grid-cols-2 gap-1">
                                                    <button
                                                        type="button"
                                                        onClick={() => setProjectSort("recent")}
                                                        className={cn(
                                                            "rounded-lg px-2 py-2 text-xs transition-colors",
                                                            projectSort === "recent" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70"
                                                        )}
                                                    >
                                                        最近更新
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setProjectSort("name")}
                                                        className={cn(
                                                            "rounded-lg px-2 py-2 text-xs transition-colors",
                                                            projectSort === "name" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70"
                                                        )}
                                                    >
                                                        名稱排序
                                                    </button>
                                                </div>
                                            </div>
                                            <PopoverPrimitive.Arrow className="fill-border" />
                                        </PopoverPrimitive.Content>
                                    </PopoverPrimitive.Portal>
                                </PopoverPrimitive.Root>
                            </div>
                        </div>
                        <div className="space-y-1">
                            {visibleProjects.map((project) => {
                                const expanded = expandedProjectIds.has(project.id);
                                const conversations = conversationsByProject[project.id] || [];
                                return (
                                    <div key={project.id}>
                                        <div className={cn(
                                            "group flex min-h-9 items-center rounded-lg transition-colors hover:bg-accent",
                                            project.id === activeProjectId && "text-foreground"
                                        )}>
                                            <button
                                                type="button"
                                                onClick={() => toggleProject(project.id)}
                                                className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-lg px-2 text-left text-sm"
                                                aria-expanded={expanded}
                                            >
                                                <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
                                                <Folder className="h-4 w-4 shrink-0" />
                                                <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void createConversation(project)}
                                                disabled={Boolean(creatingConversationProjectId)}
                                                className="mr-1 rounded-md p-1.5 text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-40"
                                                aria-label={`在「${project.name}」新增對話`}
                                                title="新增對話"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                        {expanded && (
                                            <div className="ml-5 border-l border-border/70 pl-2">
                                                {conversations.length === 0 ? (
                                                    <p className="px-2 py-2 text-[11px] text-muted-foreground">尚無對話</p>
                                                ) : conversations.map((conversation) => (
                                                    <div
                                                        key={conversation.id}
                                                        className={cn(
                                                            "group flex min-h-8 items-center rounded-md transition-colors",
                                                            conversation.id === activeConversationId
                                                                ? "bg-accent text-foreground"
                                                                : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                                                        )}
                                                    >
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                selectConversation(project.id, conversation.id);
                                                                router.push("/dashboard/chat");
                                                            }}
                                                            className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md px-2 text-left text-xs"
                                                        >
                                                            <MessageSquareText className="h-3.5 w-3.5 shrink-0" />
                                                            <span className="truncate">{conversation.title}</span>
                                                        </button>
                                                        <DropdownMenuPrimitive.Root>
                                                            <DropdownMenuPrimitive.Trigger asChild>
                                                                <button
                                                                    type="button"
                                                                    className="mr-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background/70 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                                                                    aria-label={`管理對話「${conversation.title}」`}
                                                                >
                                                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                                                </button>
                                                            </DropdownMenuPrimitive.Trigger>
                                                            <DropdownMenuPrimitive.Portal>
                                                                <DropdownMenuPrimitive.Content
                                                                    align="end"
                                                                    sideOffset={4}
                                                                    className="z-[70] min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
                                                                >
                                                                    <DropdownMenuPrimitive.Item
                                                                        onSelect={() => openRenameConversation(conversation)}
                                                                        className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-xs outline-none hover:bg-accent focus:bg-accent"
                                                                    >
                                                                        <Pencil className="h-3.5 w-3.5" />
                                                                        重新命名
                                                                    </DropdownMenuPrimitive.Item>
                                                                    <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
                                                                    <DropdownMenuPrimitive.Item
                                                                        onSelect={() => setDeletingConversation(conversation)}
                                                                        className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-xs text-destructive outline-none hover:bg-destructive/10 focus:bg-destructive/10"
                                                                    >
                                                                        <Trash2 className="h-3.5 w-3.5" />
                                                                        刪除對話
                                                                    </DropdownMenuPrimitive.Item>
                                                                </DropdownMenuPrimitive.Content>
                                                            </DropdownMenuPrimitive.Portal>
                                                        </DropdownMenuPrimitive.Root>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            {visibleProjects.length === 0 && (
                                projects.length === 0 ? (
                                    <button
                                        type="button"
                                        onClick={() => setShowProjectDialog(true)}
                                        className="block w-full rounded-lg border border-dashed border-border px-3 py-3 text-left text-xs text-muted-foreground hover:bg-accent"
                                    >
                                        建立第一個專案
                                    </button>
                                ) : (
                                    <p className="px-3 py-3 text-xs text-muted-foreground">沒有符合篩選條件的專案</p>
                                )
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
                        <button type="button" onClick={() => setOpen(true)} title="專案" className="rounded-lg p-2.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                            <Folder className="h-4 w-4" />
                        </button>
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

            <Dialog open={showProjectDialog} onOpenChange={(nextOpen) => !savingProject && setShowProjectDialog(nextOpen)}>
                <DialogContent className="sm:max-w-xl">
                    <form onSubmit={createProject} className="grid gap-4">
                        <DialogHeader>
                            <DialogTitle>新增專案</DialogTitle>
                            <DialogDescription>
                                專案會隔離固定背景與對話脈絡；請勿在固定指示中填入密碼、MFA 或瀏覽器機密。
                            </DialogDescription>
                        </DialogHeader>
                        <label className="grid gap-1.5 text-sm">
                            <span className="font-medium">專案名稱 *</span>
                            <input
                                autoFocus
                                required
                                maxLength={160}
                                value={projectForm.name}
                                onChange={(event) => setProjectForm((current) => ({ ...current, name: event.target.value }))}
                                className="rounded-lg border border-input bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring"
                                placeholder="例：A 客戶－年度查核"
                            />
                        </label>
                        <label className="grid gap-1.5 text-sm">
                            <span className="font-medium">用途說明</span>
                            <input
                                maxLength={8000}
                                value={projectForm.description}
                                onChange={(event) => setProjectForm((current) => ({ ...current, description: event.target.value }))}
                                className="rounded-lg border border-input bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring"
                                placeholder="這個專案要處理什麼"
                            />
                        </label>
                        <label className="grid gap-1.5 text-sm">
                            <span className="font-medium">專案固定指示</span>
                            <textarea
                                rows={4}
                                maxLength={12000}
                                value={projectForm.instructions}
                                onChange={(event) => setProjectForm((current) => ({ ...current, instructions: event.target.value }))}
                                className="resize-y rounded-lg border border-input bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring"
                                placeholder="例：使用繁體中文；會計或法規判斷要列出依據與待人工覆核項目。"
                            />
                        </label>
                        <DialogFooter>
                            <button
                                type="button"
                                onClick={() => setShowProjectDialog(false)}
                                disabled={savingProject}
                                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent disabled:opacity-50"
                            >
                                取消
                            </button>
                            <button
                                type="submit"
                                disabled={savingProject || !projectForm.name.trim()}
                                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                            >
                                {savingProject ? "建立中…" : "建立專案"}
                            </button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog
                open={Boolean(renamingConversation)}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen && !savingRename) {
                        setRenamingConversation(null);
                        setRenameTitle("");
                    }
                }}
            >
                <DialogContent className="sm:max-w-md">
                    <form onSubmit={saveConversationRename} className="grid gap-4">
                        <DialogHeader>
                            <DialogTitle>重新命名對話</DialogTitle>
                            <DialogDescription>只會變更 Golem 側邊欄中的名稱，不會改寫既有訊息內容。</DialogDescription>
                        </DialogHeader>
                        <label className="grid gap-1.5 text-sm">
                            <span className="font-medium">對話名稱</span>
                            <input
                                autoFocus
                                required
                                maxLength={200}
                                value={renameTitle}
                                onChange={(event) => setRenameTitle(event.target.value)}
                                className="rounded-lg border border-input bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring"
                            />
                        </label>
                        <DialogFooter>
                            <button
                                type="button"
                                onClick={() => {
                                    setRenamingConversation(null);
                                    setRenameTitle("");
                                }}
                                disabled={savingRename}
                                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent disabled:opacity-50"
                            >
                                取消
                            </button>
                            <button
                                type="submit"
                                disabled={savingRename || !renameTitle.trim()}
                                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                            >
                                {savingRename ? "儲存中…" : "儲存名稱"}
                            </button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            <ConfirmModal
                isOpen={Boolean(deletingConversation)}
                onClose={() => !deletingConversationId && setDeletingConversation(null)}
                onConfirm={() => void archiveConversation()}
                title="刪除這個對話？"
                description="對話會從目前專案清單移除並保留為本機封存紀錄；Microsoft 365 Copilot 網頁中的原始對話不會被刪除。"
                confirmText="刪除對話"
                variant="danger"
                isLoading={Boolean(deletingConversationId)}
            />
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
