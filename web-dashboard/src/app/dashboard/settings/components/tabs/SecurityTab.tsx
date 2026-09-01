"use client";

import { AlertTriangle, Bot, CheckCircle2, Gauge, HardDrive, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { SettingField, SettingSelectField } from "../SettingFields";
import { useI18n } from "@/components/I18nProvider";
import { cn } from "@/lib/utils";

type SecurityTabProps = {
    env: Record<string, string>;
    onChangeEnv: (key: string, value: string) => void;
};

const DANGEROUS_COMMANDS = [
    "rm -rf /",
    "rd /s /q",
    "> /dev/sd",
    ":(){:|:&};:",
    "mkfs",
    "Format-Volume",
    "dd if=",
    "chmod -x"
];

const SYSTEM_SAFE_LIBRARY = [
    "dir",
    "pwd",
    "date",
    "echo",
    "cat",
    "grep",
    "find",
    "whoami",
    "tail",
    "head",
    "df",
    "free",
    "Get-ChildItem",
    "Select-String",
    "golem-check"
];

const SYSTEM_SAFE_WHITELIST = [
    "ls",
    ...SYSTEM_SAFE_LIBRARY
];

const parseCsv = (value?: string): string[] => {
    if (!value) return [];
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
};

const isEnabled = (value?: string): boolean => String(value || "").trim().toLowerCase() === "true";
const getAutoTurns = (value?: string): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
};

type AutomationMode = "guided" | "balanced" | "autopilot" | "silent" | "custom";

function inferAutomationMode(env: Record<string, string>): AutomationMode {
    const autoApprove = isEnabled(env.GOLEM_AUTO_APPROVE_ALL);
    const silent = isEnabled(env.GOLEM_SILENT_AUTO_APPROVE);
    const trustLibrary = isEnabled(env.GOLEM_TRUST_SYSTEM_COMMANDS);
    const maxTurns = getAutoTurns(env.GOLEM_MAX_AUTO_TURNS);

    if (autoApprove && silent) return "silent";
    if (autoApprove) return "autopilot";
    if (!autoApprove && trustLibrary && maxTurns >= 2) return "balanced";
    if (!autoApprove && !silent && maxTurns <= 1) return "guided";
    return "custom";
}

