"use client";

import UnifiedConsole from "../components/UnifiedConsole";

export default function TerminalPage() {
    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <div className="border-b border-border px-5 py-3">
                <h1 className="text-base font-semibold">終端紀錄</h1>
                <p className="mt-1 text-xs text-muted-foreground">系統日誌每 10 MB 或跨日輪替；預設保留 7 天、最多 20 份壓縮檔且合計不超過 100 MB。</p>
            </div>
            <div className="min-h-0 flex-1"><UnifiedConsole defaultTab="LOGS" showUpdateMarquee /></div>
        </div>
    );
}
