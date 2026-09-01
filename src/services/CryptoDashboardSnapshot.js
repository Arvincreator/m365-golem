const fs = require('fs');
const path = require('path');

const SNAPSHOT_DIR = path.resolve(process.cwd(), 'data', 'dashboard');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'crypto-dashboard-snapshot.json');
const MAX_SNAPSHOT_BYTES = 700 * 1024;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'BNB-USDT', 'XRP-USDT', 'DOGE-USDT'];
const CRYPTO_NEWS_ALIASES = {
    BTC: ['比特幣', 'Bitcoin', 'BTC'],
    ETH: ['以太幣', 'Ethereum', 'ETH'],
    SOL: ['Solana', 'SOL'],
    BNB: ['Binance Coin', 'BNB'],
    XRP: ['Ripple', 'XRP'],
    DOGE: ['Dogecoin', 'DOGE', '狗狗幣'],
    ADA: ['Cardano', 'ADA'],
    AVAX: ['Avalanche', 'AVAX'],
    DOT: ['Polkadot', 'DOT'],
    LINK: ['Chainlink', 'LINK'],
};
const RANGE_MAP = {
    '5m': { range: '1d', interval: '5m' },
    '15m': { range: '5d', interval: '15m' },
    '1h': { range: '1mo', interval: '60m' },
    '1d': { range: '1y', interval: '1d' },
    '1M': { range: '1mo', interval: '1d' },
    // Backward compatibility with legacy keys
    '1D': { range: '1d', interval: '5m' },
    '1M': { range: '1mo', interval: '1d' },
    '3M': { range: '3mo', interval: '1d' },
    '6M': { range: '6mo', interval: '1d' },
    '1Y': { range: '1y', interval: '1d' },
};
const CRYPTO_SYMBOL_RE = /^[A-Z0-9]{2,12}[-/](USD|USDT|USDC|BUSD|DAI|BTC|ETH)$/;
const QUOTE_SUFFIXES = ['USDT', 'USDC', 'BUSD', 'DAI', 'USD', 'BTC', 'ETH'];
const FIAT_STABLE_QUOTES = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'USD']);

let memorySnapshot = null;

function ensureStorage() {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
        fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    }
}

function trimSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const cloned = JSON.parse(JSON.stringify(snapshot));
    if (Array.isArray(cloned.watchlist)) cloned.watchlist = cloned.watchlist.slice(0, 30);
    if (Array.isArray(cloned.quoteErrors)) cloned.quoteErrors = cloned.quoteErrors.slice(0, 20);
    return cloned;
}

function saveCryptoSnapshot(snapshot) {
    const safeSnapshot = trimSnapshot(snapshot);
    if (!safeSnapshot) {
        throw new Error('Invalid crypto dashboard snapshot');
    }
    const payload = {
        ...safeSnapshot,
        savedAt: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES) {
        throw new Error('Crypto dashboard snapshot is too large');
    }
    ensureStorage();
    fs.writeFileSync(SNAPSHOT_PATH, raw, 'utf8');
    memorySnapshot = payload;
    return payload;
}

function readCryptoSnapshot() {
    if (memorySnapshot) return memorySnapshot;
    try {
        if (!fs.existsSync(SNAPSHOT_PATH)) return null;
        const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        memorySnapshot = parsed;
        return parsed;
    } catch (error) {
        console.warn('[CryptoSnapshot] Failed to read crypto dashboard snapshot:', error.message);
        return null;
    }
}

function createHttpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
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
    return String(symbol || '').replace(/-(USD|USDT|USDC|BUSD|DAI|BTC|ETH)$/i, '');
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

function formatDateForQuery(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x2F;/g, '/')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function resolveDuckDuckGoUrl(value) {
    const raw = decodeHtml(value);
    try {
        const parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) return decodeURIComponent(uddg);
        return parsed.toString();
    } catch {
        return raw;
    }
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRssItems(xml, sourceName) {
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    return Array.from(String(xml || '').matchAll(itemRegex)).map((match) => {
        const block = match[1] || '';
        const readTag = (tag) => {
            const tagMatch = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
            return decodeHtml(tagMatch?.[1] || '');
        };
        const publishedAt = readTag('pubDate');
        return {
            title: readTag('title'),
            url: readTag('link'),
            snippet: readTag('description'),
            source: sourceName,
            publishedAt: publishedAt ? new Date(publishedAt).toISOString() : '',
        };
    }).filter((item) => item.title && item.url);
}

