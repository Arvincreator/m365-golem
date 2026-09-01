export type ServerPingOptions = {
    timeoutMs?: number;
    method?: "GET" | "HEAD";
};

/**
 * Lightweight server-side health probe for internal HTTP dependencies.
 * Returns false on timeout/network errors/non-2xx responses.
 */
export async function pingEndpoint(url: string, options: ServerPingOptions = {}): Promise<boolean> {
    const timeoutMs = options.timeoutMs ?? 500;
    const method = options.method ?? "GET";

    try {
        const response = await fetch(url, {
            method,
            cache: "no-store",
            signal: AbortSignal.timeout(timeoutMs),
        });
        return response.ok;
    } catch {
        return false;
    }
}

