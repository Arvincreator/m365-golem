"use client";

import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function WorkspaceInspector({ open, onOpenChange, triggerRef, children }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    triggerRef: React.RefObject<HTMLButtonElement | null>;
    children: React.ReactNode;
}) {
    const [docked, setDocked] = useState(false);
    useEffect(() => {
        const query = window.matchMedia("(min-width: 1280px)");
        const update = () => setDocked(query.matches);
        update();
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);

    const close = () => { onOpenChange(false); triggerRef.current?.focus(); };
    if (docked) return open ? (
        <section aria-label="來源與執行" className="flex w-[380px] shrink-0 flex-col border-l border-border bg-background"
            onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); close(); } }}>
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border p-4">
                <div><h2 className="font-semibold">來源與執行</h2><p className="mt-1 text-sm text-muted-foreground">查看專案來源、核准及任務實際進度。</p></div>
                <button type="button" aria-label="關閉來源與執行" onClick={close} className="rounded-lg p-2 hover:bg-accent"><X className="h-4 w-4" /></button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        </section>
    ) : null;

    return <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }} className="fixed left-auto right-0 top-0 h-dvh max-h-dvh w-[min(92vw,420px)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-4 motion-reduce:animate-none">
            <DialogHeader><DialogTitle>來源與執行</DialogTitle><DialogDescription>查看專案來源、核准及任務實際進度。</DialogDescription></DialogHeader>
            {children}
        </DialogContent>
    </Dialog>;
}
