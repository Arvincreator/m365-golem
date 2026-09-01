"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
    AlertTriangle,
    CheckCircle2,
    Database,
    ExternalLink,
    KeyRound,
    Loader2,
    MonitorUp,
    RefreshCw,
    ShieldCheck,
} from "lucide-react";
import { apiGet, apiPost } from "@/lib/api-client";
import { apiUrl } from "@/lib/api";
import type { M365WorkspaceStatus } from "@/lib/m365-workspace";

type SystemStatus = {
    isBooting?: boolean;
    hasGolems?: boolean;
    liveCount?: number;
};

function StatusCard({
    icon: Icon,
    title,
    value,
    detail,
    ready,
}: {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    value: string;
    detail: string;
    ready: boolean;
}) {
    return (
        <div className="enterprise-card rounded-2xl border border-border p-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                </div>
                {ready ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <AlertTriangle className="h-5 w-5 text-amber-500" />}
            </div>
            <p className="mt-4 text-xs font-medium text-muted-foreground">{title}</p>
            <p className="mt-1 text-lg font-semibold">{value}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
        </div>
    );
}

export default function M365SettingsPage() {
    const [workspace, setWorkspace] = useState<M365WorkspaceStatus | null>(null);
    const [system, setSystem] = useState<SystemStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [starting, setStarting] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    const refresh = useCallback(async () => {
        setError("");
        try {
            const [workspaceData, systemData] = await Promise.all([
                apiGet<{ workspace: M365WorkspaceStatus }>(apiUrl("/api/m365/workspace/status"), undefined, { retries: 0 }),
                apiGet<SystemStatus>(apiUrl("/api/system/status"), undefined, { retries: 0 }),
            ]);
            setWorkspace(workspaceData.workspace);
            setSystem(systemData);
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : "無法取得系統狀態。");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const startEdge = async () => {
        setStarting(true);
        setError("");
        setMessage("");
        try {
            await apiPost(apiUrl("/api/golems/start"), { id: "golem_A" });
            setMessage("已送出啟動要求。請在可見 Edge 視窗親自完成登入或 MFA；畫面出現不代表登入已驗證成功。 ");
            window.setTimeout(refresh, 1200);
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : "無法啟動 Edge 工作階段。");
        } finally {
            setStarting(false);
        }
    };

    if (loading) {
        return <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
    }

    const runtimeReady = Number(system?.liveCount || 0) > 0 && !system?.isBooting;

    return (
        <div className="flex-1 overflow-y-auto p-4 md:p-7">
            <div className="mx-auto max-w-5xl space-y-6">
                <header className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
                    <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Local Control</p>
                        <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">系統狀態</h2>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">這個版本以原版 Golem 為核心，加入 M365 Copilot Web、Codex 式專案對話與有界多步驟工作；只退役 RPG、股市、加密貨幣與羈絆日記。</p>
                    </div>
                    <div className="flex gap-2">
                        <button type="button" onClick={refresh} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border px-4 text-sm hover:bg-accent">
                            <RefreshCw className="h-4 w-4" />重新檢查
                        </button>
                        <button type="button" onClick={startEdge} disabled={starting} className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
                            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}啟動可見 Edge
                        </button>
                    </div>
                </header>

                {error && <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
                {message && <div className="rounded-xl border border-primary/25 bg-primary/5 px-4 py-3 text-sm">{message}</div>}

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <StatusCard icon={MonitorUp} title="瀏覽器執行器" value={runtimeReady ? "已啟動" : "尚未就緒"} detail="使用本機可見 Microsoft Edge；登入與 MFA 由使用者親自完成。" ready={runtimeReady} />
                    <StatusCard icon={Database} title="專案保存" value={workspace?.enabled ? "已啟用" : "未啟用"} detail="專案、對話、訊息、執行步驟與檢查點保存在本機。" ready={Boolean(workspace?.enabled)} />
                    <StatusCard icon={KeyRound} title="靜態資料加密" value={workspace?.encryptionConfigured ? "已設定" : "缺少金鑰"} detail="沒有有效的本機金鑰時會停止，不會降級成明文保存。" ready={Boolean(workspace?.encryptionConfigured)} />
                    <StatusCard icon={ShieldCheck} title="多步驟工作" value={workspace?.runnerEnabled ? "已啟用" : "未啟用"} detail="有最大步數、逐步檢查點、開始核准與不明結果停止機制。" ready={Boolean(workspace?.runnerEnabled)} />
                </div>

                <section className="enterprise-card rounded-2xl border border-border p-5 md:p-6">
                    <h3 className="font-semibold">目前安全邊界</h3>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                        {[
                            ["不使用 Copilot Chat API", "所有提示與回覆都經由可見 M365 網頁操作。"],
                            ["純文字傳輸、工具另行核准", "不自動上傳附件；Action／Skill／MCP 總開關預設關閉，啟用後仍逐項顯示並等待本機核准。"],
                            ["單一 Edge 派送鎖", "同一時間只允許一個專案對話使用可見 Edge，避免串錯對話。"],
                            ["傳送不明不重試", "如果無法確認提示是否已送出，會要求人工核對，避免重複工作。"],
                            ["專案脈絡可追溯", "專案固定指示有版本；每個對話綁定獨立 M365 對話網址。"],
                            ["專業覆核保留", "會計、稅務、法律與簽核結論都不是自動核准或正式送件。"],
                        ].map(([title, detail]) => (
                            <div key={title} className="rounded-xl border border-border bg-background/60 p-4">
                                <div className="flex items-start gap-2">
                                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                                    <div>
                                        <p className="text-sm font-medium">{title}</p>
                                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-6 text-amber-900 dark:text-amber-100">
                    <AlertTriangle className="mt-1 h-4 w-4 shrink-0" />
                    <p>目前是技術 POC。瀏覽器畫面顯示登入、測試通過或本機成功保存，都不等於公司資訊安全、Microsoft 租戶政策、專案授權或正式上線核准。</p>
                </div>
            </div>
        </div>
    );
}