function getNewsKeywords(queryInfo) {
    const symbol = String(queryInfo.symbol || '').toUpperCase();
    const name = String(queryInfo.name || '').trim();
    const keywords = [symbol, queryInfo.yahooSymbol, name];
    if (CRYPTO_NEWS_ALIASES[symbol]) keywords.push(...CRYPTO_NEWS_ALIASES[symbol]);
    if (name.includes(' ')) keywords.push(...name.split(/\s+/).filter((word) => word.length >= 3));
    return Array.from(new Set(keywords.map((item) => String(item || '').trim()).filter((item) => item.length >= 2)));
}

function isWithinDateWindow(item, queryInfo) {
    if (!item.publishedAt) return true;
    const published = Date.parse(item.publishedAt);
    const since = Date.parse(queryInfo.dateWindow.since);
    const until = Date.parse(queryInfo.dateWindow.until) + 24 * 60 * 60 * 1000;
    if (!Number.isFinite(published)) return true;
    return published >= since && published <= until;
}

function isRelevantNews(item, queryInfo) {
    const haystack = `${item.title || ''} ${item.snippet || ''} ${item.url || ''}`.toLowerCase();
    return getNewsKeywords(queryInfo).some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function dedupeNews(items, limit) {
    const unique = new Map();
    for (const item of items) {
        if (!item?.title || !item?.url) continue;
        const key = item.url.split('?')[0] || item.title;
        if (!unique.has(key)) unique.set(key, item);
    }
    return Array.from(unique.values())
        .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
        .slice(0, limit);
}

function buildCryptoNewsQuery(quoteOrSymbol, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const since = options.since instanceof Date ? options.since : new Date(now.getTime() - TWO_WEEKS_MS);
    const until = options.until instanceof Date ? options.until : now;
    const symbol = normalizeSymbol(quoteOrSymbol?.yahooSymbol || quoteOrSymbol?.symbol || quoteOrSymbol);
    const displaySymbol = getDisplaySymbol(symbol);
    const name = String(quoteOrSymbol?.name || displaySymbol).trim();
    const market = quoteOrSymbol?.market || inferMarket(symbol);
    const sinceText = formatDateForQuery(since);
    const untilText = formatDateForQuery(until);
    const terms = `${displaySymbol} ${name} crypto cryptocurrency news 最新`;

    return {
        symbol: displaySymbol,
        yahooSymbol: symbol,
        name,
        market,
        languagePriority: 'zh-TW',
        dateWindow: {
            since: sinceText,
            until: untilText,
            days: Math.round((until.getTime() - since.getTime()) / (24 * 60 * 60 * 1000)),
        },
        query: `${terms} after:${sinceText} before:${untilText}`,
    };
}

async function fetchDuckDuckGoNews(queryInfo, options = {}) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryInfo.query)}&kl=tw-tzh&df=m`;
    const html = await fetchJsonLikeText(url);
    const results = [];
    const anchorRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const anchors = Array.from(html.matchAll(anchorRegex));

    for (const [index, linkMatch] of anchors.entries()) {
        const nextAnchorIndex = anchors[index + 1]?.index ?? html.length;
        const block = html.slice(linkMatch.index || 0, nextAnchorIndex);
        const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);
        const sourceMatch = block.match(/class="result__url"[^>]*>([\s\S]*?)<\/(?:a|span)>/);
        const title = decodeHtml(linkMatch[2]);
        const resultUrl = resolveDuckDuckGoUrl(linkMatch[1]);
        const snippet = decodeHtml(snippetMatch?.[1] || '');
        const source = decodeHtml(sourceMatch?.[1] || '');
        if (!title || !resultUrl) continue;
        results.push({
            title,
            url: resultUrl,
            snippet,
            source: source || 'DuckDuckGo HTML search',
            publishedAt: '',
        });
        if (results.length >= (options.limit || 12)) break;
    }
    return results;
}

async function fetchYahooRssNews(queryInfo) {
    const categories = ['intl-markets', 'news'];
    const batches = await Promise.all(categories.map(async (category) => {
        const xml = await fetchText(`https://tw.stock.yahoo.com/rss?category=${encodeURIComponent(category)}`, {
            Accept: 'application/rss+xml,text/xml,text/plain',
            Referer: 'https://tw.stock.yahoo.com/',
        });
        return parseRssItems(xml, `Yahoo RSS ${category}`);
    }));
    const rows = batches.flat().filter((item) => isWithinDateWindow(item, queryInfo));
    const relevant = rows.filter((item) => isRelevantNews(item, queryInfo));
    return relevant.length ? relevant : rows.slice(0, 8);
}

