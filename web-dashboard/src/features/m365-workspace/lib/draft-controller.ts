import type { PendingM365Attachment } from "@/lib/m365-attachments";

export type Draft = {
    schemaVersion: 1; text: string; responseMode: "auto" | "quick" | "thoughtful";
    referenceFileIds: string[]; mcpServerNames: string[]; skillIds: string[];
    quote: { messageId: string; excerpt: string } | null;
    attachmentDescriptors: { id: string; fileName: string; size: number; lastModified: number; state: string }[];
    revision: number;
};
export const emptyDraft = (): Draft => ({ schemaVersion: 1, text: "", responseMode: "auto", referenceFileIds: [], mcpServerNames: [], skillIds: [], quote: null, attachmentDescriptors: [], revision: 0 });
type Transport = { read: () => Promise<Draft>; write: (draft: Draft, expectedRevision: number) => Promise<Draft> };
type Snapshot = { draft: Draft; files: PendingM365Attachment[]; status: "loading" | "saved" | "saving" | "unsaved" | "conflict"; error: string; edit: number };

export class DraftController {
    private state: Snapshot = { draft: emptyDraft(), files: [], status: "loading", error: "", edit: 0 };
    private listeners = new Set<() => void>();
    private timer?: ReturnType<typeof setTimeout>;
    private chain: Promise<unknown> = Promise.resolve();
    private initialized?: Promise<void>;
    private revision = 0;
    private savedEdit = 0;
    private submitting = false;
    constructor(private transport: Transport) {}
    getSnapshot = () => this.state;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private emit(patch: Partial<Snapshot>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
    initialize() {
        if (!this.initialized) this.initialized = this.transport.read().then(draft => {
            this.revision = draft.revision;
            this.emit({ draft, status: "saved" });
        }).catch(() => { this.emit({ status: "unsaved", error: "無法載入加密草稿；目前內容只在記憶體，請重新載入後再送出。" }); });
        return this.initialized;
    }
    update(patch: Partial<Draft>, files = this.state.files) {
        this.emit({ draft: { ...this.state.draft, ...patch }, files, edit: this.state.edit + 1,
            status: this.state.status === "conflict" ? "conflict" : "unsaved" });
        clearTimeout(this.timer);
        if (!this.submitting && this.state.status !== "conflict") this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, 600);
    }
    flush() {
        clearTimeout(this.timer);
        const work = this.chain.then(async () => {
            await this.initialize();
            if (this.state.error || this.state.status === "conflict") throw new Error(this.state.error || "請先處理草稿衝突。");
            const snapshot = this.state;
            if (this.savedEdit === snapshot.edit) return this.revision;
            this.emit({ status: "saving" });
            try {
                const saved = await this.transport.write(snapshot.draft, this.revision);
                this.revision = saved.revision;
                this.savedEdit = snapshot.edit;
                this.emit({ draft: { ...this.state.draft, revision: saved.revision }, status: this.state.edit === snapshot.edit ? "saved" : "unsaved" });
                return this.revision;
            } catch (error) {
                const conflict = (error as { status?: number }).status === 409;
                this.emit({ status: conflict ? "conflict" : "unsaved", error: conflict ? "另一個視窗已更新草稿。本視窗內容仍保留，請比較後選擇版本。" : "草稿尚未保存；請重試保存，不會自動重送訊息。" });
                throw error;
            }
        });
        this.chain = work.catch(() => undefined);
        return work;
    }
    async resolveConflict(useLocal: boolean, comparedVersion?: Draft) {
        clearTimeout(this.timer);
        await this.chain;
        const remote = comparedVersion || await this.transport.read();
        this.revision = remote.revision;
        if (useLocal) {
            this.emit({ error: "", status: "unsaved" });
            this.savedEdit = -1;
            await this.flush();
        } else {
            this.savedEdit = this.state.edit + 1;
            this.emit({ draft: remote, files: [], error: "", status: "saved", edit: this.savedEdit });
        }
    }
    readRemote() { return this.transport.read(); }
    persist() { if (!this.submitting) return this.flush(); return Promise.resolve(this.revision); }
    async beginSubmit() {
        if (this.submitting) return null;
        this.submitting = true;
        clearTimeout(this.timer);
        try {
            await this.flush();
            // Capture exactly the flushed version; edits during the write require another flush.
            while (this.savedEdit !== this.state.edit) await this.flush();
            return { ...this.state, revision: this.revision };
        } catch (error) { this.submitting = false; throw error; }
    }
    async accepted(snapshot: Snapshot & { revision: number }) {
        // A versioned empty row is the tombstone. An older save cannot resurrect it.
        try {
            const saved = await this.transport.write(emptyDraft(), snapshot.revision);
            this.revision = saved.revision;
            if (this.state.edit === snapshot.edit) {
                this.savedEdit = this.state.edit;
                this.emit({ draft: { ...emptyDraft(), responseMode: snapshot.draft.responseMode, revision: saved.revision }, files: [], status: "saved", error: "" });
            } else {
                this.emit({ draft: { ...this.state.draft, revision: saved.revision }, status: "unsaved" });
            }
        } catch (error) {
            this.emit({ status: "conflict", error: "訊息已排隊，但草稿清除未確認。請比較保存版本；不要再次傳送同一則。" });
            throw error;
        }
    }
    endSubmit() {
        this.submitting = false;
        if (!this.state.error && this.state.edit !== this.savedEdit) void this.flush().catch(() => undefined);
    }
}
