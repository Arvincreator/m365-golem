import { apiPost } from "@/lib/api-client";

type SystemActionResponse = {
    success?: boolean;
};

export async function requestSystemReload(): Promise<boolean> {
    const data = await apiPost<SystemActionResponse>("/api/system/reload");
    return Boolean(data.success);
}

export async function requestSystemShutdown(): Promise<boolean> {
    const data = await apiPost<SystemActionResponse>("/api/system/shutdown");
    return Boolean(data.success);
}