async function fetchYahooFinanceNews(queryInfo) {
    const searchTerms = `${queryInfo.yahooSymbol} ${queryInfo.name}`;
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(searchTerms)}&quotesCount=0&newsCount=12`;
    const payload = await fetchJson(url);
    const rows = Array.isArray(payload?.news) ? payload.news : [];
    return rows.map((item) => ({
        title: decodeHtml(item.title || ''),
        url: item.link || item.url || '',
        snippet: decodeHtml(item.summary || item.publisher || ''),
        source: item.publisher ? `Yahoo Finance · ${item.publisher}` : 'Yahoo Finance news',
        publishedAt: item.providerPublishTime ? new Date(Number(item.providerPublishTime) * 1000).toISOString() : '',
    })).filter((item) => item.title && item.url && isWithinDateWindow(item, queryInfo) && isRelevantNews(item, queryInfo));
}

async function fetchGoogleNewsRss(queryInfo) {
    const terms = `${queryInfo.symbol} ${queryInfo.name} crypto blockchain 加密貨幣 when:14d`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(terms)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const xml = await fetchText(url, {
        Accept: 'application/rss+xml,text/xml,text/plain',
        Referer: 'https://news.google.com/',
    });
    return parseRssItems(xml, 'Google News RSS')
        .filter((item) => isWithinDateWindow(item, queryInfo) && isRelevantNews(item, queryInfo));
}

async function fetchCryptoNews(quoteOrSymbol, options = {}) {
    const queryInfo = buildCryptoNewsQuery(quoteOrSymbol, options);
    if (!queryInfo.yahooSymbol) throw createHttpError(400, 'Missing symbol for news search');
    const limit = options.limit || 12;
    const sourceStatus = [];
    const jobs = [
        ['Yahoo RSS', () => fetchYahooRssNews(queryInfo)],
        ['Yahoo Finance news', () => fetchYahooFinanceNews(queryInfo)],
        ['Google News RSS', () => fetchGoogleNewsRss(queryInfo)],
        ['DuckDuckGo HTML search', () => fetchDuckDuckGoNews(queryInfo, { limit })],
    ];
    const collected = [];
    for (const [source, job] of jobs) {
        try {
            const rows = await job();
            collected.push(...rows);
            sourceStatus.push({ source, status: 'ok', count: rows.length });
        } catch (error) {
            sourceStatus.push({ source, status: 'error', error: error.message || String(error) });
        }
    }

    return {
        ...queryInfo,
        source: sourceStatus.map((item) => item.source).join(' + '),
        sourceStatus,
        fetchedAt: new Date().toISOString(),
        results: dedupeNews(collected, limit),
    };
}

async function fetchText(url, extraHeaders = {}) {
    const response = await fetch(url, {
        headers: {
            'Accept': 'text/html,application/xhtml+xml,text/plain',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.7,en;q=0.6',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 GolemDashboard/1.0',
            ...extraHeaders,
        },
    });
    const text = await response.text();
    if (!response.ok) {
        throw createHttpError(response.status === 404 ? 404 : 502, `Text request failed (${response.status})`);
    }
    return text;
}

async function fetchJsonLikeText(url) {
    return fetchText(url, {
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://html.duckduckgo.com/',
    });
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

async function fetchChart(symbol, range = '1d', interval = '5m') {
    const safeSymbol = normalizeSymbol(symbol);
    if (!safeSymbol) throw createHttpError(400, 'Missing symbol');
    const upstreamSymbol = toYahooSymbol(safeSymbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(upstreamSymbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false&events=div%2Csplits`;
    const payload = await fetchJson(url);
    const result = payload?.chart?.result?.[0];
    if (!result) {
        const message = payload?.chart?.error?.description || `No chart data for ${upstreamSymbol}`;
        throw createHttpError(404, message);
    }
    return { ...result, _requestedSymbol: safeSymbol, _upstreamSymbol: upstreamSymbol };
}

