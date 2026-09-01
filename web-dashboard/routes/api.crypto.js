const express = require('express');
const crypto = require('crypto');
const {
    saveCryptoSnapshot,
    readCryptoSnapshot,
    refreshCryptoSnapshot,
    fetchCryptoNews,
    buildCryptoNewsQuery,
} = require('../../src/services/CryptoDashboardSnapshot');
const { getDirectory } = require('../../src/services/StockSymbolDirectory');
const {
    resolveMembership,
    signInWithEmailPassword,
    registerWithEmailPassword,
    sendPasswordReset,
    refreshWithRefreshToken,
    fetchMembershipByUid,
    getEntitlements,
    isRangeAllowed,
    consumeAiQuota,
    getAiQuotaStatus,
} = require('../../src/services/CryptoMembershipService');
const {
    buildDecision,
    simulatePortfolio,
} = require('../../src/services/MarketDecisionEngine');

const CACHE_TTL_MS = 45 * 1000;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_SYMBOLS = 20;
const MOST_ACTIVE_LIMIT_MAX = 50;

const cache = new Map();

const DEFAULT_SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'BNB-USDT', 'XRP-USDT', 'DOGE-USDT'];

const CRYPTO_SYMBOL_RE = /^[A-Z0-9]{2,12}[-/](USD|USDT|USDC|BUSD|DAI|BTC|ETH)$/;
const QUOTE_SUFFIXES = ['USDT', 'USDC', 'BUSD', 'DAI', 'USD', 'BTC', 'ETH'];
const FIAT_STABLE_QUOTES = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'USD']);

function createHttpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function attachCacheMeta(value, meta) {
    if (Array.isArray(value)) {
        const nextValue = value.slice();
        Object.defineProperty(nextValue, '_cache', {
            value: meta,
            enumerable: false,
            configurable: true,
        });
        return nextValue;
    }
    if (value && typeof value === 'object') {
        return { ...value, _cache: meta };
    }
    return value;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function getCached(key, options = {}) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
        if (options.allowStale) {
            return attachCacheMeta(item.value, { isStale: true, cachedAt: item.cachedAt, expiresAt: item.expiresAt });
        }
        return null;
    }
    return attachCacheMeta(item.value, { isStale: false, cachedAt: item.cachedAt, expiresAt: item.expiresAt });
}

function setCached(key, value, ttlMs = CACHE_TTL_MS) {
    const cachedAt = new Date().toISOString();
    const expiresAt = Date.now() + ttlMs;
    cache.set(key, {
        value,
        cachedAt,
        expiresAt,
    });
    return attachCacheMeta(value, { isStale: false, cachedAt, expiresAt });
}

function toNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}

function toNullableNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
}

