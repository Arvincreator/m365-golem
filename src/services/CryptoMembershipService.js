const fs = require('fs');
const path = require('path');

const FIREBASE_WEB_API_KEY = process.env.RPG_FIREBASE_API_KEY || '';
const FIREBASE_PROJECT_ID = process.env.RPG_FIREBASE_PROJECT_ID || 'serial-novel-generator';
const USAGE_FILE = path.resolve(process.cwd(), 'data', 'crypto-membership-usage.json');

const ENTITLEMENTS = {
    visitor: {
        tier: 'visitor',
        label: 'Visitor',
        watchlistLimit: 3,
        refreshIntervalSecMin: 60,
        aiInsightDailyQuota: 0,
        canUseAdvancedIndicators: false,
        canExportReport: false,
        historyRangeLimit: '1d',
    },
    general: {
        tier: 'general',
        label: 'General',
        watchlistLimit: 5,
        refreshIntervalSecMin: 30,
        aiInsightDailyQuota: 3,
        canUseAdvancedIndicators: false,
        canExportReport: false,
        historyRangeLimit: '1mo',
    },
    sponsor: {
        tier: 'sponsor',
        label: 'Sponsor',
        watchlistLimit: 100,
        refreshIntervalSecMin: 15,
        aiInsightDailyQuota: 120,
        canUseAdvancedIndicators: true,
        canExportReport: true,
        historyRangeLimit: '2y',
    },
};

const RANGE_ORDER = ['1d', '2d', '5d', '1mo', '3mo', '6mo', '1y', '2y'];

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function writeJson(filePath, value) {
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function sanitizeTier(rawTier) {
    const tier = String(rawTier || '').trim().toLowerCase();
    if (tier === 'visitor' || tier === 'general' || tier === 'sponsor') return tier;
    return 'visitor';
}

function extractFirestoreStringField(docFields, key) {
    if (!docFields || typeof docFields !== 'object') return '';
    const field = docFields[key];
    if (!field || typeof field !== 'object') return '';
    if (typeof field.stringValue === 'string') return field.stringValue;
    return '';
}

function parseCookies(cookieHeader) {
    if (!cookieHeader) return {};
    try {
        return Object.fromEntries(
            cookieHeader
                .split(';')
                .map((cookie) => cookie.trim().split('='))
                .filter((parts) => parts.length === 2)
        );
    } catch {
        return {};
    }
}

async function verifyFirebaseIdToken(idToken) {
    const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
    });
    if (!response.ok) throw new Error(`token_verify_failed_${response.status}`);
    const data = await response.json();
    const user = data && Array.isArray(data.users) ? data.users[0] : null;
    if (!user || !user.localId) throw new Error('token_verify_failed_no_user');
    return user;
}

async function fetchMembershipByUid(uid, idToken) {
    const docPath = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
    const response = await fetch(docPath, {
        headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!response.ok) {
        // Crypto policy: authenticated users without a profile doc are treated as General.
        if (response.status === 404) return 'general';
        throw new Error(`membership_fetch_failed_${response.status}`);
    }
    const data = await response.json();
    const tierRaw = extractFirestoreStringField(data.fields || {}, 'membershipTier');
    return sanitizeTier(tierRaw || 'general');
}

async function signInWithEmailPassword(email, password) {
    const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.idToken) {
        const code = String(payload?.error?.message || 'LOGIN_FAILED').toUpperCase();
        throw new Error(`firebase_login_failed:${code}`);
    }
    return payload;
}

async function registerWithEmailPassword(email, password) {
    const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.idToken) {
        const code = String(payload?.error?.message || 'REGISTER_FAILED').toUpperCase();
        throw new Error(`firebase_register_failed:${code}`);
    }
    return payload;
}

async function sendPasswordReset(email) {
    const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const code = String(payload?.error?.message || 'PASSWORD_RESET_FAILED').toUpperCase();
        throw new Error(`firebase_password_reset_failed:${code}`);
    }
    return payload;
}

async function refreshWithRefreshToken(refreshToken) {
    const endpoint = `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`;
    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', String(refreshToken || '').trim());
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.id_token) {
        const code = String(payload?.error?.message || payload?.error || 'REFRESH_FAILED').toUpperCase();
        throw new Error(`firebase_refresh_failed:${code}`);
    }
    return {
        idToken: String(payload.id_token || ''),
        refreshToken: String(payload.refresh_token || ''),
        uid: String(payload.user_id || ''),
    };
}

