const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN } = require('../config');
const {
  getConfig,
  applyLocal,
  applyPreset,
  applyCustom,
  listPresets,
} = require('../live/liveConfig');
const positions = require('../trading/positions');
const scanner = require('../scanner/scanner');
const memory = require('../learning/memory');
const { getSolBalance, loadWallet } = require('../solana/wallet');

let bot;
let statusMsgId = null;
let lastStatusKey = '';

function allowed(chatId) {
  if (!TELEGRAM_CHAT_ID) return false;
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

function liveStatusLine() {
  const c = getConfig();
  const open = positions.listOpen();
  const sc = scanner.status();
  if (c.paused) return { key: 'paused', text: '⏸  PAUSED\nBot is stopped. Press Start to resume.' };
  if (open.length > 0) {
    const p = open[0];
    const pnl = p.lastPnl != null ? ` · PnL ${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}%` : '';
    const held = Math.round((Date.now() - p.openedAt) / 1000);
    return {
      key: `trade:${open.length}:${Math.floor(held / 10)}`,
      text: `🟢  IN TRADE\n${p.mint.slice(0, 6)}…${p.mint.slice(-4)}${pnl}\nheld ${held}s / max ${c.maxHoldMin * 60}s\nTP +${c.takeProfitPct}% · SL −${c.stopLossPct}%`,
    };
  }
  return {
    key: `scan:${c.riskProfile}:${sc.nextInSec}`,
    text: `🔍  SCANNING\nMode ${String(c.riskProfile).toUpperCase()} · next ~${sc.nextInSec}s\n$${c.sizeUsd} · age≥${sc.minAgeDays || 10}d rising · max ${c.maxTradesDay}/day`,
  };
}

function statusText() {
  const c = getConfig();
  const open = positions.listOpen();
  const { daily } = positions.stats();
  const sc = scanner.status();
  const riskLabel =
    c.riskProfile === 'easy' ? '🟢 Easy' : c.riskProfile === 'hard' ? '🔴 Hard' : c.riskProfile === 'custom' ? '⚙️ Custom' : '🟡 Medium';
  return [
    DRY_RUN ? '🧪 DRY RUN' : '🔴 LIVE',
    c.paused ? '⏸ PAUSED' : '🟢 RUNNING',
    `Risk: ${riskLabel}`,
    '',
    `Size: $${c.sizeUsd} · TP +${c.takeProfitPct}% · SL −${c.stopLossPct}%`,
    `Max hold: ${c.maxHoldMin}m · Scan every ${c.scanIntervalMin}m`,
    `Filter: age ≥ ${sc.minAgeDays || 10}d + rising`,
    `Trades today: ${daily.tradesToday || 0}/${c.maxTradesDay}`,
    `Open: ${open.length} · Next scan ~${sc.nextInSec}s`,
  ].join('\n');
}

function pnlText() {
  const open = positions.listOpen();
  const { daily, history, balanceKind } = positions.stats();
  const lines = [DRY_RUN ? '🧪 PAPER MODE' : '🔴 LIVE (chain-read fills)'];
  if (open.length) {
    lines.push('', 'Open:');
    for (const p of open) {
      const pnl = p.lastPnl == null ? 'no price yet' : `${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}% (est.)`;
      const held = Math.round((Date.now() - p.openedAt) / 1000);
      const tag = p.status === 'stuck' ? ' ⚠️ SELL STUCK' : p.status === 'selling' ? ' selling…' : '';
      lines.push(`${p.mint.slice(0, 6)}…${p.mint.slice(-4)} · ${p.sizeSol.toFixed(4)} SOL · ${pnl} · ${held}s${tag}`);
      if (p.buySig) lines.push(`  https://solscan.io/tx/${p.buySig}`);
    }
  } else lines.push('', 'No open positions');
  lines.push('', `Today realized: ${daily.realizedSol >= 0 ? '+' : ''}${(daily.realizedSol || 0).toFixed(4)} SOL`);
  lines.push(`Trades today: ${daily.tradesToday || 0}`);
  if (balanceKind === 'paper' && daily.paperBalanceSol != null) lines.push(`Paper balance: ${daily.paperBalanceSol.toFixed(4)} SOL`);
  const last = history.slice(0, 8);
  if (last.length) {
    lines.push('', 'Last trades:');
    for (const h of last) {
      const r = h.realizedSol == null ? '?' : `${h.realizedSol >= 0 ? '+' : ''}${h.realizedSol.toFixed(4)} SOL (${(h.pct || 0).toFixed(1)}%)`;
      lines.push(`${h.mint.slice(0, 6)}… ${h.reason} ${r}`);
    }
  }
  return lines.join('\n');
}

function reportText() {
  const c = getConfig();
  const open = positions.listOpen();
  const { daily, history } = positions.stats();
  const sc = scanner.status();
  const lines = [
    '📊 LIVE REPORT',
    DRY_RUN ? 'Mode: PAPER' : 'Mode: LIVE',
    `Profile: ${String(c.riskProfile).toUpperCase()}`,
    `Size $${c.sizeUsd} · TP +${c.takeProfitPct}% · SL −${c.stopLossPct}% · hold ${c.maxHoldMin}m`,
    `Scan every ${c.scanIntervalMin}m · next ~${sc.nextInSec}s`,
    `Filter: survived ≥${sc.minAgeDays || 10} days + rising`,
    `Trades today ${daily.tradesToday || 0}/${c.maxTradesDay}`,
    `Realized today: ${daily.realizedSol >= 0 ? '+' : ''}${(daily.realizedSol || 0).toFixed(4)} SOL`,
    '',
  ];
  if (open.length) {
    lines.push('OPEN POSITIONS:');
    for (const p of open) {
      const pnl = p.lastPnl == null ? '…' : `${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}%`;
      const held = Math.round((Date.now() - p.openedAt) / 1000);
      lines.push(`• ${p.mint.slice(0, 8)}… ${pnl} · held ${held}s · ${p.status}`);
      lines.push(`  cost ${p.sizeSol.toFixed(4)} SOL · ${p.fillSource}`);
    }
  } else lines.push('No open positions — scanner hunting.');
  if (history.length) {
    lines.push('', 'RECENT CLOSED:');
    for (const h of history.slice(0, 5)) {
      const r = h.realizedSol == null ? '?' : `${h.realizedSol >= 0 ? '+' : ''}${h.realizedSol.toFixed(4)} SOL`;
      lines.push(`• ${h.mint.slice(0, 6)}… ${h.reason} ${r}`);
    }
  }
  lines.push('', `Updated: ${new Date().toISOString().slice(11, 19)} UTC`);
  return lines.join('\n');
}

function helpText() {
  return [
    'Commands:',
    '/menu · /report · /pnl',
    '/review · /advice (self-learning)',
    '/risk easy|medium|hard',
    '/custom size=5 tp=40 sl=25 hold=8 scan=15 max=10',
    '/setsize · /settp · /setsl · /sethold · /setscan · /setmaxtrades',
    '/pause · /resume · /sellall · /balance',
  ].join('\n');
}

function mainKeyboard() {
  const c = getConfig();
  return {
    inline_keyboard: [
      [{ text: c.paused ? '▶️ Start' : '⏸ Pause', callback_data: 'toggle_pause' }],
      [
        { text: '🟢 Easy', callback_data: 'risk_easy' },
        { text: '🟡 Medium', callback_data: 'risk_medium' },
        { text: '🔴 Hard', callback_data: 'risk_hard' },
      ],
      [
        { text: '📊 Report', callback_data: 'report' },
        { text: '🔄 Refresh', callback_data: 'refresh_report' },
      ],
      [
        { text: '📈 Positions', callback_data: 'pos' },
        { text: '📚 Advice', callback_data: 'advice' },
      ],
      [
        { text: '💼 Balance', callback_data: 'bal' },
        { text: '🔥 Sell All', callback_data: 'sellall' },
      ],
    ],
  };
}

function reportKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔄 Refresh Report', callback_data: 'refresh_report' }],
      [{ text: '« Menu', callback_data: 'menu' }],
    ],
  };
}

