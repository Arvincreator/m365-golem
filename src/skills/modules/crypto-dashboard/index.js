const { buildFreshCryptoSnapshotInjection } = require('../../../services/CryptoDashboardSnapshot');

const SYMBOL_ALIASES = {
    比特幣: 'BTC-USDT',
    bitcoin: 'BTC-USDT',
    以太幣: 'ETH-USDT',
    ethereum: 'ETH-USDT',
    solana: 'SOL-USDT',
    瑞波: 'XRP-USDT',
    狗狗幣: 'DOGE-USDT',
    幣安幣: 'BNB-USDT',
};
const QUOTE_SUFFIXES = ['USDT', 'USDC', 'USD', 'BTC', 'ETH'];

function normalizeSymbol(input) {
    const raw = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!raw) return '';
    const pair = raw.replace('/', '-');
    if (/^[A-Z0-9]{2,12}-[A-Z0-9]{2,8}$/.test(pair)) {
        return pair.endsWith('-USD') ? pair.replace(/-USD$/, '-USDT') : pair;
    }
    for (const quote of QUOTE_SUFFIXES) {
        if (raw.endsWith(quote) && raw.length > quote.length + 1) {
            const base = raw.slice(0, -quote.length);
            if (/^[A-Z0-9]{2,12}$/.test(base)) return `${base}-${quote}`;
        }
    }
    if (/^[A-Z0-9]{2,12}$/.test(raw)) return `${raw}-USDT`;
    return raw.replace(/[^A-Z0-9-]/g, '').slice(0, 24);
}

function extractSymbolsFromText(text) {
    const source = String(text || '');
    const symbols = [];

    for (const [label, symbol] of Object.entries(SYMBOL_ALIASES)) {
        if (source.includes(label)) symbols.push(symbol);
    }

    const tokenMatches = source.match(/\b[A-Za-z0-9]{2,12}(?:[-/](?:USDT|USDC|USD|BTC|ETH))?\b/g) || [];
    for (const token of tokenMatches) {
        const symbol = normalizeSymbol(token);
        if (symbol && !['CRYPTO', 'DASHBOARD', 'MARKET', 'ANALYSIS'].includes(symbol)) symbols.push(symbol);
    }

    return [...new Set(symbols)];
}

function resolveSymbols(args = {}) {
    const rawSymbols = []
        .concat(args.symbols || [])
        .concat(args.tickers || [])
        .concat(args.symbol || [])
        .filter(Boolean);

    const explicit = rawSymbols.map(normalizeSymbol).filter(Boolean);
    const inferred = extractSymbolsFromText([
        args.query,
        args.request,
        args.text,
        args.message,
        args.selectedSymbol,
    ].filter(Boolean).join('\n'));

    return [...new Set([...explicit, ...inferred])];
}

async function run(ctx = {}) {
    const args = ctx.args || ctx.parameters || {};
    const symbols = resolveSymbols(args);
    const selectedSymbol = normalizeSymbol(args.selectedSymbol || args.selected || symbols[0]);
    const selectedRange = String(args.selectedRange || args.range || '1h');
    const marketFilter = String(args.marketFilter || args.market || 'all').toLowerCase();

    const injection = await buildFreshCryptoSnapshotInjection({
        trigger: 'skill-crypto-dashboard',
        symbols,
        selectedSymbol: selectedSymbol || undefined,
        selectedRange,
        marketFilter,
        includeNews: args.includeNews !== false,
    });

    return [
        injection,
        '',
        '[Crypto Dashboard Analysis Instructions]',
        '請根據以上資料輸出幣市概況、主要強弱幣對、技術指標、新聞脈絡、風險提醒。',
        '請明確說明資料時間與限制；不要做保證式投資建議，也不要承諾報酬。',
    ].join('\n');
}

module.exports = {
    name: 'crypto-dashboard',
    description: '讀取並刷新 Dashboard 加密貨幣分析看板快照，協助分析幣對、技術指標與新聞脈絡。',
    tags: ['finance', 'crypto', 'dashboard', 'market-analysis'],
    paramsSchema: {
        type: 'object',
        properties: {
            symbols: { type: 'array', items: { type: 'string' } },
            selectedSymbol: { type: 'string' },
            marketFilter: { type: 'string', enum: ['all', 'crypto'] },
            selectedRange: { type: 'string', enum: ['5m', '15m', '1h', '1d', '1M'] },
            includeNews: { type: 'boolean' },
        },
    },
    run,
};
