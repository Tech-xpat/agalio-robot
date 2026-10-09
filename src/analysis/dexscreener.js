const { SOL_MINT } = require('../config');

/**
 * Market snapshot from DexScreener (free, no key).
 * priceNative is only meaningful in SOL when the pair is quoted in SOL, so we only use
 * SOL-quoted pairs (picking the most liquid one). No SOL pair -> null (we do not trade it).
 */
async function getTokenMarket(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = await res.json();
  const pairs = (data.pairs || []).filter(
    (p) => p.chainId === 'solana' && p.baseToken && p.baseToken.address === mint && p.quoteToken && p.quoteToken.address === SOL_MINT
  );
  if (!pairs.length) return null;
  const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const priceNative = Number(best.priceNative || 0) || 0;
  if (!(priceNative > 0)) return null;
  return {
    marketCapUsd: Number(best.marketCap || best.fdv || 0) || 0,
    liquidityUsd: Number(best.liquidity?.usd || 0) || 0,
    priceUsd: Number(best.priceUsd || 0) || 0,
    priceNative, // SOL per 1 token
    volume24h: Number(best.volume?.h24 || 0) || 0,
    volume1h: Number(best.volume?.h1 || 0) || 0,
    priceChange5m: Number(best.priceChange?.m5 || 0) || 0,
    priceChange1h: Number(best.priceChange?.h1 || 0) || 0,
    pairUrl: best.url || null,
    dexId: best.dexId || null,
  };
}

module.exports = { getTokenMarket };
