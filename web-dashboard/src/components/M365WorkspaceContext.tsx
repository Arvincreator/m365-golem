"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
    ACTIVE_CONVERSATION_STORAGE_KEY,
    ACTIVE_PROJECT_STORAGE_KEY,
} from "@/lib/m365-workspace";

type WorkspaceSelectionContext = {
    hydrated: boolean;
    activeProjectId: string;
    activeConversationId: string;
    selectProject: (projectId: string) => void;
    selectConversation: (projectId: string, conversationId: string) => void;
    clearSelection: () => void;
};

const M365WorkspaceContext = createContext<WorkspaceSelectionContext | null>(null);

export function M365WorkspaceProvider({ children }: { children: React.ReactNode }) {
    const [hydrated, setHydrated] = useState(false);
    const [activeProjectId, setActiveProjectId] = useState("");
    const [activeConversationId, setActiveConversationId] = useState("");

    useEffect(() => {
        setActiveProjectId(localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) || "");
        setActiveConversationId(localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY) || "");
        setHydrated(true);
    }, []);

    const value = useMemo<WorkspaceSelectionContext>(() => ({
        hydrated,
        activeProjectId,
        activeConversationId,
        selectProject: (projectId: string) => {
            setActiveProjectId(projectId);
            setActiveConversationId("");
            localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
            localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
        },
        selectConversation: (projectId: string, conversationId: string) => {
            setActiveProjectId(projectId);
            setActiveConversationId(conversationId);
            localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
            localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, conversationId);
        },
        clearSelection: () => {
            setActiveProjectId("");
            setActiveConversationId("");
            localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
            localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
        },
    }), [activeConversationId, activeProjectId, hydrated]);

    return <M365WorkspaceContext.Provider value={value}>{children}</M365WorkspaceContext.Provider>;
}

export function useM365WorkspaceSelection(): WorkspaceSelectionContext {
    const value = useContext(M365WorkspaceContext);
    if (!value) throw new Error("useM365WorkspaceSelection must be used inside M365WorkspaceProvider");
    return value;
}