function toPositiveNullableNumber(value) {
    const numericValue = toNullableNumber(value);
    return numericValue && numericValue > 0 ? numericValue : null;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeSymbol(input) {
    const raw = String(input || '').trim().toUpperCase();
    if (!raw) return '';
    const cleaned = raw.replace(/\s+/g, '');
    if (CRYPTO_SYMBOL_RE.test(cleaned)) {
        const direct = cleaned.replace('/', '-');
        return direct.endsWith('-USD') ? direct.replace(/-USD$/, '-USDT') : direct;
    }
    const pair = cleaned.replace('/', '-');
    if (/^[A-Z0-9]{2,12}-[A-Z0-9]{2,8}$/.test(pair)) {
        return pair.endsWith('-USD') ? pair.replace(/-USD$/, '-USDT') : pair;
    }
    for (const quote of QUOTE_SUFFIXES) {
        if (cleaned.endsWith(quote) && cleaned.length > quote.length + 1) {
            const base = cleaned.slice(0, -quote.length);
            if (/^[A-Z0-9]{2,12}$/.test(base)) return `${base}-${quote}`;
        }
    }
    if (/^[A-Z0-9]{2,12}$/.test(cleaned)) return `${cleaned}-USDT`;
    return cleaned.replace(/[^A-Z0-9.^=-]/g, '').replace('/', '-').slice(0, 24);
}

function getDisplaySymbol(symbol) {
    return symbol.replace(/-(USD|USDT|USDC|BUSD|DAI|BTC|ETH)$/i, '');
}

function inferMarket(symbol) {
    if (/-USD$|\/USD$/i.test(symbol)) return 'crypto';
    return 'crypto';
}

function splitPair(symbol) {
    const safe = normalizeSymbol(symbol);
    const [base = '', quote = 'USDT'] = safe.split('-');
    return { base, quote };
}

function toYahooSymbol(symbol) {
    const { base, quote } = splitPair(symbol);
    if (!base) return '';
    if (FIAT_STABLE_QUOTES.has(quote)) return `${base}-USD`;
    return `${base}-${quote}`;
}

function quoteConversionSymbol(quote) {
    const q = String(quote || '').toUpperCase();
    if (q === 'USD') return null;
    if (FIAT_STABLE_QUOTES.has(q)) return `${q}-USD`;
    return null;
}

function toDerivativesSymbol(symbol) {
    const { base, quote } = splitPair(symbol);
    if (!base) return '';
    const normalizedQuote = FIAT_STABLE_QUOTES.has(String(quote || '').toUpperCase()) ? 'USDT' : String(quote || 'USDT').toUpperCase();
    return `${base}${normalizedQuote}`;
}

function mapTimeframeToBinancePeriod(timeframe) {
    const safe = String(timeframe || '15m').toLowerCase();
    if (safe === '5m') return '5m';
    if (safe === '15m') return '15m';
    if (safe === '1h') return '1h';
    if (safe === '1d') return '1d';
    return '1d';
}

function mapTimeframeToBybitPeriod(timeframe) {
    const safe = String(timeframe || '15m').toLowerCase();
    if (safe === '5m') return '5min';
    if (safe === '15m') return '15min';
    if (safe === '1h') return '1h';
    if (safe === '1d') return '1d';
    return '1d';
}

function mapTimeframeToOkxPeriod(timeframe) {
    const safe = String(timeframe || '15m').toLowerCase();
    if (safe === '5m') return '5m';
    if (safe === '15m') return '15m';
    if (safe === '1h') return '1H';
    if (safe === '1d') return '1D';
    return '1D';
}

async function fetchBinanceLongShort(symbol, timeframe) {
    const pair = toDerivativesSymbol(symbol);
    const period = mapTimeframeToBinancePeriod(timeframe);
    const cacheKey = `positioning:binance:${pair}:${period}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const url = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(pair)}&period=${encodeURIComponent(period)}&limit=80`;
    const payload = await fetchJson(url);
    const list = Array.isArray(payload) ? payload : [];
    const points = list
        .map((item) => {
            const timestamp = Number(item?.timestamp || 0);
            const ratio = Number(item?.longShortRatio || 0);
            const longAccount = Number(item?.longAccount || 0);
            const shortAccount = Number(item?.shortAccount || 0);
            if (!Number.isFinite(timestamp) || !Number.isFinite(ratio) || timestamp <= 0) return null;
            return {
                time: new Date(timestamp).toISOString(),
                value: ratio,
                longRatio: Number.isFinite(longAccount) ? longAccount : null,
                shortRatio: Number.isFinite(shortAccount) ? shortAccount : null,
            };
        })
        .filter(Boolean);
    return setCached(cacheKey, {
        source: 'binance',
        metric: 'long_short_ratio',
        pair,
        points,
    }, 60 * 1000);
}

async function fetchBybitLongShort(symbol, timeframe) {
    const pair = toDerivativesSymbol(symbol);
    const period = mapTimeframeToBybitPeriod(timeframe);
    const cacheKey = `positioning:bybit:${pair}:${period}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const url = `https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${encodeURIComponent(pair)}&period=${encodeURIComponent(period)}&limit=80`;
    const payload = await fetchJson(url);
    const list = Array.isArray(payload?.result?.list) ? payload.result.list : [];
    const points = list
        .map((item) => {
            const timestamp = Number(item?.timestamp || 0);
            const buyRatio = Number(item?.buyRatio || item?.buy_ratio || 0);
            const sellRatio = Number(item?.sellRatio || item?.sell_ratio || 0);
            const ratio = sellRatio > 0 ? buyRatio / sellRatio : (buyRatio > 0 ? buyRatio : 0);
            if (!Number.isFinite(timestamp) || !Number.isFinite(ratio) || timestamp <= 0) return null;
            return {
                time: new Date(timestamp).toISOString(),
                value: ratio,
                longRatio: Number.isFinite(buyRatio) ? buyRatio : null,
                shortRatio: Number.isFinite(sellRatio) ? sellRatio : null,
            };
        })
        .filter(Boolean)
        .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    return setCached(cacheKey, {
        source: 'bybit',
        metric: 'long_short_ratio',
        pair,
        points,
    }, 60 * 1000);
}

async function fetchOkxLongShort(symbol, timeframe) {
    const { base } = splitPair(symbol);
    const ccy = String(base || '').toUpperCase();
    if (!ccy) throw createHttpError(400, 'Missing base symbol');
    const period = mapTimeframeToOkxPeriod(timeframe);
    const cacheKey = `positioning:okx:${ccy}:${period}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const urls = [
        `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract?ccy=${encodeURIComponent(ccy)}&period=${encodeURIComponent(period)}`,
        `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${encodeURIComponent(ccy)}&period=${encodeURIComponent(period)}`,
    ];
    let list = [];
    let lastError = null;
    for (const url of urls) {
        try {
            const payload = await fetchJson(url);
            const dataList = Array.isArray(payload?.data) ? payload.data : [];
            if (dataList.length) {
                list = dataList;
                break;
            }
        } catch (error) {
            lastError = error;
        }
    }
    if (!list.length && lastError) {
        // OKX may return 400 for unsupported ccy/period combinations.
        // Return empty data instead of failing the entire card.
        const statusCode = Number(lastError?.statusCode || 0);
        if (statusCode && statusCode !== 400) throw lastError;
    }
    const points = list
        .map((item) => {
            const timestamp = Number(item?.ts || item?.timestamp || 0);
            const ratio = Number(item?.ratio || item?.longShortRatio || item?.long_short_ratio || 0);
            const longRatio = Number(item?.longRatio || item?.long_ratio || 0);
            const shortRatio = Number(item?.shortRatio || item?.short_ratio || 0);
            if (!Number.isFinite(timestamp) || !Number.isFinite(ratio) || timestamp <= 0) return null;
            return {
                time: new Date(timestamp).toISOString(),
                value: ratio,
                longRatio: Number.isFinite(longRatio) && longRatio > 0 ? longRatio : null,
                shortRatio: Number.isFinite(shortRatio) && shortRatio > 0 ? shortRatio : null,
            };
        })
        .filter(Boolean)
        .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    return setCached(cacheKey, {
        source: 'okx',
        metric: 'long_short_ratio',
        pair: ccy,
        points,
    }, 60 * 1000);
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 GolemDashboard/1.0',
        },
    });
    const text = await response.text();
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch (error) {
        throw createHttpError(502, `Invalid upstream JSON: ${error.message}`);
    }
    if (!response.ok) {
        const message = payload?.chart?.error?.description || payload?.finance?.error?.description || `Upstream request failed (${response.status})`;
        throw createHttpError(response.status === 404 ? 404 : 502, message);
    }
    return payload;
}

function getQuoteName(symbol, meta) {
    const quoteType = String(meta?.quoteType || meta?.instrumentType || '').toUpperCase();
    const metaName = meta.longName || meta.shortName;
    if (metaName) return metaName;
    // Crypto symbols like BCH can collide with stock tickers in symbol directories.
    // For crypto route, avoid directory override when upstream marks it as crypto/currency.
    if (quoteType.includes('CRYPTO') || quoteType.includes('CURRENCY')) {
        return getDisplaySymbol(symbol);
    }
    const directory = getDirectory();
    const directoryItem = Array.isArray(directory?.items)
        ? directory.items.find((item) => item.yahooSymbol === symbol || item.symbol === getDisplaySymbol(symbol))
        : null;
    return directoryItem?.name || getDisplaySymbol(symbol);
}

