/**
 * Direct token scanner.
 * Targets tokens that:
 *  - have survived at least MIN_AGE_DAYS (default 10)
 *  - show rising price action (positive short/medium changes)
 *  - pass liquidity / volume / activity bars by mode
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
const seen = new Map();
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;
const MIN_AGE_DAYS = 10;

async function fetchSolPriceUsd() {
  try {
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112',
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return 180;
    const data = await res.json();
    const pair = (data.pairs || []).find(
      (p) => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT'
    );
    const px = Number(pair?.priceUsd || 0);
    return px > 10 ? px : 180;
  } catch {
    return 180;
  }
}

async function fetchCandidates() {
  const mints = new Set();

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

  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana', {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      for (const p of data.pairs || []) {
        if (p.chainId === 'solana' && p.baseToken?.address) mints.add(p.baseToken.address);
      }
    }
  } catch (_) {}

  return [...mints].slice(0, 50);
}

function scoreChart(mkt, mode) {
  if (!mkt || !(mkt.priceNative > 0)) return -Infinity;

  const ageDays = mkt.ageDays || 0;
  if (ageDays < MIN_AGE_DAYS) return -Infinity;

  const liq = mkt.liquidityUsd || 0;
  const vol1h = mkt.volume1h || 0;
  const vol6h = mkt.volume6h || 0;
  const ch5 = mkt.priceChange5m || 0;
  const ch1h = mkt.priceChange1h || 0;
  const ch6h = mkt.priceChange6h || 0;
  const ch24h = mkt.priceChange24h || 0;
  const buys1h = mkt.buys1h || 0;
  const sells1h = mkt.sells1h || 0;

  const rising = ch1h > 0 || ch6h > 2;
  if (!rising) return -Infinity;
  if (ch5 < -12) return -Infinity;
  if (ch24h < -40) return -Infinity;

  const bars = {
    easy: { minLiq: 8000, minVol1h: 1500, minBuys1h: 5 },
    medium: { minLiq: 15000, minVol1h: 4000, minBuys1h: 12 },
    hard: { minLiq: 30000, minVol1h: 8000, minBuys1h: 20 },
  };
  const b = bars[mode] || bars.medium;
  if (liq < b.minLiq) return -Infinity;
  if (vol1h < b.minVol1h && vol6h < b.minVol1h * 3) return -Infinity;
  if (buys1h < b.minBuys1h) return -Infinity;

  const buyPressure = sells1h > 0 ? buys1h / sells1h : buys1h > 0 ? 2 : 0;
  if (buyPressure < 0.7) return -Infinity;

  let score = 0;
  score += Math.min(ch5, 25) * 1.5;
  score += Math.min(ch1h, 40) * 2;
  score += Math.min(ch6h, 60);
  score += Math.log10(Math.max(liq, 1)) * 10;
  score += Math.log10(Math.max(vol1h, 1)) * 6;
  score += Math.min(buyPressure, 3) * 8;
  score += Math.min(ageDays, 60) * 0.3;
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
  const mode = cfg.riskProfile || 'medium';
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
    await sleep(120);
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) {
    logger.info(`scanner: ${candidates.length} candidates, none passed ${mode} bar (age≥${MIN_AGE_DAYS}d + rising)`);
    return null;
  }

  const top = scored.slice(0, 5);
  const pick = top[Math.floor(Math.random() * top.length)];
  seen.set(pick.mint, Date.now());
  logger.info(
    `scanner pick ${pick.mint.slice(0, 8)}… score=${pick.score.toFixed(1)} age=${pick.mkt.ageDays.toFixed(1)}d liq=$${Math.round(pick.mkt.liquidityUsd)} ch1h=${(pick.mkt.priceChange1h || 0).toFixed(1)}% buys1h=${pick.mkt.buys1h || 0}`
  );
  return pick;
}

async function tick() {
  if (running) return;
  const cfg = getConfig();
  if (cfg.paused) return;

  const intervalMs = (Number(cfg.scanIntervalMin) || 10) * 60 * 1000;
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
  setTimeout(() => tick().catch(() => {}), 15000);
  timer = setInterval(() => tick().catch(() => {}), 30000);
  logger.info(`scanner started (min age ${MIN_AGE_DAYS}d, rising + activity filters)`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  return {
    lastScanAt,
    seenCount: seen.size,
    minAgeDays: MIN_AGE_DAYS,
    nextInSec: Math.max(
      0,
      Math.round(
        (((getConfig().scanIntervalMin || 10) * 60 * 1000) - (Date.now() - lastScanAt)) / 1000
      )
    ),
  };
}

module.exports = { start, stop, status, fetchSolPriceUsd, pickOne, MIN_AGE_DAYS };
