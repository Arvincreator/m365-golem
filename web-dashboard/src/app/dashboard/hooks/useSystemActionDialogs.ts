"use client";

import { useCallback, useState } from "react";
import { ConfirmDialogState, DoneDialogState } from "../types";
import { requestSystemReload, requestSystemShutdown } from "../services/systemActions";

export function useSystemActionDialogs() {
    const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
        open: false,
        variant: "restart",
    });
    const [doneDialog, setDoneDialog] = useState<DoneDialogState>({
        open: false,
        variant: "restarted",
    });
    const [isLoading, setIsLoading] = useState(false);

    const openConfirm = useCallback((variant: "restart" | "shutdown") => {
        setConfirmDialog({ open: true, variant });
    }, []);

    const setConfirmDialogOpen = useCallback((open: boolean) => {
        setConfirmDialog((prev) => ({ ...prev, open }));
    }, []);

    const setDoneDialogOpen = useCallback((open: boolean) => {
        setDoneDialog((prev) => ({ ...prev, open }));
    }, []);

    const handleReload = useCallback(async () => {
        setIsLoading(true);
        try {
            const success = await requestSystemReload();
            if (success) {
                setConfirmDialog((prev) => ({ ...prev, open: false }));
                setDoneDialog({ open: true, variant: "restarted" });
                setTimeout(() => window.location.reload(), 3000);
            }
        } catch (error) {
            console.error("Reload failed:", error);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const handleShutdown = useCallback(async () => {
        setIsLoading(true);
        try {
            const success = await requestSystemShutdown();
            if (success) {
                setConfirmDialog((prev) => ({ ...prev, open: false }));
                setDoneDialog({ open: true, variant: "shutdown" });
            }
        } catch {
            // Process shutdown may interrupt response; treat as expected shutdown success UX.
            setConfirmDialog((prev) => ({ ...prev, open: false }));
            setDoneDialog({ open: true, variant: "shutdown" });
        } finally {
            setIsLoading(false);
        }
    }, []);

    const handleConfirm = useCallback(() => {
        if (confirmDialog.variant === "restart") {
            void handleReload();
            return;
        }
        if (confirmDialog.variant === "shutdown") {
            void handleShutdown();
        }
    }, [confirmDialog.variant, handleReload, handleShutdown]);

    return {
        confirmDialog,
        doneDialog,
        isLoading,
        openConfirm,
        handleConfirm,
        setConfirmDialogOpen,
        setDoneDialogOpen,
    };
}
