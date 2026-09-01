"use client";

import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastVariant = "success" | "error" | "info" | "warning";

type ToastInput = {
    title: string;
    description?: string;
    variant?: ToastVariant;
    durationMs?: number;
};

type ToastItem = ToastInput & {
    id: string;
    variant: ToastVariant;
};

type ToastContextValue = {
    push: (input: ToastInput) => void;
    success: (title: string, description?: string) => void;
    error: (title: string, description?: string) => void;
    info: (title: string, description?: string) => void;
    warning: (title: string, description?: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 4200;

function getToastStyles(variant: ToastVariant) {
    if (variant === "success") {
        return {
            icon: CheckCircle2,
            wrap: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
            iconClass: "text-emerald-400",
        };
    }
    if (variant === "warning") {
        return {
            icon: TriangleAlert,
            wrap: "border-amber-500/30 bg-amber-500/10 text-amber-300",
            iconClass: "text-amber-400",
        };
    }
    if (variant === "error") {
        return {
            icon: AlertCircle,
            wrap: "border-red-500/30 bg-red-500/10 text-red-300",
            iconClass: "text-red-400",
        };
    }
    return {
        icon: Info,
        wrap: "border-blue-500/30 bg-blue-500/10 text-blue-300",
        iconClass: "text-blue-400",
    };
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);

    const dismiss = useCallback((id: string) => {
        setToasts((prev) => prev.filter((item) => item.id !== id));
    }, []);

    const push = useCallback((input: ToastInput) => {
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const variant = input.variant || "info";
        const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
        const item: ToastItem = { ...input, id, variant };

        setToasts((prev) => [...prev, item]);

        if (durationMs > 0) {
            setTimeout(() => dismiss(id), durationMs);
        }
    }, [dismiss]);

    const value = useMemo<ToastContextValue>(() => ({
        push,
        success: (title, description) => push({ title, description, variant: "success" }),
        error: (title, description) => push({ title, description, variant: "error" }),
        info: (title, description) => push({ title, description, variant: "info" }),
        warning: (title, description) => push({ title, description, variant: "warning" }),
    }), [push]);

    return (
        <ToastContext.Provider value={value}>
            {children}
            <div className="fixed top-4 right-4 z-[120] space-y-2 w-[min(22rem,calc(100vw-2rem))] pointer-events-none">
                {toasts.map((toast) => {
                    const styles = getToastStyles(toast.variant);
                    const Icon = styles.icon;
                    return (
                        <div
                            key={toast.id}
                            className={cn(
                                "pointer-events-auto border rounded-xl px-4 py-3 shadow-xl backdrop-blur animate-in fade-in slide-in-from-top-3 duration-200",
                                styles.wrap
                            )}
                        >
                            <div className="flex items-start gap-3">
                                <Icon className={cn("w-4 h-4 mt-0.5 flex-shrink-0", styles.iconClass)} />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold leading-snug">{toast.title}</p>
                                    {toast.description && (
                                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                                            {toast.description}
                                        </p>
                                    )}
                                </div>
                                <button
                                    onClick={() => dismiss(toast.id)}
                                    className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
                                    aria-label="Close notification"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) {
        throw new Error("useToast must be used within ToastProvider");
    }
    return ctx;
}
