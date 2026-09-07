"use client";

import { useEffect, useRef, useState } from "react";
import type { M365Run, M365RunDetail } from "@/lib/m365-workspace";

export function RunAttention({ run, detail, busy, replying, onReplyingChange, act }: {
    run: M365Run | null;
    detail: M365RunDetail | null;
    busy: boolean;
    replying: boolean;
    onReplyingChange: (value: boolean) => void;
    act: (run: M365Run, action: "resume" | "cancel" | "reconcile", body?: Record<string, unknown>) => Promise<boolean>;
}) {
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [toast, setToast] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const pending = useRef(false);
    const needsAttention = !!run && ["WAITING_USER", "BLOCKED", "RECONCILE_REQUIRED"].includes(run.status);
    const question = detail?.run.id === run?.id ? detail?.plan?.question || "" : "";
    const attentionKey = needsAttention ? `${run.id}:${run.status}:${question}` : "";
    useEffect(() => {
        const frame = window.requestAnimationFrame(() => setToast(Boolean(attentionKey)));
        const timer = window.setTimeout(() => setToast(false), 8000);
        return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
    }, [attentionKey]);
    useEffect(() => { onReplyingChange(false); }, [run?.id, run?.status, onReplyingChange]);
    useEffect(() => { if (replying) inputRef.current?.focus(); }, [replying]);
    if (!needsAttention || !run) return null;

    const reconcile = run.status === "RECONCILE_REQUIRED";
    const title = reconcile ? "多步驟工作需要你核對" : run.status === "BLOCKED" ? "多步驟工作受阻" : "多步驟工作等待你的補充";
    const text = drafts[run.id] || "";
    const perform = async (action: "resume" | "cancel" | "reconcile", body = {}) => {
        if (pending.current || busy) return;
        pending.current = true;
        try {
            if (await act(run, action, body)) {
                setDrafts(current => current[run.id] === text ? { ...current, [run.id]: "" } : current);
                onReplyingChange(false);
            }
        } finally { pending.current = false; }
    };
    return <>
        {toast && <div role="status" aria-label="工作提醒" className="fixed right-5 top-5 z-50 max-w-sm rounded-xl border border-amber-500 bg-background p-4 shadow-lg">
            <p className="font-semibold">{title}</p>
            <p className="mt-1 text-sm">請在對話輸入區上方處理。</p>
            <button type="button" className="mt-2 underline" onClick={() => setToast(false)}>知道了</button>
        </div>}
        <section aria-label="多步驟待處理" className="shrink-0 border-t border-amber-500/50 bg-amber-500/10 p-3">
            <h2 className="font-semibold">{title}</h2>
            <p className="truncate text-xs text-muted-foreground" title={run.objective}>{run.objective}</p>
            <p className="my-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-sm">{reconcile ? "請先到 Edge 查看前一步的實際結果，再選擇處理方式。" : question || "請補充缺少的資訊或說明問題已如何排除，再接續工作。"}</p>
            {replying && !reconcile && <form onSubmit={event => { event.preventDefault(); if (text.trim()) void perform("resume", { input: text }); }}>
                <label className="text-sm" htmlFor="run-supplement">補充此多步驟工作（原對話草稿已保留）</label>
                <textarea id="run-supplement" ref={inputRef} value={text} disabled={busy} maxLength={20000} rows={3} onChange={event => setDrafts(current => ({ ...current, [run.id]: event.target.value }))} className="mt-1 w-full rounded-xl border border-input bg-background p-3" />
                <button disabled={busy || !text.trim()} type="submit" className="mr-3 rounded-lg bg-primary px-3 py-2 text-primary-foreground disabled:opacity-40">補充並繼續</button>
                <button disabled={busy} type="button" onClick={() => onReplyingChange(false)}>返回一般對話</button>
            </form>}
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
                {!replying && !reconcile && <button disabled={busy} type="button" className="rounded-lg bg-primary px-3 py-2 text-primary-foreground" onClick={() => onReplyingChange(true)}>補充說明</button>}
                {reconcile && <>
                    <button disabled={busy} type="button" onClick={() => void perform("reconcile", { resolution: "not_sent", note: "使用者已在 Edge 確認前一步未送出。" })}>已確認未送出，重試</button>
                    <button disabled={busy} type="button" onClick={() => { if (window.confirm("你是否已在 Edge 核對工作確實完成？")) void perform("reconcile", { resolution: "completed", note: "使用者已在 Edge 確認工作完成。" }); }}>已在 Edge 確認完成</button>
                </>}
                <button disabled={busy} type="button" className="text-destructive" onClick={() => void perform("cancel")}>停止後續步驟</button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">停止後續步驟不會中止已送出的回合。</p>
        </section>
    </>;
}