function ToggleField({
    label,
    desc,
    value,
    onChange,
}: {
    label: string;
    desc: string;
    value: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <div className="rounded-lg border border-border bg-secondary/20 p-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{label}</div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>
                </div>
                <div className="flex shrink-0 rounded-lg border border-border bg-background p-0.5">
                    <button
                        type="button"
                        onClick={() => onChange(true)}
                        className={cn(
                            "px-2.5 py-1 text-xs rounded-md transition-colors",
                            value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        開
                    </button>
                    <button
                        type="button"
                        onClick={() => onChange(false)}
                        className={cn(
                            "px-2.5 py-1 text-xs rounded-md transition-colors",
                            !value ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        關
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function SecurityTab({ env, onChangeEnv }: SecurityTabProps) {
    const { t } = useI18n();
    const whitelist = parseCsv(env.COMMAND_WHITELIST);
    const customCommands = parseCsv(env.CUSTOM_COMMANDS);
    const availableSystemCommands = SYSTEM_SAFE_LIBRARY.filter((cmd) => !whitelist.includes(cmd));
    const automationMode = inferAutomationMode(env);
    const autoApproveAll = isEnabled(env.GOLEM_AUTO_APPROVE_ALL);
    const silentAutoApprove = isEnabled(env.GOLEM_SILENT_AUTO_APPROVE);
    const trustSystemCommands = isEnabled(env.GOLEM_TRUST_SYSTEM_COMMANDS);
    const strictSafeguard = isEnabled(env.GOLEM_STRICT_SAFEGUARD);

    const applyAutomationMode = (mode: Exclude<AutomationMode, "custom">) => {
        if (mode === "guided") {
            onChangeEnv("GOLEM_AUTO_APPROVE_ALL", "false");
            onChangeEnv("GOLEM_SILENT_AUTO_APPROVE", "false");
            onChangeEnv("GOLEM_TRUST_SYSTEM_COMMANDS", "false");
            onChangeEnv("GOLEM_STRICT_SAFEGUARD", "true");
            onChangeEnv("GOLEM_MAX_AUTO_TURNS", "1");
            onChangeEnv("GOLEM_INTERVENTION_LEVEL", "CONSERVATIVE");
            return;
        }

        if (mode === "balanced") {
            onChangeEnv("GOLEM_AUTO_APPROVE_ALL", "false");
            onChangeEnv("GOLEM_SILENT_AUTO_APPROVE", "false");
            onChangeEnv("GOLEM_TRUST_SYSTEM_COMMANDS", "true");
            onChangeEnv("GOLEM_STRICT_SAFEGUARD", "true");
            onChangeEnv("GOLEM_MAX_AUTO_TURNS", "2");
            onChangeEnv("GOLEM_INTERVENTION_LEVEL", "NORMAL");
            return;
        }

        if (mode === "autopilot") {
            onChangeEnv("GOLEM_AUTO_APPROVE_ALL", "true");
            onChangeEnv("GOLEM_SILENT_AUTO_APPROVE", "false");
            onChangeEnv("GOLEM_TRUST_SYSTEM_COMMANDS", "true");
            onChangeEnv("GOLEM_STRICT_SAFEGUARD", "true");
            onChangeEnv("GOLEM_MAX_AUTO_TURNS", "4");
            onChangeEnv("GOLEM_INTERVENTION_LEVEL", "NORMAL");
            return;
        }

        onChangeEnv("GOLEM_AUTO_APPROVE_ALL", "true");
        onChangeEnv("GOLEM_SILENT_AUTO_APPROVE", "true");
        onChangeEnv("GOLEM_TRUST_SYSTEM_COMMANDS", "true");
        onChangeEnv("GOLEM_STRICT_SAFEGUARD", "true");
        onChangeEnv("GOLEM_MAX_AUTO_TURNS", "4");
        onChangeEnv("GOLEM_INTERVENTION_LEVEL", "PROACTIVE");
    };

    const moveToWhitelist = (item: string) => {
        if (!item || whitelist.includes(item)) return;
        onChangeEnv("COMMAND_WHITELIST", [...whitelist, item].join(","));
        onChangeEnv(
            "CUSTOM_COMMANDS",
            customCommands.filter((cmd) => cmd !== item).join(",")
        );
    };

    const removeFromWhitelist = (cmd: string) => {
        const nextWhitelist = whitelist.filter((item) => item !== cmd);
        onChangeEnv("COMMAND_WHITELIST", nextWhitelist.join(","));

        if (!SYSTEM_SAFE_WHITELIST.includes(cmd) && !customCommands.includes(cmd)) {
            onChangeEnv("CUSTOM_COMMANDS", [...customCommands, cmd].join(","));
        }
    };

    const moveToCustomPool = (item: string) => {
        if (!item) return;

        if (!customCommands.includes(item)) {
            onChangeEnv("CUSTOM_COMMANDS", [...customCommands, item].join(","));
        }

        if (whitelist.includes(item)) {
            onChangeEnv(
                "COMMAND_WHITELIST",
                whitelist.filter((cmd) => cmd !== item).join(",")
            );
        }
    };

    const removeFromCustomPool = (cmd: string) => {
        onChangeEnv(
            "CUSTOM_COMMANDS",
            customCommands.filter((item) => item !== cmd).join(",")
        );
    };

    const addCustomCommand = (value: string) => {
        if (!value || customCommands.includes(value)) return;
        onChangeEnv("CUSTOM_COMMANDS", [...customCommands, value].join(","));
    };

    return (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-6">
            <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
                <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                    {t("settings.security.title")}
                </h2>

                <div className="mb-6 rounded-xl border border-primary/20 bg-primary/5 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                                <Bot className="h-4 w-4 text-primary" />
                                自動化模式
                            </h3>
                            <p className="mt-1 text-xs text-muted-foreground">
                                選擇 Golem 使用工具與指令時要多保守。推薦一般使用「平衡模式」。
                            </p>
                        </div>
                        {automationMode === "custom" && (
                            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
                                自訂中
                            </span>
                        )}
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                        {[
                            {
                                id: "guided" as const,
                                icon: ShieldCheck,
                                title: "保守確認",
                                desc: "每次工具鏈很快停下，適合剛開始或高風險任務。",
                            },
                            {
                                id: "balanced" as const,
                                icon: Gauge,
                                title: "平衡模式",
                                desc: "安全指令自動跑，複雜動作會停下來問你。",
                                badge: "推薦",
                            },
                            {
                                id: "autopilot" as const,
                                icon: Sparkles,
                                title: "自動駕駛",
                                desc: "允許更多自動執行，仍保留回報與回合上限。",
                            },
                            {
                                id: "silent" as const,
                                icon: Bot,
                                title: "靜默自動",
                                desc: "減少中間訊息，只顯示結果；適合你完全信任的流程。",
                            },
                        ].map((mode) => {
                            const Icon = mode.icon;
                            const active = automationMode === mode.id;
                            return (
                                <button
                                    key={mode.id}
                                    type="button"
                                    onClick={() => applyAutomationMode(mode.id)}
                                    className={cn(
                                        "text-left rounded-xl border p-4 transition-all",
                                        active
                                            ? "border-primary bg-primary/10 shadow-sm"
                                            : "border-border bg-card hover:border-primary/40 hover:bg-secondary/30"
                                    )}
                                >
                                    <div className="mb-3 flex items-center justify-between gap-2">
                                        <Icon className={cn("h-5 w-5", active ? "text-primary" : "text-muted-foreground")} />
                                        {mode.badge && (
                                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                                                {mode.badge}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-sm font-semibold text-foreground">{mode.title}</div>
                                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{mode.desc}</p>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <SettingSelectField
                        label="Golem 主動程度"
                        desc="控制 Golem 要多主動提醒、建議與介入。這不等於指令自動批准。"
                        value={env.GOLEM_INTERVENTION_LEVEL || "NORMAL"}
                        onChange={(val) => onChangeEnv("GOLEM_INTERVENTION_LEVEL", val)}
                        options={[
                            { value: "CONSERVATIVE", label: "保守：只有重要狀況才提醒" },
                            { value: "NORMAL", label: "一般：適度提供建議" },
                            { value: "PROACTIVE", label: "積極：更像主動協作夥伴" }
                        ]}
                    />
                    <SettingField
                        label="連續自動執行上限"
                        keyName="GOLEM_MAX_AUTO_TURNS"
                        placeholder="2"
                        desc="工具或 MCP 連續回報時，最多允許 Golem 自動接續幾輪。數字越高越自動，越低越常停下來。"
                        value={env.GOLEM_MAX_AUTO_TURNS || ""}
                        onChange={(val) => onChangeEnv("GOLEM_MAX_AUTO_TURNS", val)}
                    />
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <ToggleField
                        label="安全指令免確認"
                        desc="例如查看檔案、列目錄、搜尋文字。開啟後日常查資料比較順。"
                        value={trustSystemCommands}
                        onChange={(value) => onChangeEnv("GOLEM_TRUST_SYSTEM_COMMANDS", String(value))}
                    />
                    <ToggleField
                        label="嚴格阻擋危險指令"
                        desc="建議保持開啟。系統會更早攔截刪檔、格式化磁碟等高風險操作。"
                        value={strictSafeguard}
                        onChange={(value) => onChangeEnv("GOLEM_STRICT_SAFEGUARD", String(value))}
                    />
                    <ToggleField
                        label="全部指令自動批准"
                        desc="開啟後 Golem 會少問很多問題，但也代表你信任它執行大多數指令。"
                        value={autoApproveAll}
                        onChange={(value) => onChangeEnv("GOLEM_AUTO_APPROVE_ALL", String(value))}
                    />
                    <ToggleField
                        label="隱藏中間執行訊息"
                        desc="適合自動流程。開啟後會減少工具執行過程的聊天訊息。"
                        value={silentAutoApprove}
                        onChange={(value) => onChangeEnv("GOLEM_SILENT_AUTO_APPROVE", String(value))}
                    />
                </div>
            </div>

            <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
                <h3 className="text-lg font-bold text-foreground mb-4 flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-primary" />
                    {t("settings.security.dragDrop.title")}
                </h3>
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 pb-4">
                    <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4 flex flex-col h-full">
                        <h4 className="text-sm font-semibold text-destructive flex items-center gap-2 mb-3">
                            <AlertTriangle className="w-4 h-4" /> {t("settings.security.blocked.title")}
                        </h4>
                        <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar h-[22rem]">
                            {DANGEROUS_COMMANDS.map((cmd, idx) => (
                                <div
                                    key={`danger-${idx}`}
                                    className="px-3 py-2 bg-destructive/20 border border-destructive/40 text-destructive text-xs font-mono rounded cursor-not-allowed opacity-80"
                                >
                                    {cmd}
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="bg-secondary/30 border border-border rounded-xl p-4 flex flex-col h-full">
                        <h4 className="text-sm font-semibold text-muted-foreground flex items-center gap-2 mb-3">
                            {t("settings.security.systemLibrary.title")}
                        </h4>
                        <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar h-[22rem]">
                            {availableSystemCommands.map((cmd, idx) => (
                                <div
                                    key={`safe-drv-${idx}`}
                                    draggable
                                    onDragStart={(e) => {
                                        e.dataTransfer.setData("text/plain", cmd);
                                        e.dataTransfer.effectAllowed = "move";
                                    }}
                                    className="px-3 py-2 bg-secondary border border-border text-foreground/80 text-xs font-mono rounded cursor-grab hover:border-primary shadow-sm active:cursor-grabbing group flex items-center justify-between"
                                >
                                    <span>{cmd}</span>
                                    <span className="text-[10px] text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity">{t("settings.security.systemLibrary.dragEnable")}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div
                        className="bg-primary/5 border border-primary/20 rounded-xl p-4 flex flex-col h-full transition-colors relative"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            e.preventDefault();
                            moveToWhitelist(e.dataTransfer.getData("text/plain"));
                        }}
                    >
                        <h4 className="text-sm font-semibold text-primary flex items-center gap-2 mb-3">
                            <CheckCircle2 className="w-4 h-4" /> {t("settings.security.allowList.title")}
                        </h4>
                        <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar h-[22rem]">
                            {whitelist.map((cmd, idx) => (
                                <div
                                    key={`whitelist-${idx}`}
                                    draggable
                                    onDragStart={(e) => {
                                        e.dataTransfer.setData("text/plain", cmd);
                                        e.dataTransfer.effectAllowed = "move";
                                    }}
                                    className="px-3 py-2 bg-primary/10 border border-primary/30 text-primary text-xs font-mono rounded cursor-grab flex items-center justify-between group shadow-sm"
                                >
                                    <span>{cmd}</span>
                                    <button
                                        onClick={() => removeFromWhitelist(cmd)}
                                        className="opacity-0 group-hover:opacity-100 text-red-400 p-0.5"
                                    >
                                        <RefreshCw className="w-3 h-3 rotate-45" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div
                        className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 flex flex-col h-full transition-colors relative"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            e.preventDefault();
                            moveToCustomPool(e.dataTransfer.getData("text/plain"));
                        }}
                    >
                        <h4 className="text-sm font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-2 mb-3">
                            <HardDrive className="w-4 h-4" /> {t("settings.security.customPool.title")}
                        </h4>
                        <input
                            type="text"
                            placeholder={t("settings.security.customPool.placeholder")}
                            className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs font-mono mb-3"
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    const val = e.currentTarget.value.trim();
                                    addCustomCommand(val);
                                    if (val) {
                                        e.currentTarget.value = "";
                                    }
                                }
                            }}
                        />
                        <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar h-[19rem]">
                            {customCommands.map((cmd, idx) => (
                                <div
                                    key={`pool-${idx}`}
                                    draggable
                                    onDragStart={(e) => {
                                        e.dataTransfer.setData("text/plain", cmd);
                                        e.dataTransfer.effectAllowed = "move";
                                    }}
                                    className="px-3 py-2 bg-secondary border border-border text-foreground/80 text-xs font-mono rounded cursor-grab flex items-center justify-between group shadow-sm hover:border-blue-500"
                                >
                                    <span>{cmd}</span>
                                    <button
                                        onClick={() => removeFromCustomPool(cmd)}
                                        className="opacity-0 group-hover:opacity-100 text-red-400 p-0.5"
                                    >
                                        <RefreshCw className="w-3 h-3 rotate-45" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
