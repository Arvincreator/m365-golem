export const STOCKS_FEATURE_ENABLED_STORAGE_KEY = "golem-feature-stocks-enabled-v1";
export const CRYPTO_FEATURE_ENABLED_STORAGE_KEY = "golem-feature-crypto-enabled-v1";
export const SIDEBAR_NAV_HIDDEN_STORAGE_KEY = "golem-sidebar-nav-hidden-v1";

export const DASHBOARD_FEATURE_FLAGS_UPDATED_EVENT = "golem:dashboard-feature-flags-updated";
export const SIDEBAR_NAV_HIDDEN_UPDATED_EVENT = "golem:sidebar-nav-hidden-updated";

export function readFeatureEnabled(storageKey: string, fallback = true): boolean {
    if (typeof window === "undefined") return fallback;
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return fallback;
    return raw !== "0";
}

export function writeFeatureEnabled(storageKey: string, enabled: boolean) {
    if (typeof window === "undefined") return;
    localStorage.setItem(storageKey, enabled ? "1" : "0");
    window.dispatchEvent(new Event(DASHBOARD_FEATURE_FLAGS_UPDATED_EVENT));
}

export function readSidebarHiddenHrefSet(): Set<string> {
    if (typeof window === "undefined") return new Set();
    try {
        const raw = localStorage.getItem(SIDEBAR_NAV_HIDDEN_STORAGE_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((value): value is string => typeof value === "string"));
    } catch {
        return new Set();
    }
}

export function isDashboardRouteHidden(href: string): boolean {
    return readSidebarHiddenHrefSet().has(href);
}
