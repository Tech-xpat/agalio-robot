/**
 * Direct token scanner. No whales.
 * Pulls recent Solana tokens from DexScreener (boosts + search),
 * scores "good looking chart", and signals buys on the mode interval.
 */
const logger = require('../utils/logger');
const market = require('../analysis/dexscreener');
const { getConfig } = require('../live/liveConfig');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;
let timer = null;
let lastScanAt = 0;
let onSignal = null;
const seen = new Map(); // mint -> lastSeenTs
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;

async function fetchSolPriceUsd() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 180;
    const data = await res.json();
    const pair = (data.pairs || []).find((p) => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT');
    const px = Number(pair?.priceUsd || 0);
    return px > 10 ? px : 180;
  } catch {
    return 180;
  }
}

async function fetchCandidates() {
  const mints = new Set();
  // Latest boosts
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const arr = await res.json();
      for (const item of arr || []) {
        if (item.chainId === 'solana' && item.tokenAddress) mints.add(item.tokenAddress);
      }
    }
  } catch (e) {
    logger.warn('boosts fetch failed:', e.message);
  }

  // Recent profiles
  try {
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const arr = await res.json();
      for (const item of arr || []) {
        if (item.chainId === 'solana' && item.tokenAddress) mints.add(item.tokenAddress);
      }
    }
  } catch (e) {
    logger.warn('profiles fetch failed:', e.message);
  }

  // Fallback: search pump-ish pairs via DexScreener search
  try {
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/search?q=pump',
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json();
      for (const p of data.pairs || []) {
        if (p.chainId === 'solana' && p.baseToken?.address) mints.add(p.baseToken.address);
      }
    }
  } catch (_) {}

  return [...mints].slice(0, 40);
}

/**
 * Score a market snapshot. Higher = better looking short chart.
 * Mode controls how strict the bar is.
 */
function scoreChart(mkt, mode) {
  if (!mkt || !(mkt.priceNative > 0)) return -Infinity;
  const liq = mkt.liquidityUsd || 0;
  const vol1h = mkt.volume1h || 0;
  const ch5 = mkt.priceChange5m || 0;
  const ch1h = mkt.priceChange1h || 0;

  // Hard filters by mode
  const bars = {
    easy: { minLiq: 3000, minVol1h: 800, minCh5: -8, minCh1h: -15 },
    medium: { minLiq: 8000, minVol1h: 2500, minCh5: 0, minCh1h: -5 },
    hard: { minLiq: 15000, minVol1h: 5000, minCh5: 3, minCh1h: 0 },
  };
  const b = bars[mode] || bars.medium;
  if (liq < b.minLiq) return -Infinity;
  if (vol1h < b.minVol1h) return -Infinity;
  if (ch5 < b.minCh5) return -Infinity;
  if (ch1h < b.minCh1h) return -Infinity;

  // Prefer positive momentum + liquidity + volume
  let score = 0;
  score += Math.min(ch5, 40) * 2;
  score += Math.min(ch1h, 60);
  score += Math.log10(Math.max(liq, 1)) * 8;
  score += Math.log10(Math.max(vol1h, 1)) * 6;
  return score;
}

function pruneSeen() {
  const now = Date.now();
  for (const [m, ts] of seen) {
    if (now - ts > SEEN_TTL_MS) seen.delete(m);
  }
}

async function pickOne() {
  const cfg = getConfig();
  const mode = cfg.riskProfile || 'easy';
  pruneSeen();
  const candidates = await fetchCandidates();
  if (!candidates.length) {
    logger.info('scanner: no candidates this cycle');
    return null;
  }

  const scored = [];
  for (const mint of candidates) {
    if (seen.has(mint)) continue;
    if (config.IGNORE_MINTS.includes(mint)) continue;
    try {
      const mkt = await market.getTokenMarket(mint);
      if (!mkt) continue;
      const s = scoreChart(mkt, mode);
      if (s > -Infinity) scored.push({ mint, mkt, score: s });
    } catch (_) {}
    await sleep(120); // be nice to DexScreener
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) {
    logger.info(`scanner: ${candidates.length} candidates, none passed ${mode} bar`);
    return null;
  }

  // Random among top 5 so it is not always the same coin
  const top = scored.slice(0, 5);
  const pick = top[Math.floor(Math.random() * top.length)];
  seen.set(pick.mint, Date.now());
  logger.info(
    `scanner pick ${pick.mint.slice(0, 8)}… score=${pick.score.toFixed(1)} liq=$${Math.round(pick.mkt.liquidityUsd)} ch5=${(pick.mkt.priceChange5m || 0).toFixed(1)}%`
  );
  return pick;
}

async function tick() {
  if (running) return;
  const cfg = getConfig();
  if (cfg.paused) return;

  const intervalMs = (Number(cfg.scanIntervalMin) || 5) * 60 * 1000;
  if (Date.now() - lastScanAt < intervalMs - 2000) return;

  running = true;
  lastScanAt = Date.now();
  try {
    const pick = await pickOne();
    if (pick && typeof onSignal === 'function') {
      await onSignal(pick);
    }
  } catch (e) {
    logger.error('scanner tick:', e.message);
  } finally {
    running = false;
  }
}

function start(handler) {
  onSignal = handler;
  if (timer) clearInterval(timer);
  // First scan after 15s so Telegram + positions are ready
  setTimeout(() => tick().catch(() => {}), 15000);
  timer = setInterval(() => tick().catch(() => {}), 30000); // check every 30s, honor interval inside
  logger.info('scanner started (direct PumpPortal-ready candidates via DexScreener)');
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  return {
    lastScanAt,
    seenCount: seen.size,
    nextInSec: Math.max(0, Math.round((((getConfig().scanIntervalMin || 5) * 60 * 1000) - (Date.now() - lastScanAt)) / 1000)),
  };
}

module.exports = { start, stop, status, fetchSolPriceUsd, pickOne };
