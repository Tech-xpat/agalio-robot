/**
 * Self-learning trade memory.
 * Logs every closed trade (features + outcome) to Supabase trade_log when configured,
 * and keeps a local/rolling history for /review and /advice.
 */
const config = require('../config');
const logger = require('../utils/logger');
const store = require('../storage/positionsStore');

const usingSupabase = () => !!(config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY);

function headers(extra = {}) {
  const key = config.SUPABASE_SERVICE_KEY;
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key && key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

async function logTrade(row) {
  if (!usingSupabase()) return false;
  try {
    const body = {
      mode: config.DRY_RUN ? 'paper' : 'live',
      profile: row.profile || null,
      mint: row.mint,
      entry_reason: row.entryReason || null,
      exit_reason: row.exitReason || null,
      cost_sol: row.costSol ?? null,
      proceeds_sol: row.proceedsSol ?? null,
      realized_sol: row.realizedSol ?? null,
      pct: row.pct ?? null,
      hold_sec: row.holdSec ?? null,
      age_days: row.ageDays ?? null,
      liquidity_usd: row.liquidityUsd ?? null,
      volume_1h: row.volume1h ?? null,
      price_change_1h: row.priceChange1h ?? null,
      price_change_6h: row.priceChange6h ?? null,
      buys_1h: row.buys1h ?? null,
      score: row.score ?? null,
      size_usd: row.sizeUsd ?? null,
      take_profit_pct: row.takeProfitPct ?? null,
      stop_loss_pct: row.stopLossPct ?? null,
      max_hold_min: row.maxHoldMin ?? null,
      buy_sig: row.buySig || null,
      sell_sig: row.sellSig || null,
      meta: row.meta || {},
    };
    const res = await fetch(`${config.SUPABASE_URL}/rest/v1/trade_log`, {
      method: 'POST',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.warn('trade_log insert failed:', res.status, (await res.text()).slice(0, 150));
      return false;
    }
    return true;
  } catch (e) {
    logger.warn('trade_log insert error:', e.message);
    return false;
  }
}

async function fetchTrades({ limit = 100, days = 30 } = {}) {
  if (!usingSupabase()) return [];
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const url =
      `${config.SUPABASE_URL}/rest/v1/trade_log?` +
      `select=*&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=${limit}`;
    const res = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      logger.warn('trade_log fetch failed:', res.status);
      return [];
    }
    return await res.json();
  } catch (e) {
    logger.warn('trade_log fetch error:', e.message);
    return [];
  }
}

function avg(nums) {
  const a = nums.filter((n) => Number.isFinite(n));
  if (!a.length) return null;
  return a.reduce((s, n) => s + n, 0) / a.length;
}

function buildAdvice(rows) {
  if (!rows.length) {
    return {
      summary: 'No trade history yet. Run more trades so the bot can learn.',
      tips: [],
      stats: {},
    };
  }

  const norm = rows.map((r) => ({
    realized: Number(r.realized_sol ?? r.realizedSol),
    pct: Number(r.pct),
    profile: r.profile || 'unknown',
    exit: r.exit_reason || r.exitReason || '?',
    age: Number(r.age_days ?? r.ageDays),
    liq: Number(r.liquidity_usd ?? r.liquidityUsd),
    ch1h: Number(r.price_change_1h ?? r.priceChange1h),
    score: Number(r.score),
    hold: Number(r.hold_sec ?? r.holdSec),
  }));

  const known = norm.filter((r) => Number.isFinite(r.realized));
  const wins = known.filter((r) => r.realized > 0);
  const wr = known.length ? (wins.length / known.length) * 100 : null;
  const avgR = avg(known.map((r) => r.realized));
  const avgPct = avg(known.map((r) => r.pct).filter(Number.isFinite));

  const byProfile = {};
  for (const r of known) {
    const k = r.profile || 'unknown';
    if (!byProfile[k]) byProfile[k] = { n: 0, wins: 0, sum: 0 };
    byProfile[k].n += 1;
    if (r.realized > 0) byProfile[k].wins += 1;
    byProfile[k].sum += r.realized;
  }

  const byExit = {};
  for (const r of known) {
    const k = r.exit || '?';
    if (!byExit[k]) byExit[k] = { n: 0, wins: 0, sum: 0 };
    byExit[k].n += 1;
    if (r.realized > 0) byExit[k].wins += 1;
    byExit[k].sum += r.realized;
  }

  const ageBuckets = [
    { name: '10–20d', min: 10, max: 20 },
    { name: '20–40d', min: 20, max: 40 },
    { name: '40d+', min: 40, max: 9999 },
  ];
  const ageStats = ageBuckets.map((b) => {
    const set = known.filter((r) => Number.isFinite(r.age) && r.age >= b.min && r.age < b.max);
    return {
      name: b.name,
      n: set.length,
      wr: set.length ? (set.filter((r) => r.realized > 0).length / set.length) * 100 : null,
      avg: avg(set.map((r) => r.realized)),
    };
  });

  const momBuckets = [
    { name: 'ch1h 0–5%', min: 0, max: 5 },
    { name: 'ch1h 5–15%', min: 5, max: 15 },
    { name: 'ch1h 15%+', min: 15, max: 999 },
  ];
  const momStats = momBuckets.map((b) => {
    const set = known.filter((r) => Number.isFinite(r.ch1h) && r.ch1h >= b.min && r.ch1h < b.max);
    return {
      name: b.name,
      n: set.length,
      wr: set.length ? (set.filter((r) => r.realized > 0).length / set.length) * 100 : null,
      avg: avg(set.map((r) => r.realized)),
    };
  });

  const tips = [];
  const profRank = Object.entries(byProfile)
    .filter(([, v]) => v.n >= 2)
    .sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n);
  if (profRank.length) {
    const [best, v] = profRank[0];
    tips.push(
      `Profile "${best}" has best avg PnL so far (${(v.sum / v.n).toFixed(4)} SOL/trade, ${v.n} trades, WR ${((v.wins / v.n) * 100).toFixed(0)}%). Prefer it when unsure.`
    );
  }

  const ageBest = ageStats.filter((a) => a.n >= 2 && a.wr != null).sort((a, b) => (b.avg || 0) - (a.avg || 0))[0];
  if (ageBest) {
    tips.push(`Age band ${ageBest.name} looks strongest (WR ${ageBest.wr.toFixed(0)}%, n=${ageBest.n}). Favor coins in that range.`);
  }

  const momBest = momStats.filter((a) => a.n >= 2 && a.wr != null).sort((a, b) => (b.avg || 0) - (a.avg || 0))[0];
  if (momBest) {
    tips.push(`Entry momentum ${momBest.name} performed best (WR ${momBest.wr.toFixed(0)}%, n=${momBest.n}).`);
  }

  const stop = byExit['stop_loss'];
  const tp = byExit['take_profit'];
  if (stop && stop.n >= 3 && tp && tp.n >= 1) {
    tips.push(
      `Stop-loss exits: ${stop.n} times. Take-profit: ${tp.n}. If stops dominate, tighten size or raise min liquidity / age.`
    );
  }

  if (wr != null && wr < 40 && known.length >= 5) {
    tips.push('Win rate under 40% on sample — cut size, stay on Medium, or raise filter bars until WR recovers.');
  }
  if (wr != null && wr >= 55 && known.length >= 5) {
    tips.push('Win rate solid — keep current filters; scale size slowly only after another 10 green trades.');
  }

  if (!tips.length) {
    tips.push('Not enough repeated patterns yet. Keep running; advice gets sharper after ~15–20 closed trades.');
  }

  return {
    summary: known.length
      ? `${known.length} closed trades · WR ${wr != null ? wr.toFixed(0) + '%' : '?'} · avg ${avgR != null ? (avgR >= 0 ? '+' : '') + avgR.toFixed(4) + ' SOL' : '?'} · avg ${avgPct != null ? (avgPct >= 0 ? '+' : '') + avgPct.toFixed(1) + '%' : '?'}`
      : 'No trades with known PnL yet.',
    tips,
    stats: { n: known.length, wins: wins.length, wr, avgR, avgPct, byProfile, byExit, ageStats, momStats },
  };
}

