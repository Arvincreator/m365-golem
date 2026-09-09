"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
    AlertTriangle,
    CheckCircle2,
    FolderOpen,
    Globe2,
    Loader2,
    Plus,
    RefreshCw,
    Server,
    ShieldCheck,
    Trash2,
} from "lucide-react";
import { apiUrl } from "@/lib/api";
import { apiGet, apiPostWrite, apiWrite } from "@/lib/api-client";

type BridgePolicy = {
    writeEnabled: boolean;
    allowOverwrite: boolean;
    allowRecycle: boolean;
    readHostPatterns: string[];
    deniedHosts: string[];
    deniedSites: string[];
    allowedLocalPaths: string[];
};

type EditableList = "deniedHosts" | "deniedSites" | "allowedLocalPaths";
type EditableSetting = "writeEnabled" | "allowOverwrite" | "allowRecycle";
type McpServer = { name: string; enabled?: boolean; connected?: boolean };

const LIST_CARDS: Array<{
    key: EditableList;
    title: string;
    description: string;
    placeholder: string;
}> = [
    {
        key: "deniedHosts",
        title: "禁止的網域",
        description: "明確排除不應由 Golem 操作的 SharePoint 網域。",
        placeholder: "blocked.sharepoint.com",
    },
    {
        key: "deniedSites",
        title: "禁止的站台路徑",
        description: "用於明確排除敏感或不應由 Golem 操作的站台。",
        placeholder: "/sites/Confidential",
    },
    {
        key: "allowedLocalPaths",
        title: "允許上傳的本機專案資料夾",
        description: "Bridge 只能從這些資料夾讀取待上傳檔案；請勿加入磁碟根目錄。",
        placeholder: "C:\\Users\\you\\Documents\\Project",
    },
];

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

function PolicyListCard({
    definition,
    values,
    input,
    disabled,
    onInput,
    onAdd,
    onRemove,
}: {
    definition: (typeof LIST_CARDS)[number];
    values: string[];
    input: string;
    disabled: boolean;
    onInput: (value: string) => void;
    onAdd: () => void;
    onRemove: (value: string) => void;
}) {
    const isLocalPath = definition.key === "allowedLocalPaths";
    const Icon = isLocalPath ? FolderOpen : Globe2;
    return (
        <section className="enterprise-card rounded-2xl border border-border p-5">
            <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                </div>
                <div>
                    <h3 className="font-semibold">{definition.title}</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{definition.description}</p>
                </div>
            </div>
            <form
                className="mt-4 flex gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    onAdd();
                }}
            >
                <input
                    value={input}
                    onChange={(event) => onInput(event.target.value)}
                    placeholder={definition.placeholder}
                    disabled={disabled}
                    className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
                <button
                    type="submit"
                    disabled={disabled || !input.trim()}
                    className="inline-flex items-center gap-1 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
                >
                    <Plus className="h-4 w-4" />加入
                </button>
            </form>
            <div className="mt-4 space-y-2">
                {values.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">目前沒有項目</p>
                ) : values.map((value) => (
                    <div key={value} className="flex items-center justify-between gap-3 rounded-xl bg-secondary/45 px-3 py-2">
                        <code className="min-w-0 break-all text-xs">{value || "/"}</code>
                        <button
                            type="button"
                            onClick={() => onRemove(value)}
                            disabled={disabled}
                            aria-label={`移除 ${value}`}
                            className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                        >
                            <Trash2 className="h-4 w-4" />
                        </button>
                    </div>
                ))}
            </div>
        </section>
    );
}

