"use client";
import { useState } from "react";
import type { M365Message } from "@/lib/m365-workspace";

export function MessageToolbar({ message, onQuote }: { message: M365Message; onQuote: (quote: { messageId: string; excerpt: string }) => void }) {
    const [notice, setNotice] = useState("");
    return <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <button type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(message.content); setNotice("已複製"); }
            catch { setNotice("無法存取剪貼簿，請選取答案手動複製。"); }
        }}>複製回答</button>
        <button type="button" onClick={event => {
            const selection = window.getSelection();
            const article = event.currentTarget.closest("article");
            const selected = selection && article?.contains(selection.anchorNode) && article.contains(selection.focusNode) ? selection.toString() : "";
            onQuote({ messageId: message.id, excerpt: (selected || message.content).slice(0, 12000) });
        }}>引用追問</button>
        <details><summary className="cursor-pointer">詳細資訊</summary><p className="break-all">訊息：{message.id} · 來源：{message.source} · {message.createdAt}</p></details>
        <span role="status">{notice}</span>
    </div>;
}
