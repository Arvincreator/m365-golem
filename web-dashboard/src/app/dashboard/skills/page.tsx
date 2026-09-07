"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    BookOpen,
    CheckCircle2,
    CircleAlert,
    Code2,
    Loader2,
    Pencil,
    Plus,
    RefreshCcw,
    Save,
    Sparkles,
    Trash2,
    X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import { apiGet, apiPostWrite } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type RuntimeKind = "executable" | "prompt_only" | "broken" | "unknown";

type SkillRecord = {
    id: string;
    title: string;
    description?: string;
    content: string;
    category?: string;
    isMandatory?: boolean;
    isOptional?: boolean;
    isDeletable?: boolean;
    isEnabled: boolean;
    runtimeKind: RuntimeKind;
    healthStatus?: string;
    healthMessage?: string;
};

type CheckResponse = {
    success?: boolean;
    summary?: {
        total: number;
        registered: number;
        loadable: number;
        promptOnly: number;
        broken: number;
    };
};

type EditorState = {
    mode: "create" | "edit";
    id: string;
    content: string;
} | null;

function getErrorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : "目前無法完成，請稍後再試。";
}

function runtimeLabel(kind: RuntimeKind) {
    if (kind === "executable") return "可執行工具";
    if (kind === "prompt_only") return "M365 提示規則";
    if (kind === "broken") return "不可用";
    return "待檢查";
}