function getQuoteName(symbol, meta) {
    return meta.longName || meta.shortName || getDisplaySymbol(symbol);
}

function normalizeQuote(symbol, chartResult) {
    const meta = chartResult?.meta || {};
    const quoteData = chartResult?.indicators?.quote?.[0] || {};
    const closes = Array.isArray(quoteData.close) ? quoteData.close.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
    const volumes = Array.isArray(quoteData.volume) ? quoteData.volume.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
    const price = toNumber(meta.regularMarketPrice, closes[closes.length - 1] || meta.previousClose || 0);
    const previousClose = toNumber(meta.chartPreviousClose ?? meta.previousClose, price);
    const change = price - previousClose;
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
        dayHigh: toPositiveNullableNumber(meta.regularMarketDayHigh),
        dayLow: toPositiveNullableNumber(meta.regularMarketDayLow),
        fiftyTwoWeekHigh: toPositiveNullableNumber(meta.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: toPositiveNullableNumber(meta.fiftyTwoWeekLow),
        change,
        changePercent: previousClose ? (change / previousClose) * 100 : 0,
        volume: toNumber(meta.regularMarketVolume, volumes[volumes.length - 1] || 0),
        turnover: price * toNumber(meta.regularMarketVolume, volumes[volumes.length - 1] || 0),
        marketCap: toPositiveNullableNumber(meta.marketCap),
        sector: 'Crypto',
        dataSource: 'Yahoo Finance',
        lastUpdatedAt: meta.regularMarketTime
            ? new Date(Number(meta.regularMarketTime) * 1000).toISOString()
            : new Date().toISOString(),
        hasIntradayData: Array.isArray(chartResult?.timestamp) && chartResult.timestamp.length > 0,
        dataQuality: 'live',
    };
}