function normalizeQuote(symbol, chartResult) {
    const meta = chartResult?.meta || {};
    const timestamps = Array.isArray(chartResult?.timestamp) ? chartResult.timestamp : [];
    const quoteData = chartResult?.indicators?.quote?.[0] || {};
    const closes = Array.isArray(quoteData.close) ? quoteData.close.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
    const volumes = Array.isArray(quoteData.volume) ? quoteData.volume.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
    const price = toNumber(meta.regularMarketPrice, closes[closes.length - 1] || meta.previousClose || 0);
    const previousClose = toNumber(meta.chartPreviousClose ?? meta.previousClose, price);
    const change = price - previousClose;
    const changePercent = previousClose ? (change / previousClose) * 100 : 0;
    const dayHigh = toPositiveNullableNumber(meta.regularMarketDayHigh);
    const dayLow = toPositiveNullableNumber(meta.regularMarketDayLow);
    const fiftyTwoWeekHigh = toPositiveNullableNumber(meta.fiftyTwoWeekHigh);
    const fiftyTwoWeekLow = toPositiveNullableNumber(meta.fiftyTwoWeekLow);
    const volume = toNumber(meta.regularMarketVolume, volumes[volumes.length - 1] || 0);
    const quoteType = String(meta?.quoteType || meta?.instrumentType || '').toUpperCase();
    const directory = getDirectory();
    const directoryItem = Array.isArray(directory?.items)
        ? directory.items.find((item) => item.yahooSymbol === symbol || item.symbol === getDisplaySymbol(symbol))
        : null;
    return {
        symbol: getDisplaySymbol(symbol),
        yahooSymbol: symbol,
        name: getQuoteName(symbol, meta),
        market: inferMarket(symbol),
        currency: meta.currency || 'USD',
        exchangeName: meta.exchangeName || '',
        exchangeTimezoneName: meta.exchangeTimezoneName || '',
        price,
        previousClose,
        open: toPositiveNullableNumber(meta.regularMarketOpen),
        dayHigh,
        dayLow,
        fiftyTwoWeekHigh,
        fiftyTwoWeekLow,
        change,
        changePercent,
        volume,
        turnover: price * volume,
        marketCap: toPositiveNullableNumber(meta.marketCap),
        sector: (quoteType.includes('CRYPTO') || quoteType.includes('CURRENCY')) ? 'Crypto' : (directoryItem?.sector || 'Crypto'),
        dataSource: 'Yahoo Finance',
        lastUpdatedAt: meta.regularMarketTime
            ? new Date(Number(meta.regularMarketTime) * 1000).toISOString()
            : new Date().toISOString(),
        hasIntradayData: timestamps.length > 0,
        dataQuality: chartResult?._cache?.isStale ? 'stale-cache' : 'live',
    };
}

function calculateSma(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    const slice = values.slice(-period);
    const total = slice.reduce((sum, value) => sum + value, 0);
    return total / period;
}

function calculateRsi(values, period = 14) {
    if (!Array.isArray(values) || values.length <= period) return null;
    const slice = values.slice(-(period + 1));
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < slice.length; i += 1) {
        const diff = slice[i] - slice[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
    }
    const averageGain = gains / period;
    const averageLoss = losses / period;
    if (averageLoss === 0) return 100;
    const rs = averageGain / averageLoss;
    return 100 - (100 / (1 + rs));
}

function calculateEmaSeries(values, period) {
    if (!Array.isArray(values) || values.length === 0) return [];
    const multiplier = 2 / (period + 1);
    const result = [];
    let previous = values[0];
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (index === 0) {
            previous = value;
        } else {
            previous = (value - previous) * multiplier + previous;
        }
        result.push(previous);
    }
    return result;
}

function calculateMacd(values) {
    if (!Array.isArray(values) || values.length < 35) {
        return { macd: null, signal: null, histogram: null };
    }
    const ema12 = calculateEmaSeries(values, 12);
    const ema26 = calculateEmaSeries(values, 26);
    const macdSeries = values.map((_, index) => ema12[index] - ema26[index]);
    const signalSeries = calculateEmaSeries(macdSeries, 9);
    const macd = macdSeries[macdSeries.length - 1];
    const signal = signalSeries[signalSeries.length - 1];
    return {
        macd,
        signal,
        histogram: macd - signal,
    };
}

function calculateStochastic(points, period = 9) {
    if (!Array.isArray(points) || points.length < period) {
        return { k: null, d: null };
    }
    const kSeries = [];
    for (let index = period - 1; index < points.length; index += 1) {
        const slice = points.slice(index - period + 1, index + 1);
        const high = Math.max(...slice.map((point) => toNumber(point.high, point.close)));
        const low = Math.min(...slice.map((point) => toNumber(point.low, point.close)));
        const close = toNumber(points[index].close, 0);
        const rawK = high === low ? 50 : ((close - low) / (high - low)) * 100;
        kSeries.push(clamp(rawK, 0, 100));
    }
    const k = kSeries[kSeries.length - 1] ?? null;
    const d = calculateSma(kSeries, 3);
    return { k, d };
}

