/**
 * Risk presets + live custom overrides.
 * Custom: /setsize /settp /setsl /sethold /setscan /setmaxtrades
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
  riskProfile: 'medium',
  sizeUsd: PRESETS.medium.sizeUsd,
  takeProfitPct: PRESETS.medium.takeProfitPct,
  stopLossPct: PRESETS.medium.stopLossPct,
  maxHoldMin: PRESETS.medium.maxHoldMin,
  scanIntervalMin: PRESETS.medium.scanIntervalMin,
  maxTradesDay: PRESETS.medium.maxTradesDay,
  capitalPct: PRESETS.medium.capitalPct,
  maxPositionSol: PRESETS.medium.maxPositionSol,
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

function applyCustom(params = {}) {
  const allowed = [
    'sizeUsd',
    'takeProfitPct',
    'stopLossPct',
    'maxHoldMin',
    'scanIntervalMin',
    'maxTradesDay',
    'maxPositionSol',
    'capitalPct',
  ];
  const patch = { riskProfile: 'custom' };
  for (const k of allowed) {
    if (params[k] != null && Number.isFinite(Number(params[k]))) {
      patch[k] = Number(params[k]);
    }
  }
  cached = { ...cached, ...patch };
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
  console.log('[live-config] presets + custom entry ready');
  if (cached.riskProfile === 'medium' || !PRESETS[cached.riskProfile]) {
    applyPreset('medium');
  }
}

module.exports = {
  getConfig,
  applyLocal,
  applyPreset,
  applyCustom,
  listPresets,
  PRESETS,
  start,
};
