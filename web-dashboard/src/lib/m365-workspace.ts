export const ACTIVE_PROJECT_STORAGE_KEY = "m365_active_project_id";
export const ACTIVE_CONVERSATION_STORAGE_KEY = "m365_active_conversation_id";

export type M365WorkspaceStatus = {
    enabled: boolean;
    runnerEnabled: boolean;
    encryptionConfigured: boolean;
    activeDispatch: boolean;
};

export type M365Project = {
    id: string;
    name: string;
    description: string;
    instructions: string;
    workspaceMode: "managed" | "create" | "existing";
    workspacePath: string | null;
    status: "active" | "archived";
    retentionMode: string;
    contextVersion: number;
    createdAt: string;
    updatedAt: string;
};

export type M365ProjectWorkspace = {
    projectId: string;
    rootPath: string;
    agentsPath: string;
    agentsContent: string;
    agentsTruncated: boolean;
    memoryEntries: Array<{
        id: string;
        kind: "rule" | "context" | "decision" | "preference";
        importance: "core" | "normal";
        content: string;
        tags: string[];
        createdAt: string;
        updatedAt: string;
    }>;
    memoryCount: number;
    managedBy: "golem";
    updatedAt: string;
};

export type M365Conversation = {
    id: string;
    projectId: string;
    title: string;
    remoteConversationUrl: string;
    remoteConversationId: string;
    bindingState: "unbound" | "bound" | "reconcile_required" | "broken";
    status: "active" | "archived";
    projectContextVersion: number;
    lastMessageAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type M365Message = {
    id: string;
    conversationId: string;
    role: "user" | "assistant" | "system";
    source: "user" | "m365" | "system";
    content: string;
    requestId: string | null;
    runId: string | null;
    stepId: string | null;
    deliveryState: "local" | "dispatch_started" | "confirmed" | "response_confirmed" | "ambiguous" | "failed";
    createdAt: string;
};

export type M365RunStatus =
    | "DRAFT"
    | "WAITING_START_APPROVAL"
    | "QUEUED"
    | "RUNNING"
    | "WAITING_USER"
    | "WAITING_APPROVAL"
    | "PAUSED"
    | "RECONCILE_REQUIRED"
    | "BLOCKED"
    | "FAILED"
    | "CANCELED"
    | "COMPLETED";

export type M365Run = {
    id: string;
    conversationId: string;
    objective: string;
    constraints: string;
    verification: string;
    status: M365RunStatus;
    maxSteps: number;
    currentStep: number;
    errorCode: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    updatedAt: string;
};

export type M365RunStep = {
    id: string;
    runId: string;
    stepNumber: number;
    status: "queued" | "running" | "waiting" | "reconcile_required" | "failed" | "completed" | "canceled";
    prompt: string;
    summary: string;
    requestId: string;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type M365Approval = {
    id: string;
    runId: string;
    stepId: string | null;
    approvalType: string;
    request: string;
    decision: string;
    status: "pending" | "approved" | "denied" | "canceled";
    requestedAt: string;
    decidedAt: string | null;
};

export type M365AutonomousPlan = {
    schemaVersion: "golem_plan/1";
    planId: string;
    revision: number;
    goal: string;
    completionCriteria: string;
    status: "running" | "wait_user" | "wait_approval" | "complete" | "blocked";
    currentStepId: string | null;
    steps: Array<{
        id: string;
        title: string;
        status: "pending" | "in_progress" | "completed" | "blocked" | "skipped";
        doneWhen: string;
    }>;
    question: string;
    approvalRequest: string;
    completionSummary: string;
};

export type M365RunDetail = {
    run: M365Run;
    steps: M365RunStep[];
    events: Array<{
        id: number;
        runId: string;
        eventType: string;
        payload: Record<string, unknown>;
        createdAt: string;
    }>;
    approvals: M365Approval[];
    plan: M365AutonomousPlan | null;
    origin: "copilot" | "user" | string;
    checkpoint: {
        id: string;
        runId: string;
        stepId: string | null;
        sequence: number;
        state: Record<string, unknown>;
        createdAt: string;
    } | null;
};

export function formatLocalDate(value: string | null | undefined): string {
    if (!value) return "尚未開始";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-TW", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(date);
}

export function getBindingLabel(state: M365Conversation["bindingState"]): string {
    if (state === "bound") return "已連結 M365";
    if (state === "reconcile_required") return "需要人工核對";
    if (state === "broken") return "連結失效";
    return "首次傳送時建立";
}

export function getRunStatusLabel(status: M365RunStatus): string {
    const labels: Record<M365RunStatus, string> = {
        DRAFT: "草稿",
        WAITING_START_APPROVAL: "等待你確認開始",
        QUEUED: "已排入",
        RUNNING: "進行中",
        WAITING_USER: "等待你的補充",
        WAITING_APPROVAL: "等待你的核准",
        PAUSED: "已暫停",
        RECONCILE_REQUIRED: "需要人工核對",
        BLOCKED: "受阻",
        FAILED: "失敗",
        CANCELED: "已取消",
        COMPLETED: "已完成",
    };
    return labels[status];
}
