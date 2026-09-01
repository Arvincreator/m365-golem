"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing } from "lucide-react";
import { apiGet, apiPostWrite } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast-provider";
import { useGolem } from "@/components/GolemContext";
import { useI18n } from "@/components/I18nProvider";

type AutoMessageNotice = {
    id: string;
    text: string;
    dueAt: string;
    createdAt: string;
};

type AutoMessageState = {
    pendingNotice?: AutoMessageNotice | null;
};

type AutoMessageResponse = {
    success?: boolean;
    autoMessage?: AutoMessageState;
    error?: string;
};

type DiaryGenerateResponse = {
    success?: boolean;
    error?: string;
    autoMessage?: AutoMessageState;
};

type GlobalAutoDiaryBellProps = {
    hidden?: boolean;
};

export default function GlobalAutoDiaryBell({ hidden = false }: GlobalAutoDiaryBellProps) {
    const toast = useToast();
    const { locale } = useI18n();
    const { activeGolem } = useGolem();
    const isEnglish = locale === "en";

    const [pendingNotice, setPendingNotice] = useState<AutoMessageNotice | null>(null);
    const [isLoadingNotice, setIsLoadingNotice] = useState(false);
    const [isOpeningNotice, setIsOpeningNotice] = useState(false);

    const withGolemId = useCallback((path: string) => {
        if (!activeGolem) return path;
        const divider = path.includes("?") ? "&" : "?";
        return `${path}${divider}golemId=${encodeURIComponent(activeGolem)}`;
    }, [activeGolem]);

    const loadNotice = useCallback(async (silent = true) => {
        if (!activeGolem) {
            setPendingNotice(null);
            return;
        }
        if (!silent) setIsLoadingNotice(true);
        try {
            const data = await apiGet<AutoMessageResponse>(withGolemId("/api/diary/auto-message"));
            if (!data.success) {
                if (!silent) {
                    toast.error(
                        isEnglish ? "Failed to load AI notice" : "讀取 AI 主動訊息失敗",
                        data.error || (isEnglish ? "Unable to load current notification state." : "無法取得通知狀態。")
                    );
                }
                return;
            }
            setPendingNotice(data.autoMessage?.pendingNotice || null);
        } catch (error: unknown) {
            if (!silent) {
                const message = error instanceof Error ? error.message : (isEnglish ? "Request failed" : "請求失敗");
                toast.error(isEnglish ? "Failed to load AI notice" : "讀取 AI 主動訊息失敗", message);
            }
        } finally {
            if (!silent) setIsLoadingNotice(false);
        }
    }, [activeGolem, isEnglish, toast, withGolemId]);

    useEffect(() => {
        void loadNotice(true);
    }, [loadNotice]);

    useEffect(() => {
        if (!activeGolem) return;
        const timer = window.setInterval(() => {
            void loadNotice(true);
        }, 45 * 1000);
        return () => window.clearInterval(timer);
    }, [activeGolem, loadNotice]);

    const buttonLabel = useMemo(() => {
        if (isOpeningNotice) return isEnglish ? "AI reading..." : "AI 讀取中...";
        if (isLoadingNotice) return isEnglish ? "Loading..." : "讀取中...";
        return pendingNotice?.text || (isEnglish ? "AI has something to say" : "AI 想對你說的話");
    }, [isEnglish, isLoadingNotice, isOpeningNotice, pendingNotice]);

    const handleOpenNotice = useCallback(async () => {
        if (!pendingNotice) return;
        if (!activeGolem) {
            toast.warning(
                isEnglish ? "No active Golem" : "尚未選擇 Golem",
                isEnglish ? "Please pick an active node first." : "請先在側邊欄選擇一個活躍節點。"
            );
            return;
        }

        setIsOpeningNotice(true);
        toast.info(
            isEnglish ? "AI reading..." : "AI 讀取中",
            isEnglish ? "Preparing what AI wants to tell you..." : "正在整理 AI 想對你說的話..."
        );
        try {
            const data = await apiPostWrite<DiaryGenerateResponse>(
                withGolemId("/api/diary/generate"),
                {
                    entryType: "ai_thought",
                    consumeNoticeId: pendingNotice.id,
                }
            );
            if (!data.success) {
                toast.error(
                    isEnglish ? "AI message failed" : "AI 來訊失敗",
                    data.error || (isEnglish ? "Failed to generate AI diary message." : "無法生成 AI 日記訊息。")
                );
                return;
            }
            setPendingNotice(data.autoMessage?.pendingNotice || null);
            toast.success(
                isEnglish ? "AI message delivered" : "AI 訊息已送達",
                isEnglish ? "A new AI thought has been generated." : "已生成一篇新的 AI 對你想法。"
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : (isEnglish ? "Request failed" : "請求失敗");
            toast.error(isEnglish ? "AI message failed" : "AI 來訊失敗", message);
        } finally {
            setIsOpeningNotice(false);
        }
    }, [activeGolem, isEnglish, pendingNotice, toast, withGolemId]);

    if (hidden || !pendingNotice) return null;

    return (
        <div className="fixed top-4 right-4 z-[110] pointer-events-none">
            <button
                onClick={handleOpenNotice}
                disabled={isOpeningNotice}
                className={cn(
                    "pointer-events-auto px-3 py-2 text-xs rounded-lg border border-amber-500/35 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200",
                    "flex items-center gap-1.5 shadow-xl backdrop-blur-sm max-w-[min(26rem,calc(100vw-2rem))]",
                    isOpeningNotice && "opacity-70 cursor-not-allowed"
                )}
                title={pendingNotice.text}
            >
                <BellRing className={cn("w-3.5 h-3.5 shrink-0", isOpeningNotice && "animate-pulse")} />
                <span className="truncate">{buttonLabel}</span>
            </button>
        </div>
    );
}