function formatReview(advice, label = 'DAILY REVIEW') {
  const lines = [`📚 ${label}`, advice.summary, ''];
  const { stats } = advice;
  if (stats.byProfile && Object.keys(stats.byProfile).length) {
    lines.push('By profile:');
    for (const [k, v] of Object.entries(stats.byProfile)) {
      lines.push(`  ${k}: n=${v.n} WR=${((v.wins / v.n) * 100).toFixed(0)}% sum=${v.sum.toFixed(4)} SOL`);
    }
    lines.push('');
  }
  if (stats.ageStats) {
    lines.push('By age:');
    for (const a of stats.ageStats) {
      if (!a.n) continue;
      lines.push(`  ${a.name}: n=${a.n} WR=${a.wr != null ? a.wr.toFixed(0) + '%' : '?'} avg=${a.avg != null ? a.avg.toFixed(4) : '?'}`);
    }
    lines.push('');
  }
  if (stats.momStats) {
    lines.push('By entry ch1h:');
    for (const a of stats.momStats) {
      if (!a.n) continue;
      lines.push(`  ${a.name}: n=${a.n} WR=${a.wr != null ? a.wr.toFixed(0) + '%' : '?'} avg=${a.avg != null ? a.avg.toFixed(4) : '?'}`);
    }
    lines.push('');
  }
  lines.push('Advice:');
  advice.tips.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  return lines.join('\n');
}

async function review({ days = 7 } = {}) {
  const rows = await fetchTrades({ limit: 150, days });
  let local = [];
  try {
    const h = await store.get('state', 'history');
    if (Array.isArray(h)) local = h;
  } catch (_) {}

  const merged = rows.length
    ? rows
    : local.map((h) => ({
        realized_sol: h.realizedSol,
        pct: h.pct,
        profile: h.mode,
        exit_reason: h.reason,
        mint: h.mint,
        hold_sec: h.closedAt && h.openedAt ? Math.round((h.closedAt - h.openedAt) / 1000) : null,
        age_days: h.ageDays,
        liquidity_usd: h.liquidityUsd,
        volume_1h: h.volume1h,
        price_change_1h: h.priceChange1h,
        score: h.score,
      }));

  const advice = buildAdvice(merged);
  return { advice, text: formatReview(advice, days <= 2 ? 'DAILY REVIEW' : `${days}-DAY REVIEW`), n: merged.length };
}

async function advice() {
  const { advice: a, text, n } = await review({ days: 30 });
  return { advice: a, text: text.replace('30-DAY REVIEW', 'ADVICE FROM YOUR TRADES'), n };
}

module.exports = {
  logTrade,
  fetchTrades,
  buildAdvice,
  formatReview,
  review,
  advice,
};