export default function M365BridgePage() {
    const [policy, setPolicy] = useState<BridgePolicy | null>(null);
    const [server, setServer] = useState<McpServer | null>(null);
    const [inputs, setInputs] = useState<Record<EditableList, string>>({
        deniedHosts: "",
        deniedSites: "",
        allowedLocalPaths: "",
    });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState("");
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    const refresh = useCallback(async () => {
        setLoading(true);
        setMessage("");
        setError("");
        const [serversResult, policyResult] = await Promise.allSettled([
            apiGet<{ servers?: McpServer[] }>(apiUrl("/api/mcp/servers"), undefined, { retries: 0 }),
            apiGet<BridgePolicy>(apiUrl("/api/mcp/bridge/policy"), undefined, { retries: 0 }),
        ]);

        if (serversResult.status === "fulfilled") {
            setServer((serversResult.value.servers || []).find((item) => item.name === "m365-session-bridge") || null);
        } else {
            setServer(null);
            setError(errorMessage(serversResult.reason, "無法讀取內建 MCP 狀態。"));
        }

        if (policyResult.status === "fulfilled") {
            setPolicy(policyResult.value);
        } else {
            setPolicy(null);
            setError(errorMessage(policyResult.reason, "Bridge 管理服務尚未就緒。"));
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    async function enableBridge() {
        setSaving("enable");
        setMessage("");
        setError("");
        try {
            await apiPostWrite(apiUrl("/api/mcp/servers/m365-session-bridge/toggle"), { enabled: true });
            await refresh();
            setMessage("M365 Session Bridge 已啟用。");
        } catch (requestError) {
            setError(errorMessage(requestError, "無法啟用 Bridge。"));
        } finally {
            setSaving("");
        }
    }

    async function updateSetting(key: EditableSetting, value: boolean) {
        if (value && (key === "allowOverwrite" || key === "allowRecycle")) {
            const label = key === "allowOverwrite" ? "覆寫既有檔案" : "移到資源回收筒";
            if (!window.confirm(`確定要允許「${label}」嗎？實際操作仍會經過 Action Gate 與 SharePoint 權限檢查。`)) return;
        }
        setSaving(key);
        setMessage("");
        setError("");
        try {
            const next = await apiWrite<BridgePolicy>(apiUrl("/api/mcp/bridge/settings"), {
                method: "PATCH",
                body: { [key]: value },
            });
            setPolicy(next);
            setMessage("Bridge 設定已更新。");
        } catch (requestError) {
            setError(errorMessage(requestError, "無法更新 Bridge 設定。"));
        } finally {
            setSaving("");
        }
    }

    async function changeEntry(list: EditableList, value: string, method: "POST" | "DELETE") {
        const normalized = value.trim();
        if (!normalized) return;
        const loosensBoundary = (method === "POST" && list === "allowedLocalPaths")
            || (method === "DELETE" && (list === "deniedHosts" || list === "deniedSites"));
        if (loosensBoundary && !window.confirm("這項變更會擴大 Bridge 可接觸的範圍。確定繼續嗎？")) return;

        const operation = `${method}:${list}:${normalized}`;
        setSaving(operation);
        setMessage("");
        setError("");
        try {
            const next = await apiWrite<BridgePolicy>(apiUrl("/api/mcp/bridge/entries"), {
                method,
                body: { list, value: normalized },
            });
            setPolicy(next);
            if (method === "POST") {
                setInputs((current) => ({ ...current, [list]: "" }));
            }
            setMessage(method === "POST" ? "項目已加入。" : "項目已移除。");
        } catch (requestError) {
            setError(errorMessage(requestError, "無法更新 Bridge 範圍。"));
        } finally {
            setSaving("");
        }
    }

    const serverEnabled = server?.enabled === true;
    const serverConnected = server?.connected === true;
    const controlsDisabled = loading || Boolean(saving) || !policy;

    return (
        <div className="flex-1 overflow-y-auto p-4 md:p-7">
            <div className="mx-auto max-w-6xl space-y-6">
                <header className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
                    <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Built-in MCP</p>
                        <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">M365 Session Bridge</h2>
                        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">在 Golem 內管理 SharePoint／OneDrive 的可用範圍與寫入政策，不再另外開啟控制視窗。</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void refresh()}
                        disabled={loading}
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm hover:bg-accent disabled:opacity-50"
                    >
                        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />重新整理
                    </button>
                </header>

                {error && (
                    <div className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <div><p>{error}</p><p className="mt-1 text-xs opacity-80">請確認 Golem 背景程式與內建 Bridge 已啟動，再按「重新整理」。</p></div>
                    </div>
                )}
                {message && <div className="rounded-xl border border-primary/25 bg-primary/5 px-4 py-3 text-sm">{message}</div>}

                <div className="grid gap-4 md:grid-cols-3">
                    <section className="enterprise-card rounded-2xl border border-border p-5">
                        <Server className="h-5 w-5 text-primary" />
                        <p className="mt-4 text-xs text-muted-foreground">內建 MCP</p>
                        <p className="mt-1 font-semibold">{serverEnabled ? "已啟用" : "尚未啟用"}</p>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">乾淨安裝與再次安裝都會自動啟用，不需要使用者另外設定。</p>
                        {!serverEnabled && server && (
                            <button type="button" onClick={() => void enableBridge()} disabled={Boolean(saving)} className="mt-3 rounded-xl bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">
                                {saving === "enable" ? "啟用中…" : "立即啟用"}
                            </button>
                        )}
                    </section>
                    <section className="enterprise-card rounded-2xl border border-border p-5">
                        {serverConnected ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <AlertTriangle className="h-5 w-5 text-amber-500" />}
                        <p className="mt-4 text-xs text-muted-foreground">目前連線</p>
                        <p className="mt-1 font-semibold">{serverConnected ? "Bridge 已連線" : serverEnabled ? "等待 Bridge 就緒" : "Bridge 未啟用"}</p>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">登入與 MFA 仍由使用者在可見 Edge 完成。</p>
                    </section>
                    <section className="enterprise-card rounded-2xl border border-border p-5">
                        <ShieldCheck className="h-5 w-5 text-primary" />
                        <p className="mt-4 text-xs text-muted-foreground">授權邊界</p>
                        <p className="mt-1 font-semibold">黑名單優先</p>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">登入帳號可見的支援站點預設可嘗試存取；黑名單、站台權限與 Action Gate 仍會阻擋不允許的操作。</p>
                    </section>
                </div>

                <section className="enterprise-card rounded-2xl border border-border p-5 md:p-6">
                    <h3 className="font-semibold">一般寫入設定</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">建立資料夾、上傳、複製、移動、重新命名與中繼資料更新屬於非破壞性寫入；覆寫和資源回收筒仍預設關閉。</p>
                    <div className="mt-5 grid gap-3 md:grid-cols-3">
                        {([
                            ["writeEnabled", "允許非破壞性寫入", "仍需通過黑名單、M365 權限與 Action Gate"],
                            ["allowOverwrite", "允許覆寫既有檔案", "只有工具明確要求時才會覆寫"],
                            ["allowRecycle", "允許移到資源回收筒", "永久刪除仍固定禁止"],
                        ] as Array<[EditableSetting, string, string]>).map(([key, label, detail]) => (
                            <label key={key} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4">
                                <input
                                    type="checkbox"
                                    checked={Boolean(policy?.[key])}
                                    onChange={(event) => void updateSetting(key, event.target.checked)}
                                    disabled={controlsDisabled}
                                    className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]"
                                />
                                <span><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{detail}</span></span>
                            </label>
                        ))}
                    </div>
                </section>

                {loading && !policy ? (
                    <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-16 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />讀取 Bridge 政策…
                    </div>
                ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                        {LIST_CARDS.map((definition) => (
                            <PolicyListCard
                                key={definition.key}
                                definition={definition}
                                values={policy?.[definition.key] || []}
                                input={inputs[definition.key]}
                                disabled={controlsDisabled}
                                onInput={(value) => setInputs((current) => ({ ...current, [definition.key]: value }))}
                                onAdd={() => void changeEntry(definition.key, inputs[definition.key], "POST")}
                                onRemove={(value) => void changeEntry(definition.key, value, "DELETE")}
                            />
                        ))}
                    </div>
                )}

                <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-6 text-amber-900 dark:text-amber-100">
                    <AlertTriangle className="mt-1 h-4 w-4 shrink-0" />
                    <p>Bridge 是 SharePoint Online／OneDrive for Business 的精確網址檔案橋接器，不是通用 Microsoft Graph、Outlook、Teams 或全租戶搜尋工具。</p>
                </div>
            </div>
        </div>
    );
}
