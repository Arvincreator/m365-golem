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
    const [toast, setToast] = useState(false);
    const pending = useRef(false);
    const needsAttention = !!run && ["WAITING_USER", "BLOCKED", "RECONCILE_REQUIRED"].includes(run.status);
    const autoTurnLimit = run?.status === "WAITING_USER" && run.errorCode === "M365_AUTO_TURN_LIMIT";
    const protocolRepairExhausted = run?.status === "WAITING_USER" && run.errorCode === "M365_PROTOCOL_REPAIR_EXHAUSTED";
    const question = detail?.run.id === run?.id ? detail?.plan?.question || "" : "";
    const unplannedRepairFailure = protocolRepairExhausted && detail?.run.id === run?.id && !detail?.plan;
    const shouldReplyToRun = Boolean(run && ["WAITING_USER", "BLOCKED"].includes(run.status) && !unplannedRepairFailure);
    const attentionKey = needsAttention ? `${run.id}:${run.status}:${run.errorCode || ""}:${question}` : "";
    useEffect(() => {
        const frame = window.requestAnimationFrame(() => setToast(Boolean(attentionKey)));
        const timer = window.setTimeout(() => setToast(false), 8000);
        return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
    }, [attentionKey]);
    useEffect(() => {
        onReplyingChange(shouldReplyToRun);
    }, [attentionKey, onReplyingChange, shouldReplyToRun]);
    if (!needsAttention || !run) return null;

    const reconcile = run.status === "RECONCILE_REQUIRED";
    const title = autoTurnLimit
        ? "自動回合已用完，工作已保存"
        : unplannedRepairFailure
            ? "未收到 GOLEM_PLAN，沒有啟動多步驟"
        : protocolRepairExhausted
            ? "已停止重複要求 Copilot 改寫"
        : reconcile
            ? "多步驟工作需要你核對"
            : run.status === "BLOCKED" ? "多步驟工作受阻" : "多步驟工作等待你的補充";
    const perform = async (action: "resume" | "cancel" | "reconcile", body = {}) => {
        if (pending.current || busy) return;
        pending.current = true;
        try {
            if (await act(run, action, body)) {
                onReplyingChange(false);
            }
        } finally { pending.current = false; }
    };
    return <>
        {toast && <div role="status" aria-label="工作提醒" className="fixed right-5 top-5 z-50 max-w-sm rounded-xl border border-amber-500 bg-background p-4 shadow-lg">
            <p className="font-semibold">{title}</p>
            <p className="mt-1 text-sm">{autoTurnLimit
                ? "可提高下一輪自動執行額度並立即接續，或停止這項工作。"
                : unplannedRepairFailure
                    ? "這不是要你補資料；請直接閱讀對話中已顯示的 Copilot 回覆。"
                : protocolRepairExhausted
                    ? "Copilot 沒有提出可執行步驟；系統已停止自動補正，避免重複訊息。"
                    : "請在對話輸入區上方處理。"}</p>
            <button type="button" className="mt-2 underline" onClick={() => setToast(false)}>知道了</button>
        </div>}
        <section aria-label="多步驟待處理" className="shrink-0 border-t border-amber-500/50 bg-amber-500/10 p-3">
            <h2 className="font-semibold">{title}</h2>
            <p className="truncate text-xs text-muted-foreground" title={run.objective}>{run.objective}</p>
            <p className="my-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-sm">{autoTurnLimit
                ? "下一回合尚未送出。繼續後會以 N+1 回合為新的自動執行額度並立即接續；不是只執行 1 回合。再次用完額度時會重新詢問。"
                : unplannedRepairFailure
                    ? "Copilot 有提供一般回答，但沒有提出有效的 GOLEM_PLAN。Golem 不會把這種回答轉成多步驟，也不需要你猜測要補充什麼。"
                : protocolRepairExhausted
                    ? "請改寫或補充工作指令後再接續；若本機資料夾仍顯示在輸入框上方，Copilot 會繼續取得該資料夾的按需讀取能力。"
                    : reconcile ? "請先到 Edge 查看前一步的實際結果，再選擇處理方式。" : question || "請補充缺少的資訊或說明問題已如何排除，再接續工作。"}</p>
            {replying && !reconcile && !autoTurnLimit && !unplannedRepairFailure && <div className="rounded-xl border border-input bg-background p-3 text-sm">
                <p>請在下方對話框補充；可加入檔案或貼上截圖。送出後會承接這個計畫。</p>
                <button disabled={busy} type="button" className="mt-2 underline" onClick={() => onReplyingChange(false)}>返回一般對話</button>
            </div>}
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
                {autoTurnLimit && <button disabled={busy} type="button" className="rounded-lg bg-primary px-3 py-2 font-medium text-primary-foreground" onClick={() => void perform("resume", { continueAutoRun: true })}>繼續自動執行</button>}
                {!replying && !reconcile && !autoTurnLimit && !unplannedRepairFailure && <button disabled={busy} type="button" className="rounded-lg bg-primary px-3 py-2 text-primary-foreground" onClick={() => onReplyingChange(true)}>補充說明</button>}
                {reconcile && <>
                    <button disabled={busy} type="button" onClick={() => void perform("reconcile", { resolution: "not_sent", note: "使用者已在 Edge 確認前一步未送出。" })}>已確認未送出，重試</button>
                    <button disabled={busy} type="button" onClick={() => { if (window.confirm("你是否已在 Edge 核對工作確實完成？")) void perform("reconcile", { resolution: "completed", note: "使用者已在 Edge 確認工作完成。" }); }}>已在 Edge 確認完成</button>
                </>}
                <button disabled={busy} type="button" className="text-destructive" onClick={() => void perform("cancel")}>{unplannedRepairFailure ? "清除錯誤狀態並返回一般對話" : "停止後續步驟"}</button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">停止後續步驟不會中止已送出的回合。</p>
        </section>
    </>;
}