async function refreshLiveStatus(force = false) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const { key, text } = liveStatusLine();
  if (!force && key === lastStatusKey) return;
  lastStatusKey = key;
  try {
    if (statusMsgId) {
      await bot.editMessageText(text, { chat_id: TELEGRAM_CHAT_ID, message_id: statusMsgId });
    } else {
      const sent = await bot.sendMessage(TELEGRAM_CHAT_ID, text);
      statusMsgId = sent.message_id;
    }
  } catch (err) {
    if (/message to edit not found|message is not modified|MESSAGE_ID_INVALID/i.test(err.message)) {
      try {
        const sent = await bot.sendMessage(TELEGRAM_CHAT_ID, text);
        statusMsgId = sent.message_id;
      } catch (_) {}
    }
  }
}

function parseCustomArgs(text) {
  const params = {};
  const map = {
    size: 'sizeUsd', sizeusd: 'sizeUsd', tp: 'takeProfitPct', takeprofit: 'takeProfitPct',
    sl: 'stopLossPct', stoploss: 'stopLossPct', hold: 'maxHoldMin', maxhold: 'maxHoldMin',
    scan: 'scanIntervalMin', interval: 'scanIntervalMin', max: 'maxTradesDay', maxtrades: 'maxTradesDay',
  };
  const re = /(\w+)=([\d.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = map[m[1].toLowerCase()];
    if (key) params[key] = Number(m[2]);
  }
  return params;
}

function start() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[telegram] disabled (no token)');
    return;
  }
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('[telegram] polling');
  setTimeout(() => refreshLiveStatus(true), 2000);
  setInterval(() => refreshLiveStatus(), 15000);

  bot.onText(/\/(start|menu|status)/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    bot.sendMessage(msg.chat.id, statusText(), { reply_markup: mainKeyboard() });
  });
  bot.onText(/\/help/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    bot.sendMessage(msg.chat.id, helpText());
  });
  bot.onText(/\/report/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    bot.sendMessage(msg.chat.id, reportText(), { reply_markup: reportKeyboard() });
  });
  bot.onText(/\/risk(?:\s+(easy|medium|hard|high))?/i, (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    let name = (m[1] || '').toLowerCase();
    if (name === 'high') name = 'hard';
    if (!name) {
      const lines = listPresets().map((p) => `• *${p.name}* (\`/risk ${p.key}\`)\n  ${p.summary}`);
      bot.sendMessage(msg.chat.id, `Current: *${getConfig().riskProfile}*\n\n${lines.join('\n\n')}\n\nOr: /custom size=5 tp=40 sl=25 hold=8`, {
        parse_mode: 'Markdown', reply_markup: mainKeyboard(),
      });
      return;
    }
    const cfg = applyPreset(name);
    if (!cfg) return bot.sendMessage(msg.chat.id, 'Use: /risk easy | medium | hard');
    bot.sendMessage(msg.chat.id, `✅ Risk → *${cfg.riskProfile}*\n\n${statusText()}`, {
      parse_mode: 'Markdown', reply_markup: mainKeyboard(),
    });
    refreshLiveStatus(true);
  });
  bot.onText(/\/custom\b(.*)/i, (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    const params = parseCustomArgs(m[1] || '');
    if (!Object.keys(params).length) {
      return bot.sendMessage(msg.chat.id, 'Usage:\n/custom size=5 tp=40 sl=25 hold=8 scan=15 max=10');
    }
    applyCustom(params);
    bot.sendMessage(msg.chat.id, `✅ Custom entry set\n\n${statusText()}`, { reply_markup: mainKeyboard() });
    refreshLiveStatus(true);
  });
  bot.onText(/\/setsize\s+([\d.]+)/i, (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    applyCustom({ sizeUsd: Number(m[1]) });
    bot.sendMessage(msg.chat.id, `Size → $${m[1]} (custom)`);
    refreshLiveStatus(true);
  });
  bot.onText(/\/settp\s+([\d.]+)/i, (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    applyCustom({ takeProfitPct: Number(m[1]) });
    bot.sendMessage(msg.chat.id, `TP → +${m[1]}% (custom)`);
  });
  bot.onText(/\/setsl\s+([\d.]+)/i, (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    applyCustom({ stopLossPct: Number(m[1]) });
    bot.sendMessage(msg.chat.id, `SL → −${m[1]}% (custom)`);
  });
  bot.onText(/\/sethold\s+([\d.]+)/i, (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    applyCustom({ maxHoldMin: Number(m[1]) });
    bot.sendMessage(msg.chat.id, `Max hold → ${m[1]}m (custom)`);
  });
  bot.onText(/\/setscan\s+([\d.]+)/i, (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    applyCustom({ scanIntervalMin: Number(m[1]) });
    bot.sendMessage(msg.chat.id, `Scan interval → ${m[1]}m (custom)`);
    refreshLiveStatus(true);
  });
  bot.onText(/\/setmaxtrades\s+(\d+)/i, (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    applyCustom({ maxTradesDay: Number(m[1]) });
    bot.sendMessage(msg.chat.id, `Max trades/day → ${m[1]} (custom)`);
  });
  bot.onText(/\/(pause|stoptrading)/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    applyLocal({ paused: true });
    bot.sendMessage(msg.chat.id, 'Paused');
    refreshLiveStatus(true);
  });
  bot.onText(/\/(resume|starttrading)/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    applyLocal({ paused: false });
    bot.sendMessage(msg.chat.id, 'Running');
    refreshLiveStatus(true);
  });
  bot.onText(/\/pnl/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    bot.sendMessage(msg.chat.id, pnlText(), { reply_markup: mainKeyboard() });
  });
  bot.onText(/\/review(?:\s+(\d+))?/i, async (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    const days = m[1] ? Math.min(90, Number(m[1])) : 7;
    try {
      const { text, n } = await memory.review({ days });
      bot.sendMessage(msg.chat.id, n ? text : text + '\n\n(No rows yet — run trade_log SQL in Supabase, close a few trades.)');
    } catch (e) {
      bot.sendMessage(msg.chat.id, `Review error: ${e.message}`);
    }
  });
  bot.onText(/\/(advice|learn)/i, async (msg) => {
    if (!allowed(msg.chat.id)) return;
    try {
      const { text, n } = await memory.advice();
      bot.sendMessage(msg.chat.id, n ? text : 'Not enough history yet.\n1) Run trade_log SQL (supabase.sql)\n2) Close several trades\n3) /advice again');
    } catch (e) {
      bot.sendMessage(msg.chat.id, `Advice error: ${e.message}`);
    }
  });
  bot.onText(/\/sellall/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    const n = positions.exitAll('manual');
    bot.sendMessage(msg.chat.id, n ? `Selling ${n} position(s)…` : 'No open positions');
  });
  bot.onText(/\/bal(?:ance)?/i, async (msg) => {
    if (!allowed(msg.chat.id)) return;
    try {
      loadWallet();
      const sol = await getSolBalance();
      bot.sendMessage(msg.chat.id, `Wallet: ${sol.toFixed(4)} SOL`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `Balance error: ${e.message}`);
    }
  });

  bot.on('callback_query', async (q) => {
    if (!allowed(q.message.chat.id)) {
      bot.answerCallbackQuery(q.id, { text: 'Unauthorized' });
      return;
    }
    const data = q.data || '';
    try {
      if (data === 'toggle_pause') {
        applyLocal({ paused: !getConfig().paused });
        await bot.answerCallbackQuery(q.id, { text: getConfig().paused ? 'Paused' : 'Running' });
        await bot.editMessageText(statusText(), { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: mainKeyboard() });
        refreshLiveStatus(true);
      } else if (data === 'risk_easy' || data === 'risk_medium' || data === 'risk_hard') {
        applyPreset(data.replace('risk_', ''));
        await bot.answerCallbackQuery(q.id, { text: `Set ${data.replace('risk_', '')}` });
        await bot.editMessageText(statusText(), { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: mainKeyboard() });
        refreshLiveStatus(true);
      } else if (data === 'report' || data === 'refresh_report') {
        await bot.answerCallbackQuery(q.id, { text: 'Refreshed' });
        try {
          await bot.editMessageText(reportText(), { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: reportKeyboard() });
        } catch (e) {
          if (!/message is not modified/i.test(e.message)) {
            await bot.sendMessage(q.message.chat.id, reportText(), { reply_markup: reportKeyboard() });
          }
        }
      } else if (data === 'menu') {
        await bot.answerCallbackQuery(q.id);
        await bot.editMessageText(statusText(), { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: mainKeyboard() });
      } else if (data === 'pos') {
        await bot.answerCallbackQuery(q.id);
        await bot.sendMessage(q.message.chat.id, pnlText(), { reply_markup: mainKeyboard() });
      } else if (data === 'advice') {
        await bot.answerCallbackQuery(q.id, { text: 'Loading…' });
        try {
          const { text, n } = await memory.advice();
          await bot.sendMessage(q.message.chat.id, n ? text : 'Not enough history yet. Close more trades.');
        } catch (e) {
          await bot.sendMessage(q.message.chat.id, `Advice error: ${e.message}`);
        }
      } else if (data === 'bal') {
        await bot.answerCallbackQuery(q.id);
        try {
          loadWallet();
          const sol = await getSolBalance();
          await bot.sendMessage(q.message.chat.id, `Wallet: ${sol.toFixed(4)} SOL`);
        } catch (e) {
          await bot.sendMessage(q.message.chat.id, `Balance error: ${e.message}`);
        }
      } else if (data === 'sellall') {
        const n = positions.exitAll('manual');
        await bot.answerCallbackQuery(q.id, { text: n ? `Selling ${n}` : 'None open' });
      } else {
        await bot.answerCallbackQuery(q.id);
      }
    } catch (e) {
      try { await bot.answerCallbackQuery(q.id, { text: 'Error' }); } catch (_) {}
    }
  });
}

function notify(text) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  bot.sendMessage(TELEGRAM_CHAT_ID, text).catch(() => {});
}

module.exports = { start, notify };
