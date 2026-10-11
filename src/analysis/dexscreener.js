const { SOL_MINT } = require('../config');

/**
 * Market snapshot from DexScreener (free, no key).
 * Includes pair age (pairCreatedAt) for 10-day survival filter.
 * priceNative only used when pair is quoted in SOL.
 let me add more
 */
async function getTokenMarket(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = await res.json();
  const pairs = (data.pairs || []).filter(
    (p) =>
      p.chainId === 'solana' &&
      p.baseToken &&
      p.baseToken.address === mint &&
      p.quoteToken &&
      p.quoteToken.address === SOL_MINT
  );
  if (!pairs.length) return null;
  const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const priceNative = Number(best.priceNative || 0) || 0;
  if (!(priceNative > 0)) return null;

  const createdAt = Number(best.pairCreatedAt || 0) || 0;
  const ageDays = createdAt > 0 ? (Date.now() - createdAt) / (1000 * 60 * 60 * 24) : 0;

  const txnsH1 = (best.txns && best.txns.h1) || {};
  const buys1h = Number(txnsH1.buys || 0) || 0;
  const sells1h = Number(txnsH1.sells || 0) || 0;

  return {
    marketCapUsd: Number(best.marketCap || best.fdv || 0) || 0,
    liquidityUsd: Number(best.liquidity?.usd || 0) || 0,
    priceUsd: Number(best.priceUsd || 0) || 0,
    priceNative,
    volume24h: Number(best.volume?.h24 || 0) || 0,
    volume1h: Number(best.volume?.h1 || 0) || 0,
    volume6h: Number(best.volume?.h6 || 0) || 0,
    priceChange5m: Number(best.priceChange?.m5 || 0) || 0,
    priceChange1h: Number(best.priceChange?.h1 || 0) || 0,
    priceChange6h: Number(best.priceChange?.h6 || 0) || 0,
    priceChange24h: Number(best.priceChange?.h24 || 0) || 0,
    pairCreatedAt: createdAt,
    ageDays,
    buys1h,
    sells1h,
    pairUrl: best.url || null,
    dexId: best.dexId || null,
  };
}

module.exports = { getTokenMarket };