async function fetchQuote(symbol) {
    const requestedSymbol = normalizeSymbol(symbol);
    const result = await fetchChart(requestedSymbol, '1d', '5m');
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

function calculateSma(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((sum, value) => sum + value, 0) / period;
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
    let previous = values[0];
    return values.map((value, index) => {
        previous = index === 0 ? value : (value - previous) * multiplier + previous;
        return previous;
    });
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
    return { macd, signal, histogram: macd - signal };
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
    return { k: kSeries[kSeries.length - 1] ?? null, d: calculateSma(kSeries, 3) };
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
    if (!Array.isArray(points) || points.length < period) return { upper: null, lower: null, middle: null };
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
        if (peak > 0) maxDrawdown = Math.min(maxDrawdown, ((value - peak) / peak) * 100);
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

function getSymbolsForRefresh(snapshot, overrideSymbols) {
    const rawSymbols = Array.isArray(overrideSymbols) && overrideSymbols.length
        ? overrideSymbols
        : Array.isArray(snapshot?.watchlist)
            ? snapshot.watchlist.map((quote) => quote?.yahooSymbol || quote?.symbol)
            : DEFAULT_SYMBOLS;
    return Array.from(new Set(rawSymbols.map(normalizeSymbol).filter(Boolean))).slice(0, 20);
}

function calculateBreadth(quotes) {
    const source = Array.isArray(quotes) ? quotes : [];
    const advancers = source.filter((quote) => quote.change > 0).length;
    const decliners = source.filter((quote) => quote.change < 0).length;
    const averageMove = source.reduce((sum, quote) => sum + quote.changePercent, 0) / Math.max(1, source.length);
    const totalTurnover = source.reduce((sum, quote) => sum + quote.turnover, 0);
    return { advancers, decliners, averageMove, totalTurnover, count: source.length };
}

async function refreshCryptoSnapshot(options = {}) {
    const previous = options.snapshot || readCryptoSnapshot() || {};
    const symbols = getSymbolsForRefresh(previous, options.symbols);
    const selectedSymbol = normalizeSymbol(options.selectedSymbol || previous?.selected?.yahooSymbol || previous?.selected?.symbol || symbols[0]);
    const selectedRange = options.selectedRange || previous.selectedRange || '1h';
    const marketFilter = options.marketFilter || previous.marketFilter || 'all';
    const rangeConfig = RANGE_MAP[selectedRange] || RANGE_MAP['1h'];

    const settled = await Promise.allSettled(symbols.map((symbol) => fetchQuote(symbol)));
    const quotes = [];
    const quoteErrors = [];
    settled.forEach((result, index) => {
        if (result.status === 'fulfilled') quotes.push(result.value);
        else quoteErrors.push({ symbol: symbols[index], error: result.reason?.message || String(result.reason) });
    });
    if (!quotes.length) {
        throw createHttpError(502, 'Unable to refresh any crypto quote from Yahoo Finance');
    }

    let indicators = previous.indicators || null;
    let news = previous.news || null;
    const historyErrors = [];
    try {
        const history = normalizeHistory(selectedSymbol, await fetchChart(selectedSymbol, rangeConfig.range, rangeConfig.interval));
        indicators = history.indicators;
    } catch (error) {
        historyErrors.push({ symbol: selectedSymbol, error: error.message || String(error) });
    }

    const visibleQuotes = quotes.filter((quote) => marketFilter === 'all' || quote.market === marketFilter);
    const selected = quotes.find((quote) => quote.yahooSymbol === selectedSymbol) || quotes[0] || previous.selected || null;
    if (selected && options.includeNews !== false) {
        try {
            news = await fetchCryptoNews(selected, { limit: 6 });
        } catch (error) {
            historyErrors.push({ symbol: selectedSymbol, error: `news: ${error.message || String(error)}` });
        }
    }
    return saveCryptoSnapshot({
        source: 'dashboard-crypto-analysis',
        dataStatus: quoteErrors.length || historyErrors.length ? 'partial-live-market-data' : 'live-market-data',
        marketFilter,
        selectedRange,
        selected,
        indicators,
        news,
        positioning: previous.positioning || null,
        watchlist: visibleQuotes.length ? visibleQuotes : quotes,
        breadth: calculateBreadth(visibleQuotes.length ? visibleQuotes : quotes),
        quoteErrors: [...quoteErrors, ...historyErrors],
        generatedAt: new Date().toISOString(),
        refresh: {
            trigger: options.trigger || 'server-refresh',
            status: quoteErrors.length || historyErrors.length ? 'partial' : 'ok',
            previousSavedAt: previous.savedAt || null,
        },
    });
}

function buildCryptoSnapshotInjection(snapshot = readCryptoSnapshot()) {
    if (!snapshot) {
        return [
            '[Dashboard Crypto Snapshot]',
            '目前沒有可用的加密貨幣看板快照。請先開啟 Dashboard 的「加密貨幣分析」頁，等待行情載入後再要求分析。',
        ].join('\n');
    }

    return [
        '[Dashboard Crypto Snapshot]',
        '以下是 Dashboard「加密貨幣分析」頁最近同步的結構化看板資料。請以此為主要資料來源，並說明資料時間與限制。',
        JSON.stringify(snapshot, null, 2),
    ].join('\n');
}

async function buildFreshCryptoSnapshotInjection(options = {}) {
    try {
        return buildCryptoSnapshotInjection(await refreshCryptoSnapshot({
            ...options,
            trigger: options.trigger || 'ai-command',
        }));
    } catch (error) {
        const snapshot = readCryptoSnapshot();
        const fallbackNotice = [
            '[Dashboard Crypto Snapshot Refresh Warning]',
            `刷新 Yahoo Finance 即時資料失敗：${error.message || String(error)}`,
            snapshot ? '以下改用 Dashboard 最近保存的快照，請清楚提醒使用者資料可能不是最新。' : '目前也沒有可用的舊快照。',
        ].join('\n');
        return `${fallbackNotice}\n\n${buildCryptoSnapshotInjection(snapshot)}`;
    }
}

module.exports = {
    SNAPSHOT_PATH,
    saveCryptoSnapshot,
    readCryptoSnapshot,
    refreshCryptoSnapshot,
    fetchCryptoNews,
    buildCryptoNewsQuery,
    buildCryptoSnapshotInjection,
    buildFreshCryptoSnapshotInjection,
};