function getEntitlements(tier) {
    return ENTITLEMENTS[sanitizeTier(tier)] || ENTITLEMENTS.visitor;
}

function isRangeAllowed(range, entitlement) {
    const safeRange = String(range || '1d');
    const limit = String(entitlement?.historyRangeLimit || '1d');
    const rangeIndex = RANGE_ORDER.indexOf(safeRange);
    const limitIndex = RANGE_ORDER.indexOf(limit);
    if (rangeIndex === -1 || limitIndex === -1) return false;
    return rangeIndex <= limitIndex;
}

function getMemberTokenFromRequest(req) {
    const headerToken = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (headerToken) return headerToken;
    const cookies = parseCookies(req.headers.cookie);
    return String(cookies.crypto_member_token || '').trim();
}

function getUsageBucketDate() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function consumeAiQuota(uid, tier) {
    const entitlement = getEntitlements(tier);
    if (!uid) return { ok: false, remaining: 0, limit: entitlement.aiInsightDailyQuota };
    if (!Number.isFinite(entitlement.aiInsightDailyQuota) || entitlement.aiInsightDailyQuota <= 0) {
        return { ok: false, remaining: 0, limit: entitlement.aiInsightDailyQuota };
    }

    const dateKey = getUsageBucketDate();
    const usage = readJson(USAGE_FILE, {});
    const userUsage = usage[uid] && typeof usage[uid] === 'object' ? usage[uid] : {};
    const dayUsage = userUsage[dateKey] && typeof userUsage[dateKey] === 'object' ? userUsage[dateKey] : { aiInsightUsed: 0 };
    const used = Number(dayUsage.aiInsightUsed || 0);

    if (used >= entitlement.aiInsightDailyQuota) {
        return { ok: false, remaining: 0, limit: entitlement.aiInsightDailyQuota, used };
    }

    dayUsage.aiInsightUsed = used + 1;
    userUsage[dateKey] = dayUsage;
    usage[uid] = userUsage;
    writeJson(USAGE_FILE, usage);

    return {
        ok: true,
        remaining: Math.max(0, entitlement.aiInsightDailyQuota - dayUsage.aiInsightUsed),
        limit: entitlement.aiInsightDailyQuota,
        used: dayUsage.aiInsightUsed,
    };
}

function getAiQuotaStatus(uid, tier) {
    const entitlement = getEntitlements(tier);
    const limit = Number(entitlement.aiInsightDailyQuota || 0);
    if (!uid || limit <= 0) {
        return { limit, used: 0, remaining: Math.max(0, limit) };
    }
    const usage = readJson(USAGE_FILE, {});
    const dateKey = getUsageBucketDate();
    const used = Number(usage?.[uid]?.[dateKey]?.aiInsightUsed || 0);
    return { limit, used, remaining: Math.max(0, limit - used) };
}

async function resolveMembership(req) {
    const token = getMemberTokenFromRequest(req);
    if (!token) {
        const tier = 'visitor';
        return {
            token: '',
            uid: '',
            email: '',
            tier,
            entitlements: getEntitlements(tier),
            quota: getAiQuotaStatus('', tier),
            authenticated: false,
        };
    }

    const user = await verifyFirebaseIdToken(token);
    const uid = String(user.localId || '');
    const email = String(user.email || '');
    const tier = await fetchMembershipByUid(uid, token);

    return {
        token,
        uid,
        email,
        tier,
        entitlements: getEntitlements(tier),
        quota: getAiQuotaStatus(uid, tier),
        authenticated: true,
    };
}

module.exports = {
    ENTITLEMENTS,
    sanitizeTier,
    getEntitlements,
    isRangeAllowed,
    getMemberTokenFromRequest,
    resolveMembership,
    signInWithEmailPassword,
    registerWithEmailPassword,
    sendPasswordReset,
    refreshWithRefreshToken,
    verifyFirebaseIdToken,
    fetchMembershipByUid,
    consumeAiQuota,
    getAiQuotaStatus,
};
