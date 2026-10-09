const staticConfig = require('../config');

/**
 * Risk presets — rewritten for direct scanner (no whales).
 * sizeUsd is the target notional per trade.
 * scanIntervalMin controls how often the scanner looks for a new coin.
 */
const PRESETS = {
  easy: {
    name: 'Easy',
    sizeUsd: 2,
    takeProfitPct: 30,
    stopLossPct: 20,
    maxHoldMin: 2,
    scanIntervalMin: 5,
    maxTradesDay: 7,
    capitalPct: 3,
    maxPositionSol: 0.05,
  },
  medium: {
    name: 'Medium',
    sizeUsd: 5,
    takeProfitPct: 60,
    stopLossPct: 30,
    maxHoldMin: 5,
    scanIntervalMin: 10,
    maxTradesDay: 15,
    capitalPct: 5,
    maxPositionSol: 0.12,
  },
  hard: {
    name: 'Hard',
    sizeUsd: 7,
    takeProfitPct: 100,
    stopLossPct: 45,
    maxHoldMin: 8,
    scanIntervalMin: 30,
    maxTradesDay: 20,
    capitalPct: 8,
    maxPositionSol: 0.20,
  },
};

let cached = {
  paused: false,
  riskProfile: 'easy',
  sizeUsd: PRESETS.easy.sizeUsd,
  takeProfitPct: PRESETS.easy.takeProfitPct,
  stopLossPct: PRESETS.easy.stopLossPct,
  maxHoldMin: PRESETS.easy.maxHoldMin,
  scanIntervalMin: PRESETS.easy.scanIntervalMin,
  maxTradesDay: PRESETS.easy.maxTradesDay,
  capitalPct: PRESETS.easy.capitalPct,
  maxPositionSol: PRESETS.easy.maxPositionSol,
  // legacy fields kept so old code does not crash
  dipEntryPct: 0,
  minWhaleAgreement: 0,
  whaleLookbackMin: 0,
};

function getConfig() {
  return { ...cached };
}

function applyLocal(patch) {
  cached = { ...cached, ...patch };
  return getConfig();
}

function applyPreset(name) {
  const key = String(name || '').toLowerCase().trim();
  const preset = PRESETS[key];
  if (!preset) return null;
  const { name: _n, ...params } = preset;
  cached = {
    ...cached,
    riskProfile: key,
    ...params,
  };
  return getConfig();
}

function listPresets() {
  return Object.entries(PRESETS).map(([key, p]) => ({
    key,
    name: p.name,
    summary: `$${p.sizeUsd} · TP +${p.takeProfitPct}% · SL −${p.stopLossPct}% · hold ${p.maxHoldMin}m · every ${p.scanIntervalMin}m · max ${p.maxTradesDay}/day`,
  }));
}

function start() {
  console.log('[live-config] direct-scanner presets loaded');
  applyPreset(cached.riskProfile || 'easy');
}

module.exports = { getConfig, applyLocal, applyPreset, listPresets, PRESETS, start };