export default function SkillsPage() {
    const toast = useToast();
    const [skills, setSkills] = useState<SkillRecord[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const [loading, setLoading] = useState(true);
    const [checking, setChecking] = useState(false);
    const [busyId, setBusyId] = useState("");
    const [summary, setSummary] = useState<CheckResponse["summary"]>();
    const [editor, setEditor] = useState<EditorState>(null);

    const selected = useMemo(
        () => skills.find((item) => item.id === selectedId) || skills[0] || null,
        [selectedId, skills]
    );

    const loadSkills = useCallback(async () => {
        setLoading(true);
        try {
            const data = await apiGet<SkillRecord[]>("/api/skills");
            const next = Array.isArray(data) ? data : [];
            setSkills(next);
            setSelectedId((current) => next.some((item) => item.id === current) ? current : (next[0]?.id || ""));
        } catch (error) {
            toast.error("讀取失敗", getErrorMessage(error));
        } finally {
            setLoading(false);
        }
    }, [toast]);

    const checkSkills = useCallback(async () => {
        setChecking(true);
        try {
            const result = await apiGet<CheckResponse>("/api/skills/check");
            setSummary(result.summary);
            await loadSkills();
            toast.success("檢查完成", result.summary?.broken ? `發現 ${result.summary.broken} 個不可用套件。` : "所有顯示中的技能都有可用內容。" );
        } catch (error) {
            toast.error("檢查失敗", getErrorMessage(error));
        } finally {
            setChecking(false);
        }
    }, [loadSkills, toast]);

    useEffect(() => {
        loadSkills();
    }, [loadSkills]);

    const toggleSkill = async (skill: SkillRecord) => {
        if (skill.isMandatory) return;
        setBusyId(skill.id);
        try {
            await apiPostWrite("/api/skills/toggle", { id: skill.id, enabled: !skill.isEnabled });
            await loadSkills();
            toast.success(!skill.isEnabled ? "已啟用" : "已停用", "會從下一個 M365 對話回合開始生效。");
        } catch (error) {
            toast.error("更新失敗", getErrorMessage(error));
        } finally {
            setBusyId("");
        }
    };

    const saveEditor = async () => {
        if (!editor) return;
        const id = editor.id.trim();
        const content = editor.content.trim();
        if (!id || !content) {
            toast.warning("資料不完整", "請填寫技能 ID 與 Markdown 說明內容。");
            return;
        }
        setBusyId(id);
        try {
            await apiPostWrite(editor.mode === "create" ? "/api/skills/create" : "/api/skills/update", { id, content });
            setEditor(null);
            await loadSkills();
            setSelectedId(id.toLowerCase().replace(/[^a-z0-9_-]/g, "_"));
            toast.success("已儲存", "這是提示規則，選取後會載入下一個 M365 回合。");
        } catch (error) {
            toast.error("儲存失敗", getErrorMessage(error));
        } finally {
            setBusyId("");
        }
    };

    const deleteSkill = async (skill: SkillRecord) => {
        if (!skill.isDeletable || skill.isMandatory) return;
        if (!window.confirm(`確定刪除「${skill.title}」？此動作會移除它的使用者技能檔案。`)) return;
        setBusyId(skill.id);
        try {
            await apiPostWrite("/api/skills/delete", { id: skill.id });
            await loadSkills();
            toast.success("已刪除", skill.title);
        } catch (error) {
            toast.error("刪除失敗", getErrorMessage(error));
        } finally {
            setBusyId("");
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden bg-background p-6">
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <div className="flex items-center gap-3">
                        <span className="rounded-xl border border-primary/25 bg-primary/10 p-2.5"><BookOpen className="h-5 w-5 text-primary" /></span>
                        <div>
                            <h1 className="text-2xl font-bold">技能說明書</h1>
                            <p className="mt-1 text-sm text-muted-foreground">只顯示 M365 Golem 真正會載入的工具與提示規則。</p>
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => setEditor({ mode: "create", id: "", content: "# 新技能\n\n## 使用時機\n\n## 處理規則\n" })} className="gap-2">
                        <Plus className="h-4 w-4" />新增提示技能
                    </Button>
                    <Button variant="secondary" onClick={checkSkills} disabled={checking} className="gap-2">
                        {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}檢查可用性
                    </Button>
                </div>
            </header>

            <div className="grid gap-3 rounded-xl border border-border bg-card/60 p-3 text-xs sm:grid-cols-3">
                <div><span className="text-muted-foreground">可執行工具</span><strong className="ml-2 text-foreground">{summary?.loadable ?? skills.filter((s) => s.runtimeKind === "executable").length}</strong></div>
                <div><span className="text-muted-foreground">M365 提示規則</span><strong className="ml-2 text-foreground">{summary?.promptOnly ?? skills.filter((s) => s.runtimeKind === "prompt_only").length}</strong></div>
                <div><span className="text-muted-foreground">不可用</span><strong className={cn("ml-2", (summary?.broken ?? 0) > 0 ? "text-red-400" : "text-emerald-400")}>{summary?.broken ?? skills.filter((s) => s.runtimeKind === "broken").length}</strong></div>
            </div>

            <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(280px,0.85fr)_minmax(0,1.35fr)]">
                <section className="custom-scrollbar min-h-0 space-y-2 overflow-y-auto rounded-2xl border border-border bg-card p-3">
                    {loading ? (
                        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />載入技能…</div>
                    ) : skills.length === 0 ? (
                        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">沒有可用技能。</p>
                    ) : skills.map((skill) => (
                        <button
                            key={skill.id}
                            type="button"
                            onClick={() => setSelectedId(skill.id)}
                            className={cn("w-full rounded-xl border p-3 text-left transition", selected?.id === skill.id ? "border-primary/50 bg-primary/10" : "border-border bg-background/40 hover:bg-accent")}
                        >
                            <span className="flex items-start justify-between gap-3">
                                <span className="min-w-0">
                                    <span className="block truncate text-sm font-semibold">{skill.title}</span>
                                    <code className="mt-1 block truncate text-[10px] text-muted-foreground">{skill.id}</code>
                                </span>
                                {skill.runtimeKind === "broken" ? <CircleAlert className="h-4 w-4 shrink-0 text-red-400" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />}
                            </span>
                            <span className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px]">
                                <span className={cn("rounded-full px-2 py-1", skill.runtimeKind === "executable" ? "bg-cyan-500/10 text-cyan-300" : skill.runtimeKind === "prompt_only" ? "bg-violet-500/10 text-violet-300" : "bg-red-500/10 text-red-300")}>{runtimeLabel(skill.runtimeKind)}</span>
                                <span className={cn("rounded-full px-2 py-1", skill.isEnabled ? "bg-emerald-500/10 text-emerald-300" : "bg-secondary text-muted-foreground")}>{skill.isEnabled ? "已啟用" : "已停用"}</span>
                            </span>
                        </button>
                    ))}
                </section>

                <section className="custom-scrollbar min-h-0 overflow-y-auto rounded-2xl border border-border bg-card p-5">
                    {selected ? (
                        <>
                            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                                <div>
                                    <h2 className="text-lg font-semibold">{selected.title}</h2>
                                    <p className="mt-1 text-xs text-muted-foreground">{selected.healthMessage || runtimeLabel(selected.runtimeKind)}</p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {!selected.isMandatory && (
                                        <Button variant="secondary" size="sm" disabled={busyId === selected.id || selected.runtimeKind === "broken"} onClick={() => toggleSkill(selected)}>
                                            {selected.isEnabled ? "停用" : "啟用"}
                                        </Button>
                                    )}
                                    {selected.isDeletable && !selected.isMandatory && (
                                        <>
                                            <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setEditor({ mode: "edit", id: selected.id, content: selected.content })}><Pencil className="h-3.5 w-3.5" />編輯</Button>
                                            <Button variant="secondary" size="sm" className="gap-1.5 text-red-300" disabled={busyId === selected.id} onClick={() => deleteSkill(selected)}><Trash2 className="h-3.5 w-3.5" />刪除</Button>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="my-4 grid gap-3 text-xs sm:grid-cols-2">
                                <div className="rounded-xl border border-border bg-background/40 p-3"><Code2 className="mb-2 h-4 w-4 text-cyan-400" /><strong>可執行工具</strong><p className="mt-1 leading-5 text-muted-foreground">由 Golem 在 Action Gate 中執行；仍受核准與路徑政策限制。</p></div>
                                <div className="rounded-xl border border-border bg-background/40 p-3"><Sparkles className="mb-2 h-4 w-4 text-violet-400" /><strong>提示規則</strong><p className="mt-1 leading-5 text-muted-foreground">選取後注入該次 M365 回合，不會假裝成可執行 action。</p></div>
                            </div>

                            <pre className="whitespace-pre-wrap break-words rounded-xl border border-border bg-background/60 p-4 font-sans text-sm leading-6 text-foreground">{selected.content || "這個套件沒有技能說明內容。"}</pre>
                        </>
                    ) : null}
                </section>
            </div>

            {editor && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={editor.mode === "create" ? "新增提示技能" : "編輯提示技能"}>
                    <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-border bg-card p-5 shadow-2xl">
                        <div className="flex items-center justify-between gap-3">
                            <div><h2 className="text-lg font-semibold">{editor.mode === "create" ? "新增提示技能" : "編輯提示技能"}</h2><p className="mt-1 text-xs text-muted-foreground">儲存後可從 M365 對話框的「＋ → Skills」選取。</p></div>
                            <button type="button" onClick={() => setEditor(null)} aria-label="關閉"><X className="h-5 w-5 text-muted-foreground" /></button>
                        </div>
                        <label className="mt-4 text-xs font-medium text-muted-foreground">技能 ID</label>
                        <input value={editor.id} disabled={editor.mode === "edit"} onChange={(event) => setEditor({ ...editor, id: event.target.value })} placeholder="例如：vat-review" className="mt-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60" />
                        <label className="mt-4 text-xs font-medium text-muted-foreground">Markdown 說明與規則</label>
                        <textarea value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} className="custom-scrollbar mt-1 min-h-72 flex-1 resize-y rounded-xl border border-border bg-background p-3 font-mono text-sm outline-none focus:border-primary" />
                        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setEditor(null)}>取消</Button><Button onClick={saveEditor} disabled={Boolean(busyId)} className="gap-2">{busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}儲存</Button></div>
                    </div>
                </div>
            )}
        </div>
    );
}