function calculateVolatility(values) {
    if (!Array.isArray(values) || values.length < 3) return null;
    const returns = [];
    for (let i = 1; i < values.length; i += 1) {
        if (!values[i - 1]) continue;
        returns.push((values[i] - values[i - 1]) / values[i - 1]);
    }
    if (!returns.length) return null;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / returns.length;
    return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function calculateStdDev(values) {
    if (!Array.isArray(values) || values.length < 2) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
}

function calculateAtr(points, period = 14) {
    if (!Array.isArray(points) || points.length <= period) return null;
    const trs = [];
    for (let i = 1; i < points.length; i += 1) {
        const high = toNumber(points[i].high, points[i].close);
        const low = toNumber(points[i].low, points[i].close);
        const prevClose = toNumber(points[i - 1].close, points[i - 1].close);
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    return calculateSma(trs, period);
}

function calculateBollinger(values, period = 20, multiplier = 2) {
    if (!Array.isArray(values) || values.length < period) {
        return { middle: null, upper: null, lower: null, widthPercent: null };
    }
    const slice = values.slice(-period);
    const middle = calculateSma(slice, period);
    const stdDev = calculateStdDev(slice);
    if (middle === null || stdDev === null) {
        return { middle: null, upper: null, lower: null, widthPercent: null };
    }
    const upper = middle + multiplier * stdDev;
    const lower = middle - multiplier * stdDev;
    const widthPercent = middle ? ((upper - lower) / middle) * 100 : null;
    return { middle, upper, lower, widthPercent };
}

function calculateDonchian(points, period = 20) {
    if (!Array.isArray(points) || points.length < period) {
        return { upper: null, lower: null, middle: null };
    }
    const slice = points.slice(-period);
    const upper = Math.max(...slice.map((point) => toNumber(point.high, point.close)));
    const lower = Math.min(...slice.map((point) => toNumber(point.low, point.close)));
    return { upper, lower, middle: (upper + lower) / 2 };
}

function calculateObv(points) {
    if (!Array.isArray(points) || points.length < 2) return null;
    let obv = 0;
    for (let i = 1; i < points.length; i += 1) {
        const currentClose = toNumber(points[i].close, 0);
        const prevClose = toNumber(points[i - 1].close, 0);
        const volume = toNumber(points[i].volume, 0);
        if (currentClose > prevClose) obv += volume;
        else if (currentClose < prevClose) obv -= volume;
    }
    return obv;
}

function calculateMfi(points, period = 14) {
    if (!Array.isArray(points) || points.length <= period) return null;
    const positiveFlows = [];
    const negativeFlows = [];
    for (let i = 1; i < points.length; i += 1) {
        const typicalPrice = (toNumber(points[i].high, 0) + toNumber(points[i].low, 0) + toNumber(points[i].close, 0)) / 3;
        const prevTypicalPrice = (toNumber(points[i - 1].high, 0) + toNumber(points[i - 1].low, 0) + toNumber(points[i - 1].close, 0)) / 3;
        const rawMoneyFlow = typicalPrice * toNumber(points[i].volume, 0);
        if (typicalPrice > prevTypicalPrice) {
            positiveFlows.push(rawMoneyFlow);
            negativeFlows.push(0);
        } else if (typicalPrice < prevTypicalPrice) {
            positiveFlows.push(0);
            negativeFlows.push(rawMoneyFlow);
        } else {
            positiveFlows.push(0);
            negativeFlows.push(0);
        }
    }
    if (positiveFlows.length < period) return null;
    const positive = positiveFlows.slice(-period).reduce((sum, value) => sum + value, 0);
    const negative = negativeFlows.slice(-period).reduce((sum, value) => sum + value, 0);
    if (negative === 0) return 100;
    const ratio = positive / negative;
    return 100 - (100 / (1 + ratio));
}

function calculateVolumeZScore(points, period = 20) {
    if (!Array.isArray(points) || points.length < period + 1) return null;
    const series = points.map((point) => toNumber(point.volume, 0));
    const history = series.slice(-(period + 1), -1);
    const latest = series[series.length - 1];
    const mean = calculateSma(history, history.length);
    const stdDev = calculateStdDev(history);
    if (mean === null || stdDev === null || stdDev === 0) return null;
    return (latest - mean) / stdDev;
}

function calculateMaxDrawdown(values) {
    if (!Array.isArray(values) || values.length < 2) return null;
    let peak = values[0];
    let maxDrawdown = 0;
    for (const value of values) {
        if (value > peak) peak = value;
        if (peak > 0) {
            maxDrawdown = Math.min(maxDrawdown, ((value - peak) / peak) * 100);
        }
    }
    return maxDrawdown;
}

function normalizeHistory(symbol, chartResult) {
    const meta = chartResult?.meta || {};
    const timestamps = Array.isArray(chartResult?.timestamp) ? chartResult.timestamp : [];
    const quoteData = chartResult?.indicators?.quote?.[0] || {};
    const closesRaw = Array.isArray(quoteData.close) ? quoteData.close : [];
    const opensRaw = Array.isArray(quoteData.open) ? quoteData.open : [];
    const highsRaw = Array.isArray(quoteData.high) ? quoteData.high : [];
    const lowsRaw = Array.isArray(quoteData.low) ? quoteData.low : [];
    const volumesRaw = Array.isArray(quoteData.volume) ? quoteData.volume : [];
    const points = [];

    for (let index = 0; index < timestamps.length; index += 1) {
        const isLastPoint = index === timestamps.length - 1;
        const fallbackClose = isLastPoint ? toPositiveNullableNumber(meta.regularMarketPrice) : null;
        const close = toPositiveNullableNumber(closesRaw[index]) ?? fallbackClose;
        if (close === null) continue;
        const open = toPositiveNullableNumber(opensRaw[index]) ?? close;
        const high = toPositiveNullableNumber(highsRaw[index]) ?? Math.max(open, close);
        const low = toPositiveNullableNumber(lowsRaw[index]) ?? Math.min(open, close);
        if (high < Math.max(open, close) || low > Math.min(open, close)) continue;
        points.push({
            time: new Date(Number(timestamps[index]) * 1000).toISOString(),
            price: close,
            close,
            open,
            high,
            low,
            volume: toNumber(volumesRaw[index], 0),
        });
    }

    const closeValues = points.map((point) => point.close);
    const last = closeValues[closeValues.length - 1] || 0;
    const sma20 = calculateSma(closeValues, 20);
    const ema20Series = calculateEmaSeries(closeValues, 20);
    const ema50Series = calculateEmaSeries(closeValues, 50);
    const ema200Series = calculateEmaSeries(closeValues, 200);
    const ema20 = ema20Series.length ? ema20Series[ema20Series.length - 1] : null;
    const ema50 = ema50Series.length ? ema50Series[ema50Series.length - 1] : null;
    const ema200 = ema200Series.length ? ema200Series[ema200Series.length - 1] : null;
    const macd = calculateMacd(closeValues);
    const stochastic = calculateStochastic(points, 9);
    const latestVolume = points[points.length - 1]?.volume || 0;
    const avgVolume20 = calculateSma(points.map((point) => point.volume || 0), 20);
    const atr14 = calculateAtr(points, 14);
    const bollinger = calculateBollinger(closeValues, 20, 2);
    const donchian = calculateDonchian(points, 20);
    const obv = calculateObv(points);
    const mfi14 = calculateMfi(points, 14);
    const volumeZScore20 = calculateVolumeZScore(points, 20);
    const distanceTo52wHighPercent = toNumber(meta.fiftyTwoWeekHigh, 0) > 0 ? ((last - toNumber(meta.fiftyTwoWeekHigh, last)) / toNumber(meta.fiftyTwoWeekHigh, last)) * 100 : null;
    const distanceTo52wLowPercent = toNumber(meta.fiftyTwoWeekLow, 0) > 0 ? ((last - toNumber(meta.fiftyTwoWeekLow, last)) / toNumber(meta.fiftyTwoWeekLow, last)) * 100 : null;

    return {
        symbol: getDisplaySymbol(symbol),
        yahooSymbol: symbol,
        points,
        dataQuality: chartResult?._cache?.isStale ? 'stale-cache' : 'live',
        indicators: {
            sma20,
            ema20,
            ema50,
            ema200,
            rsi14: calculateRsi(closeValues, 14),
            macd: macd.macd,
            macdSignal: macd.signal,
            macdHistogram: macd.histogram,
            stochasticK: stochastic.k,
            stochasticD: stochastic.d,
            mfi14,
            atr14,
            bollingerMiddle: bollinger.middle,
            bollingerUpper: bollinger.upper,
            bollingerLower: bollinger.lower,
            bollingerWidthPercent: bollinger.widthPercent,
            donchianUpper20: donchian.upper,
            donchianLower20: donchian.lower,
            donchianMiddle20: donchian.middle,
            volatility: calculateVolatility(closeValues),
            maxDrawdown: calculateMaxDrawdown(closeValues),
            avgVolume20,
            volumeRatio: avgVolume20 ? latestVolume / avgVolume20 : null,
            volumeZScore20,
            obv,
            distanceToSma20Percent: sma20 && last ? ((last - sma20) / sma20) * 100 : null,
            distanceTo52wHighPercent,
            distanceTo52wLowPercent,
        },
    };
}

async function fetchChart(symbol, range = '1d', interval = '5m') {
    const safeSymbol = normalizeSymbol(symbol);
    if (!safeSymbol) throw createHttpError(400, 'Missing symbol');
    const cacheKey = `chart:${safeSymbol}:${range}:${interval}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const upstreamSymbol = toYahooSymbol(safeSymbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(upstreamSymbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false&events=div%2Csplits`;
    try {
        const payload = await fetchJson(url);
        const result = payload?.chart?.result?.[0];
        if (!result) {
            const message = payload?.chart?.error?.description || `No chart data for ${upstreamSymbol}`;
            throw createHttpError(404, message);
        }
        return setCached(cacheKey, { ...result, _requestedSymbol: safeSymbol, _upstreamSymbol: upstreamSymbol });
    } catch (error) {
        const stale = getCached(cacheKey, { allowStale: true });
        if (stale) return stale;
        throw error;
    }
}

async function fetchQuote(symbol) {
    const result = await fetchChart(symbol, '1d', '5m');
    const requestedSymbol = normalizeSymbol(symbol);
    const requestedPair = splitPair(requestedSymbol);
    let quote = normalizeQuote(requestedSymbol, result);
    if (requestedPair.quote && requestedPair.quote !== 'USD') {
        const conversion = quoteConversionSymbol(requestedPair.quote);
        if (conversion) {
            try {
                const conversionChart = await fetchChart(conversion, '1d', '5m');
                const conversionQuote = normalizeQuote(conversion, conversionChart);
                const rate = Number(conversionQuote.price) || 1;
                quote = {
                    ...quote,
                    yahooSymbol: requestedSymbol,
                    symbol: requestedPair.base,
                    currency: requestedPair.quote,
                    price: quote.price / rate,
                    previousClose: quote.previousClose / rate,
                    open: quote.open ? quote.open / rate : quote.open,
                    dayHigh: quote.dayHigh ? quote.dayHigh / rate : quote.dayHigh,
                    dayLow: quote.dayLow ? quote.dayLow / rate : quote.dayLow,
                    fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ? quote.fiftyTwoWeekHigh / rate : quote.fiftyTwoWeekHigh,
                    fiftyTwoWeekLow: quote.fiftyTwoWeekLow ? quote.fiftyTwoWeekLow / rate : quote.fiftyTwoWeekLow,
                    change: (quote.price / rate) - (quote.previousClose / rate),
                    changePercent: quote.previousClose ? (((quote.price / rate) - (quote.previousClose / rate)) / (quote.previousClose / rate)) * 100 : 0,
                    turnover: (quote.price / rate) * quote.volume,
                    dataSource: 'Yahoo Finance (+ stablecoin conversion)',
                };
            } catch (_) {
                quote = { ...quote, yahooSymbol: requestedSymbol, symbol: requestedPair.base, currency: requestedPair.quote };
            }
        }
    }
    return quote;
}

async function fetchCryptoMostActive(limit = 50) {
    const safeLimit = clamp(toNumber(limit, 50), 1, MOST_ACTIVE_LIMIT_MAX);
    const cacheKey = `most-active:crypto:${safeLimit}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${safeLimit}&scrIds=all_cryptocurrencies_us`;
    const payload = await fetchJson(url);
    const quotes = asArray(payload?.finance?.result?.[0]?.quotes);
    const normalized = quotes.map((quote) => {
        const yahooSymbol = String(quote?.symbol || '').toUpperCase();
        const safeSymbol = normalizeSymbol(yahooSymbol);
        const { base, quote: quoteCurrency } = splitPair(safeSymbol);
        const price = toNullableNumber(quote?.regularMarketPrice);
        const previousClose = toNullableNumber(quote?.regularMarketPreviousClose);
        const change = toNullableNumber(quote?.regularMarketChange);
        const changePercent = toNullableNumber(quote?.regularMarketChangePercent);
        const volume = toNumber(quote?.regularMarketVolume, 0);
        return {
            symbol: base || getDisplaySymbol(safeSymbol),
            yahooSymbol: safeSymbol,
            name: String(quote?.shortName || quote?.longName || base || safeSymbol),
            volume,
            price,
            change,
            changePercent,
            previousClose,
            market: 'crypto',
            currency: String(quoteCurrency || quote?.currency || 'USDT').toUpperCase(),
            source: 'Yahoo Finance Screener',
        };
    }).filter((item) => item.yahooSymbol && item.volume > 0);

    const sorted = normalized.sort((a, b) => b.volume - a.volume).slice(0, safeLimit);
    return setCached(cacheKey, sorted, CACHE_TTL_MS);
}

async function searchYahoo(query) {
    const safeQuery = String(query || '').trim();
    if (!safeQuery) return [];
    const cacheKey = `search:${safeQuery.toLowerCase()}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(safeQuery)}&quotesCount=12&newsCount=0`;
    const payload = await fetchJson(url);
    const quotes = Array.isArray(payload?.quotes) ? payload.quotes : [];
    const results = quotes
        .filter((quote) => quote?.symbol && ['CRYPTOCURRENCY', 'CURRENCY'].includes(String(quote.quoteType || '').toUpperCase()))
        .slice(0, 12)
        .map((quote) => ({
            symbol: getDisplaySymbol(String(quote.symbol).toUpperCase()),
            yahooSymbol: String(quote.symbol).toUpperCase(),
            name: quote.longname || quote.shortname || quote.symbol,
            market: inferMarket(String(quote.symbol).toUpperCase()),
            exchange: quote.exchange || quote.exchDisp || '',
            type: quote.quoteType || '',
            dataSource: 'Yahoo Finance',
        }));

    return setCached(cacheKey, results, SEARCH_CACHE_TTL_MS);
}

module.exports = function registerCryptoRoutes() {
    const router = express.Router();
    const secureCookie = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

    function getCookieValue(req, key) {
        const cookieHeader = String(req?.headers?.cookie || '');
        if (!cookieHeader) return '';
        const parts = cookieHeader.split(';');
        for (const partRaw of parts) {
            const part = partRaw.trim();
            const index = part.indexOf('=');
            if (index <= 0) continue;
            const name = part.slice(0, index).trim();
            if (name !== key) continue;
            return decodeURIComponent(part.slice(index + 1).trim());
        }
        return '';
    }

    async function attachMembership(req, res, next) {
        try {
            req.cryptoMembership = await resolveMembership(req);
            return next();
        } catch (error) {
            const refreshToken = getCookieValue(req, 'crypto_member_refresh_token');
            if (refreshToken) {
                try {
                    const refreshed = await refreshWithRefreshToken(refreshToken);
                    const uid = String(refreshed.uid || '');
                    const tier = await fetchMembershipByUid(uid, refreshed.idToken);
                    const entitlements = getEntitlements(tier);

                    res.cookie('crypto_member_token', refreshed.idToken, {
                        httpOnly: true,
                        sameSite: 'lax',
                        secure: secureCookie,
                        maxAge: 55 * 60 * 1000,
                        path: '/',
                    });
                    res.cookie('crypto_member_refresh_token', refreshed.refreshToken || refreshToken, {
                        httpOnly: true,
                        sameSite: 'lax',
                        secure: secureCookie,
                        maxAge: 30 * 24 * 60 * 60 * 1000,
                        path: '/',
                    });

                    req.cryptoMembership = {
                        token: refreshed.idToken,
                        uid,
                        email: '',
                        tier,
                        entitlements,
                        quota: getAiQuotaStatus(uid, tier),
                        authenticated: true,
                    };
                    return next();
                } catch (_) {
                    res.clearCookie('crypto_member_token', { path: '/' });
                    res.clearCookie('crypto_member_refresh_token', { path: '/' });
                }
            }
            return res.status(401).json({ error: error.message || 'membership_resolve_failed' });
        }
    }

    function requireGeneralTier(req, res, next) {
        const tier = req.cryptoMembership?.tier || 'visitor';
        if (tier === 'general' || tier === 'sponsor') return next();
        return res.status(403).json({
            error: 'general_membership_required',
            tier,
            message: '此功能需要一般會員（General）以上。',
        });
    }

    function requireSponsorTier(req, res, next) {
        const tier = req.cryptoMembership?.tier || 'visitor';
        if (tier === 'sponsor') return next();
        return res.status(403).json({
            error: 'sponsor_membership_required',
            tier,
            message: '此功能僅限贊助會員（Sponsor）。',
        });
    }

    router.post('/api/crypto/membership/login', async (req, res) => {
        try {
            const email = String(req.body?.email || '').trim().toLowerCase();
            const password = String(req.body?.password || '').trim();
            if (!email || !password) {
                return res.status(400).json({ error: 'email_and_password_required' });
            }

            const signedIn = await signInWithEmailPassword(email, password);
            const idToken = String(signedIn.idToken || '');
            const uid = String(signedIn.localId || '');
            const tier = await fetchMembershipByUid(uid, idToken);
            const entitlements = getEntitlements(tier);

            res.cookie('crypto_member_token', idToken, {
                httpOnly: true,
                sameSite: 'lax',
                secure: secureCookie,
                maxAge: 55 * 60 * 1000,
                path: '/',
            });
            if (signedIn.refreshToken) {
                res.cookie('crypto_member_refresh_token', String(signedIn.refreshToken), {
                    httpOnly: true,
                    sameSite: 'lax',
                    secure: secureCookie,
                    maxAge: 30 * 24 * 60 * 60 * 1000,
                    path: '/',
                });
            }

            return res.json({
                success: true,
                uid,
                email: String(signedIn.email || email),
                tier,
                entitlements,
            });
        } catch (error) {
            return res.status(401).json({ error: error.message || 'crypto_membership_login_failed' });
        }
    });

    router.post('/api/crypto/membership/register', async (req, res) => {
        try {
            const email = String(req.body?.email || '').trim().toLowerCase();
            const password = String(req.body?.password || '').trim();
            if (!email || !password) {
                return res.status(400).json({ error: 'email_and_password_required' });
            }
            if (password.length < 6) {
                return res.status(400).json({ error: 'password_too_short' });
            }

            const created = await registerWithEmailPassword(email, password);
            const idToken = String(created.idToken || '');
            const uid = String(created.localId || '');
            const refreshToken = String(created.refreshToken || '');

            // Best-effort: initialize profile as General tier for registered users.
            try {
                const docPath = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(process.env.RPG_FIREBASE_PROJECT_ID || 'serial-novel-generator')}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
                await fetch(docPath, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${idToken}`,
                    },
                    body: JSON.stringify({
                        fields: {
                            membershipTier: { stringValue: 'general' },
                            email: { stringValue: String(created.email || email) },
                            createdAt: { stringValue: new Date().toISOString() },
                        },
                    }),
                });
            } catch (_) { }

            const tier = await fetchMembershipByUid(uid, idToken).catch(() => 'general');
            const entitlements = getEntitlements(tier);

            res.cookie('crypto_member_token', idToken, {
                httpOnly: true,
                sameSite: 'lax',
                secure: secureCookie,
                maxAge: 55 * 60 * 1000,
                path: '/',
            });
            if (refreshToken) {
                res.cookie('crypto_member_refresh_token', refreshToken, {
                    httpOnly: true,
                    sameSite: 'lax',
                    secure: secureCookie,
                    maxAge: 30 * 24 * 60 * 60 * 1000,
                    path: '/',
                });
            }

            return res.json({
                success: true,
                uid,
                email: String(created.email || email),
                tier,
                entitlements,
            });
        } catch (error) {
            return res.status(400).json({ error: error.message || 'crypto_membership_register_failed' });
        }
    });

    router.post('/api/crypto/membership/logout', (req, res) => {
        res.clearCookie('crypto_member_token', { path: '/' });
        res.clearCookie('crypto_member_refresh_token', { path: '/' });
        return res.json({ success: true });
    });

    router.post('/api/crypto/membership/forgot-password', async (req, res) => {
        try {
            const email = String(req.body?.email || '').trim().toLowerCase();
            if (!email) {
                return res.status(400).json({ error: 'email_required' });
            }
            await sendPasswordReset(email);
            return res.json({ success: true });
        } catch (error) {
            return res.status(400).json({ error: error.message || 'crypto_membership_forgot_password_failed' });
        }
    });

    router.get('/api/crypto/membership/status', attachMembership, (req, res) => {
        return res.json({
            success: true,
            membership: req.cryptoMembership,
        });
    });

    router.get('/api/crypto/quotes', attachMembership, async (req, res) => {
        try {
            const entitlements = req.cryptoMembership?.entitlements || getEntitlements('visitor');
            const symbolsRaw = String(req.query.symbols || DEFAULT_SYMBOLS.join(','));
            const symbols = symbolsRaw
                .split(',')
                .map(normalizeSymbol)
                .filter(Boolean)
                .slice(0, Math.min(MAX_SYMBOLS, Number(entitlements.watchlistLimit || 3)));
            if (!symbols.length) return res.status(400).json({ error: 'No symbols provided' });

            const settled = await Promise.allSettled(symbols.map(fetchQuote));
            const quotes = [];
            const errors = [];
            settled.forEach((result, index) => {
                if (result.status === 'fulfilled') quotes.push(result.value);
                else errors.push({ symbol: symbols[index], error: result.reason?.message || String(result.reason) });
            });

            return res.json({
                success: true,
                quotes,
                errors,
                dataSource: 'Yahoo Finance',
                cacheTtlMs: CACHE_TTL_MS,
                generatedAt: new Date().toISOString(),
                membership: req.cryptoMembership,
            });
        } catch (error) {
            console.error('[Crypto] Failed to fetch quotes:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.get('/api/crypto/history', attachMembership, async (req, res) => {
        try {
            const entitlements = req.cryptoMembership?.entitlements || getEntitlements('visitor');
            const symbol = normalizeSymbol(req.query.symbol);
            const range = String(req.query.range || '3mo');
            const interval = String(req.query.interval || (range === '1d' ? '5m' : '1d'));
            const allowedRanges = new Set(['1d', '2d', '5d', '1mo', '3mo', '6mo', '1y', '2y']);
            const allowedIntervals = new Set(['1m', '5m', '15m', '30m', '60m', '1d', '1wk', '1mo']);
            if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
            if (!allowedRanges.has(range)) return res.status(400).json({ error: 'Unsupported range' });
            if (!allowedIntervals.has(interval)) return res.status(400).json({ error: 'Unsupported interval' });
            if (!isRangeAllowed(range, entitlements)) {
                return res.status(403).json({
                    error: 'membership_range_limit',
                    tier: req.cryptoMembership?.tier || 'visitor',
                    allowedUntil: entitlements.historyRangeLimit,
                    message: `目前會員等級可查詢到 ${entitlements.historyRangeLimit}；升級可解鎖更長區間。`,
                });
            }

            const chart = await fetchChart(symbol, range, interval);
            return res.json({
                success: true,
                history: normalizeHistory(symbol, chart),
                dataSource: 'Yahoo Finance',
                cacheTtlMs: CACHE_TTL_MS,
                generatedAt: new Date().toISOString(),
                membership: req.cryptoMembership,
            });
        } catch (error) {
            console.error('[Crypto] Failed to fetch history:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.get('/api/crypto/search', attachMembership, async (req, res) => {
        try {
            const entitlements = req.cryptoMembership?.entitlements || getEntitlements('visitor');
            const query = String(req.query.q || '').trim();
            if (!query) return res.json({ success: true, results: [] });
            const yahooResults = asArray(await searchYahoo(query).catch(() => []));
            const unique = new Map();
            yahooResults.forEach((item) => {
                if (!item?.yahooSymbol || unique.has(item.yahooSymbol)) return;
                unique.set(item.yahooSymbol, item);
            });

            return res.json({
                success: true,
                results: Array.from(unique.values()).slice(0, Math.max(1, Number(entitlements.watchlistLimit || 3))),
                dataSource: 'Yahoo Finance',
                generatedAt: new Date().toISOString(),
                membership: req.cryptoMembership,
            });
        } catch (error) {
            console.error('[Crypto] Failed to search symbols:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.get('/api/crypto/positioning', attachMembership, requireSponsorTier, async (req, res) => {
        try {
            const symbol = normalizeSymbol(req.query.symbol);
            const source = String(req.query.source || 'binance').trim().toLowerCase();
            const timeframe = String(req.query.timeframe || '15m').trim();
            if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

            let data = null;
            if (source === 'binance') data = await fetchBinanceLongShort(symbol, timeframe);
            else if (source === 'bybit') data = await fetchBybitLongShort(symbol, timeframe);
            else if (source === 'okx') data = await fetchOkxLongShort(symbol, timeframe);
            else return res.status(400).json({ error: 'Unsupported source' });

            return res.json({
                success: true,
                positioning: data,
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            console.error('[Crypto] Failed to fetch positioning:', error);
            return res.status(error.statusCode || 500).json({ error: error.message || 'positioning_fetch_failed' });
        }
    });

    router.get('/api/crypto/news', attachMembership, requireSponsorTier, async (req, res) => {
        try {
            const symbol = normalizeSymbol(req.query.symbol);
            if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
            const quote = req.query.name
                ? { symbol, yahooSymbol: symbol, name: String(req.query.name || ''), market: inferMarket(symbol) }
                : null;
            const news = await fetchCryptoNews(quote || symbol, { limit: 6 });
            return res.json({
                success: true,
                news,
                query: buildCryptoNewsQuery(quote || symbol),
                generatedAt: new Date().toISOString(),
                membership: req.cryptoMembership,
            });
        } catch (error) {
            console.error('[Crypto] Failed to fetch news:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.get('/api/crypto/most-active', attachMembership, async (req, res) => {
        try {
            const limit = clamp(toNumber(req.query.limit, 50), 1, MOST_ACTIVE_LIMIT_MAX);
            const items = await fetchCryptoMostActive(limit);
            return res.json({
                success: true,
                market: 'crypto',
                items,
                generatedAt: new Date().toISOString(),
                membership: req.cryptoMembership,
            });
        } catch (error) {
            console.error('[Crypto] Failed to fetch most active list:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.get('/api/crypto/snapshot', attachMembership, (req, res) => {
        try {
            return res.json({
                success: true,
                snapshot: readCryptoSnapshot(),
                membership: req.cryptoMembership,
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    });

    router.post('/api/crypto/snapshot', attachMembership, (req, res) => {
        try {
            const snapshot = saveCryptoSnapshot(req.body?.snapshot || req.body);
            return res.json({
                success: true,
                snapshot,
                membership: req.cryptoMembership,
            });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
    });

    router.post('/api/crypto/snapshot/refresh', attachMembership, async (req, res) => {
        try {
            const trigger = String(req.body?.trigger || 'dashboard-refresh');
            const shouldConsumeAiQuota = trigger === 'dashboard-before-golem-analysis';
            let aiQuota = null;
            if (shouldConsumeAiQuota) {
                aiQuota = consumeAiQuota(req.cryptoMembership?.uid || '', req.cryptoMembership?.tier || 'visitor');
                if (!aiQuota.ok) {
                    return res.status(403).json({
                        error: 'ai_insight_quota_exceeded',
                        tier: req.cryptoMembership?.tier || 'visitor',
                        quota: aiQuota,
                        message: '今日 AI 分析配額已用完，升級贊助會員可獲得更高配額。',
                    });
                }
            }
            const snapshot = await refreshCryptoSnapshot({
                snapshot: req.body?.snapshot,
                symbols: req.body?.symbols,
                selectedSymbol: req.body?.selectedSymbol,
                selectedRange: req.body?.selectedRange,
                marketFilter: req.body?.marketFilter,
                trigger,
            });
            return res.json({
                success: true,
                snapshot,
                quota: aiQuota,
                membership: req.cryptoMembership,
            });
        } catch (error) {
            console.error('[Crypto] Failed to refresh snapshot:', error);
            return res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    router.get('/api/crypto/sponsor/features', attachMembership, requireSponsorTier, (req, res) => {
        return res.json({
            success: true,
            message: 'Sponsor-only features unlocked.',
            tier: req.cryptoMembership?.tier || 'visitor',
            nonce: crypto.randomUUID(),
            generatedAt: new Date().toISOString(),
        });
    });

    router.post('/api/crypto/decision', attachMembership, (req, res) => {
        try {
            const snapshot = req.body?.snapshot || readCryptoSnapshot();
            const decision = buildDecision(snapshot, { mode: 'crypto' });
            return res.json({
                success: true,
                decision,
                membership: req.cryptoMembership,
            });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
    });

    router.post('/api/crypto/simulate', attachMembership, (req, res) => {
        try {
            const snapshot = req.body?.snapshot || readCryptoSnapshot();
            const simulation = simulatePortfolio(snapshot, req.body || {});
            return res.json({
                success: true,
                simulation,
                membership: req.cryptoMembership,
            });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
    });

    return router;
};
