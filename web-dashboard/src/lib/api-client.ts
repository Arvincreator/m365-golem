export class ApiError extends Error {
    status: number;
    payload: unknown;

    constructor(message: string, status: number, payload: unknown) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.payload = payload;
    }
}

export type ApiRetryOptions = {
    profile?: ApiRetryProfile;
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: boolean;
    retryOnStatuses?: number[];
    logRetries?: boolean;
};

export type ApiRetryProfile = "none" | "read" | "write";

function tryParseJson(raw: string): unknown {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

function extractErrorMessage(payload: unknown, fallback: string): string {
    if (typeof payload === "string" && payload.trim()) return payload;
    if (!payload || typeof payload !== "object") return fallback;
    const obj = payload as Record<string, unknown>;
    const candidates = [obj.error, obj.message, obj.detail];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    return fallback;
}

const DEFAULT_RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];
const NO_RETRY_PROFILE = {
    retries: 0,
    baseDelayMs: 250,
    maxDelayMs: 2500,
    jitter: true,
    retryOnStatuses: DEFAULT_RETRY_STATUS,
};
const READ_RETRY_PROFILE = {
    retries: 2,
    baseDelayMs: 250,
    maxDelayMs: 2500,
    jitter: true,
    retryOnStatuses: DEFAULT_RETRY_STATUS,
};
const WRITE_RETRY_PROFILE = {
    retries: 1,
    baseDelayMs: 300,
    maxDelayMs: 2000,
    jitter: true,
    retryOnStatuses: [429, 500, 502, 503, 504],
};

type ResolvedRetryOptions = {
    profile: ApiRetryProfile;
    retries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: boolean;
    retryOnStatuses: number[];
    logRetries: boolean;
};

function shouldLogRetriesByDefault(): boolean {
    if (process.env.NEXT_PUBLIC_API_RETRY_LOG === "1") return true;
    return process.env.NODE_ENV !== "production";
}

function getProfileDefaults(profile: ApiRetryProfile) {
    if (profile === "read") return READ_RETRY_PROFILE;
    if (profile === "write") return WRITE_RETRY_PROFILE;
    return NO_RETRY_PROFILE;
}

function resolveRetryOptions(
    retry?: ApiRetryOptions,
    defaultProfile: ApiRetryProfile = "none"
): ResolvedRetryOptions {
    const profile = retry?.profile ?? defaultProfile;
    const defaults = getProfileDefaults(profile);
    return {
        profile,
        retries: retry?.retries ?? defaults.retries,
        baseDelayMs: retry?.baseDelayMs ?? defaults.baseDelayMs,
        maxDelayMs: retry?.maxDelayMs ?? defaults.maxDelayMs,
        jitter: retry?.jitter ?? defaults.jitter,
        retryOnStatuses: retry?.retryOnStatuses ?? defaults.retryOnStatuses,
        logRetries: retry?.logRetries ?? shouldLogRetriesByDefault(),
    };
}

function getBackoffDelayMs(attempt: number, options: ResolvedRetryOptions): number {
    const exp = Math.min(options.maxDelayMs, options.baseDelayMs * Math.pow(2, attempt));
    if (!options.jitter) return exp;
    const jitterFactor = 0.7 + Math.random() * 0.6;
    return Math.floor(exp * jitterFactor);
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function shouldRetry(error: unknown, options: ResolvedRetryOptions): boolean {
    if (isAbortError(error)) return false;
    if (error instanceof ApiError) {
        return options.retryOnStatuses.includes(error.status);
    }
    return true;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function apiFetch<T = unknown>(
    url: string,
    init?: RequestInit,
    retry?: ApiRetryOptions
): Promise<T> {
    const method = init?.method || "GET";
    const defaultProfile: ApiRetryProfile = method.toUpperCase() === "GET" ? "read" : "none";
    const options = resolveRetryOptions(retry, defaultProfile);

    let attempt = 0;
    while (true) {
        try {
            const response = await fetch(url, init);
            const raw = await response.text();
            const payload = tryParseJson(raw);

            if (!response.ok) {
                const fallback = `Request failed (${response.status})`;
                const message = extractErrorMessage(payload, fallback);
                throw new ApiError(message, response.status, payload);
            }

            return payload as T;
        } catch (error) {
            if (attempt >= options.retries || !shouldRetry(error, options)) {
                throw error;
            }
            const sleepMs = getBackoffDelayMs(attempt, options);
            if (options.logRetries) {
                const reason = error instanceof ApiError
                    ? `status=${error.status}`
                    : error instanceof Error
                        ? error.message
                        : String(error);
                const currentAttempt = attempt + 1;
                console.warn(
                    `[api-client] retry ${currentAttempt}/${options.retries} (${options.profile}) ${method} ${url} in ${sleepMs}ms (${reason})`
                );
            }
            attempt += 1;
            await delay(sleepMs);
        }
    }
}

export function apiGet<T = unknown>(url: string, init?: RequestInit, retry?: ApiRetryOptions): Promise<T> {
    return apiFetch<T>(url, init, resolveRetryOptions(retry, "read"));
}

export function apiPost<T = unknown>(
    url: string,
    body?: unknown,
    init?: RequestInit,
    retry?: ApiRetryOptions
): Promise<T> {
    const headers = new Headers(init?.headers || {});
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    return apiFetch<T>(url, {
        ...init,
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    }, retry);
}

export type ApiWriteMethod = "POST" | "PUT" | "DELETE" | "PATCH";

export type ApiWriteRequest = {
    method: ApiWriteMethod;
    body?: unknown;
    init?: RequestInit;
    retry?: ApiRetryOptions;
};

export function apiWrite<T = unknown>(
    url: string,
    request: ApiWriteRequest
): Promise<T> {
    const { method, body, init, retry } = request;
    const headers = new Headers(init?.headers || {});
    const hasBody = body !== undefined;
    if (hasBody && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }
    const retryConfig = retry?.profile ? retry : { ...retry, profile: "write" as const };

    return apiFetch<T>(url, {
        ...init,
        method,
        headers,
        body: hasBody ? JSON.stringify(body) : init?.body,
    }, resolveRetryOptions(retryConfig, "write"));
}

export function apiPostWrite<T = unknown>(
    url: string,
    body?: unknown,
    init?: RequestInit,
    retry?: ApiRetryOptions
): Promise<T> {
    return apiWrite<T>(url, {
        method: "POST",
        body,
        init,
        retry: { ...retry, profile: "write" },
    });
}

export function apiPut<T = unknown>(
    url: string,
    body?: unknown,
    init?: RequestInit,
    retry?: ApiRetryOptions
): Promise<T> {
    const headers = new Headers(init?.headers || {});
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    return apiFetch<T>(url, {
        ...init,
        method: "PUT",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    }, resolveRetryOptions(retry, "write"));
}

export function apiPutWrite<T = unknown>(
    url: string,
    body?: unknown,
    init?: RequestInit,
    retry?: ApiRetryOptions
): Promise<T> {
    return apiWrite<T>(url, {
        method: "PUT",
        body,
        init,
        retry: { ...retry, profile: "write" },
    });
}

export function apiDelete<T = unknown>(url: string, init?: RequestInit, retry?: ApiRetryOptions): Promise<T> {
    return apiFetch<T>(url, {
        ...init,
        method: "DELETE",
    }, resolveRetryOptions(retry, "write"));
}

export function apiDeleteWrite<T = unknown>(
    url: string,
    init?: RequestInit,
    retry?: ApiRetryOptions
): Promise<T> {
    return apiWrite<T>(url, {
        method: "DELETE",
        init,
        retry: { ...retry, profile: "write" },
    });
}
