function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickSelected(snapshot) {
  if (snapshot && snapshot.selected && typeof snapshot.selected === 'object') return snapshot.selected;
  if (snapshot && Array.isArray(snapshot.watchlist) && snapshot.watchlist.length) return snapshot.watchlist[0];
  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildDecision(snapshot, options = {}) {
  const mode = String(options.mode || 'stock').toLowerCase();
  const selected = pickSelected(snapshot);
  const indicators = snapshot && typeof snapshot.indicators === 'object' ? snapshot.indicators : {};
  if (!selected) {
    return {
      verdict: 'hold',
      confidence: 0.2,
      score: 0,
      reasons: ['No selected symbol in snapshot'],
      riskFlags: ['insufficient_data'],
      nextChecks: ['refresh_snapshot'],
      plan: {
        entry: null,
        stopLossPct: null,
        takeProfitPct: null,
        positionSizePct: 0,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  const rsi = toNumber(indicators.rsi14, NaN);
  const macdHist = toNumber(indicators.macdHistogram, NaN);
  const volumeRatio = toNumber(indicators.volumeRatio, NaN);
  const distanceToSma = toNumber(indicators.distanceToSma20Percent, NaN);
  const volatility = Math.abs(toNumber(indicators.volatility, 0));
  const drawdown = Math.abs(toNumber(indicators.maxDrawdown, 0));

  let score = 0;
  const reasons = [];
  const riskFlags = [];

  if (Number.isFinite(rsi)) {
    if (rsi <= 35) { score += 1.1; reasons.push(`RSI ${rsi.toFixed(1)} near oversold`); }
    else if (rsi >= 70) { score -= 1.1; reasons.push(`RSI ${rsi.toFixed(1)} near overbought`); }
  } else {
    riskFlags.push('missing_rsi');
  }

  if (Number.isFinite(macdHist)) {
    if (macdHist > 0) { score += 0.9; reasons.push('MACD histogram positive'); }
    if (macdHist < 0) { score -= 0.9; reasons.push('MACD histogram negative'); }
  } else {
    riskFlags.push('missing_macd');
  }

  if (Number.isFinite(volumeRatio)) {
    if (volumeRatio >= 1.25) { score += 0.5; reasons.push(`Volume ratio ${volumeRatio.toFixed(2)} supports move`); }
    if (volumeRatio <= 0.7) { score -= 0.3; reasons.push(`Volume ratio ${volumeRatio.toFixed(2)} weak participation`); }
  }

  if (Number.isFinite(distanceToSma)) {
    if (distanceToSma >= 5) { score += 0.3; reasons.push('Price above SMA20 trend zone'); }
    if (distanceToSma <= -5) { score -= 0.3; reasons.push('Price below SMA20 trend zone'); }
  }

  if (volatility >= (mode === 'crypto' ? 90 : 45)) {
    score -= 0.4;
    riskFlags.push('high_volatility');
  }
  if (drawdown >= 18) {
    score -= 0.4;
    riskFlags.push('deep_drawdown');
  }

  const changePercent = toNumber(selected.changePercent, 0);
  if (Math.abs(changePercent) >= (mode === 'crypto' ? 8 : 4)) {
    riskFlags.push('intraday_extended_move');
  }

  let verdict = 'hold';
  if (score >= 1.2) verdict = 'accumulate';
  else if (score <= -1.2) verdict = 'reduce';

  const confidence = clamp(0.45 + Math.min(Math.abs(score), 3) * 0.14 - riskFlags.length * 0.04, 0.2, 0.9);
  const stopLossPct = mode === 'crypto' ? 4.5 : 3.2;
  const takeProfitPct = mode === 'crypto' ? 9 : 6;
  const basePositionPct = mode === 'crypto' ? 12 : 18;
  const riskPenalty = Math.min(8, riskFlags.length * 2);
  const positionSizePct = verdict === 'hold' ? Math.max(2, basePositionPct - riskPenalty - 4) : Math.max(2, basePositionPct - riskPenalty);

  return {
    symbol: selected.yahooSymbol || selected.symbol,
    verdict,
    confidence,
    score,
    reasons: reasons.slice(0, 6),
    riskFlags,
    nextChecks: [
      'validate_news_headlines',
      'confirm_market_breadth',
      'recheck_after_next_refresh',
    ],
    plan: {
      entry: toNumber(selected.price, 0),
      stopLossPct,
      takeProfitPct,
      positionSizePct,
    },
    generatedAt: new Date().toISOString(),
  };
}

function simulatePortfolio(snapshot, payload = {}) {
  const selected = pickSelected(snapshot);
  if (!selected) throw new Error('No selected symbol in snapshot');

  const entryPrice = Math.max(0.000001, toNumber(payload.entryPrice, selected.price || 0));
  const capital = Math.max(1, toNumber(payload.capital, 100000));
  const positionSizePct = clamp(toNumber(payload.positionSizePct, 15), 1, 100);
  const stopLossPct = clamp(Math.abs(toNumber(payload.stopLossPct, 3.5)), 0.1, 80);
  const takeProfitPct = clamp(Math.abs(toNumber(payload.takeProfitPct, 7)), 0.1, 300);
  const scenarioMoves = Array.isArray(payload.scenarioMoves) && payload.scenarioMoves.length
    ? payload.scenarioMoves.map((v) => toNumber(v, 0)).filter((v) => Number.isFinite(v))
    : [-10, -5, -2, 0, 2, 5, 10];

  const positionCapital = capital * (positionSizePct / 100);
  const quantity = positionCapital / entryPrice;
  const stopPrice = entryPrice * (1 - stopLossPct / 100);
  const takePrice = entryPrice * (1 + takeProfitPct / 100);

  const scenarios = scenarioMoves.map((movePct) => {
    const futurePrice = entryPrice * (1 + movePct / 100);
    const pnl = (futurePrice - entryPrice) * quantity;
    const pnlPctOnCapital = (pnl / capital) * 100;
    return {
      movePct,
      futurePrice,
      pnl,
      pnlPctOnCapital,
    };
  });

  const worst = scenarios.reduce((a, b) => (a.pnl < b.pnl ? a : b), scenarios[0]);
  const best = scenarios.reduce((a, b) => (a.pnl > b.pnl ? a : b), scenarios[0]);

  return {
    symbol: selected.yahooSymbol || selected.symbol,
    currency: selected.currency || 'USD',
    assumptions: {
      capital,
      entryPrice,
      positionSizePct,
      stopLossPct,
      takeProfitPct,
      positionCapital,
      quantity,
      stopPrice,
      takePrice,
    },
    scenarios,
    summary: {
      worstCasePnl: worst.pnl,
      bestCasePnl: best.pnl,
      maxRiskByStop: (stopPrice - entryPrice) * quantity,
      expectedRewardByTarget: (takePrice - entryPrice) * quantity,
      rrRatio: takeProfitPct / Math.max(0.01, stopLossPct),
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildDecision,
  simulatePortfolio,
};
