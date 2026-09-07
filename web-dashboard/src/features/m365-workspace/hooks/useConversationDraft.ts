"use client";
import { useEffect, useSyncExternalStore } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { apiUrl } from "@/lib/api";
import { DraftController, type Draft } from "../lib/draft-controller";

const controllers = new Map<string, DraftController>();
export function useConversationDraft(projectId: string, conversationId: string) {
    const key = JSON.stringify([projectId, conversationId]);
    let controller = controllers.get(key);
    if (!controller) {
        const url = apiUrl(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/draft`);
        controller = new DraftController({
            read: async () => (await apiGet<{ draft: Draft }>(url, { cache: "no-store" }, { retries: 0 })).draft,
            write: async (draft, expectedRevision) => (await apiPost<{ draft: Draft }>(url, { draft, expectedRevision }, undefined, { retries: 0 })).draft,
        });
        controllers.set(key, controller);
    }
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    useEffect(() => {
        void controller.initialize();
        return () => { void controller.persist().catch(() => undefined); };
    }, [controller]);
    return { ...state, controller };
}
export function otherAttachmentBytes(controller: DraftController) {
    return [...controllers.values()].filter(value => value !== controller).reduce((total, value) => total + value.getSnapshot().files.reduce((n, item) => n + item.file.size, 0), 0);
}
