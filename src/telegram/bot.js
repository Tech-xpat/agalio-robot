const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN } = require('../config');
const { getConfig, applyLocal, applyPreset, listPresets } = require('../live/liveConfig');
const positions = require('../trading/positions');
const scanner = require('../scanner/scanner');
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

  if (c.paused) {
    return {
      key: 'paused',
      text: `⏸  PAUSED\nBot is stopped. Press Start to resume.`,
    };
  }
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
    text: `🔍  SCANNING\nMode ${c.riskProfile.toUpperCase()} · next scan ~${sc.nextInSec}s\n$${c.sizeUsd} · every ${c.scanIntervalMin}m · max ${c.maxTradesDay}/day`,
  };
}

function statusText() {
  const c = getConfig();
  const open = positions.listOpen();
  const { daily } = positions.stats();
  const sc = scanner.status();
  const riskLabel =
    c.riskProfile === 'easy'
      ? '🟢 Easy'
      : c.riskProfile === 'hard'
        ? '🔴 Hard'
        : '🟡 Medium';
  return [
    DRY_RUN ? '🧪 DRY RUN' : '🔴 LIVE',
    c.paused ? '⏸ PAUSED' : '🟢 RUNNING',
    `Risk: ${riskLabel}`,
    '',
    `Size: $${c.sizeUsd} · TP +${c.takeProfitPct}% · SL −${c.stopLossPct}%`,
    `Max hold: ${c.maxHoldMin}m · Scan every ${c.scanIntervalMin}m`,
    `Trades today: ${daily.tradesToday || 0}/${c.maxTradesDay}`,
    `Open: ${open.length} · Next scan ~${sc.nextInSec}s`,
  ].join('\n');
}

function pnlText() {
  const open = positions.listOpen();
  const { daily, history, balanceKind } = positions.stats();
  const lines = [];
  lines.push(DRY_RUN ? '🧪 PAPER MODE (numbers are price-based)' : '🔴 LIVE (numbers read from the chain)');
  if (open.length) {
    lines.push('', 'Open:');
    for (const p of open) {
      const pnl = p.lastPnl == null ? 'no price yet' : `${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}% (est.)`;
      const held = Math.round((Date.now() - p.openedAt) / 1000);
      const tag = p.status === 'stuck' ? ' ⚠️ SELL STUCK' : p.status === 'selling' ? ' selling…' : '';
      lines.push(
        `${p.mint.slice(0, 6)}…${p.mint.slice(-4)} · ${p.sizeSol.toFixed(4)} SOL · ${pnl} · ${held}s${tag}`
      );
      if (p.buySig) lines.push(`  https://solscan.io/tx/${p.buySig}`);
    }
  } else {
    lines.push('', 'No open positions');
  }
  lines.push('', `Today realized: ${daily.realizedSol >= 0 ? '+' : ''}${(daily.realizedSol || 0).toFixed(4)} SOL`);
  lines.push(`Trades today: ${daily.tradesToday || 0}`);
  if (balanceKind === 'paper' && daily.paperBalanceSol != null) {
    lines.push(`Paper balance: ${daily.paperBalanceSol.toFixed(4)} SOL`);
  }
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
    `Profile: ${c.riskProfile.toUpperCase()}`,
    `Size $${c.sizeUsd} · TP +${c.takeProfitPct}% · SL −${c.stopLossPct}% · hold ${c.maxHoldMin}m`,
    `Scan interval ${c.scanIntervalMin}m · next ~${sc.nextInSec}s`,
    `Trades today ${daily.tradesToday || 0}/${c.maxTradesDay}`,
    `Realized today: ${daily.realizedSol >= 0 ? '+' : ''}${(daily.realizedSol || 0).toFixed(4)} SOL`,
    '',
  ];
  if (open.length) {
    lines.push('OPEN POSITIONS:');
    for (const p of open) {
      const pnl = p.lastPnl == null ? '…' : `${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}%`;
      const held = Math.round((Date.now() - p.openedAt) / 1000);
      lines.push(`• ${p.mint.slice(0, 8)}… ${pnl} · held ${held}s · status ${p.status}`);
      lines.push(`  cost ${p.sizeSol.toFixed(4)} SOL · ${p.fillSource}`);
      if (p.buySig) lines.push(`  tx ${p.buySig.slice(0, 16)}…`);
    }
  } else {
    lines.push('No open positions — scanner hunting.');
  }
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
        { text: '💼 Balance', callback_data: 'bal' },
      ],
      [{ text: '🔥 Sell All', callback_data: 'sellall' }],
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
      await bot.editMessageText(text, {
        chat_id: TELEGRAM_CHAT_ID,
        message_id: statusMsgId,
      });
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
      bot.sendMessage(
        msg.chat.id,
        `Current risk: *${getConfig().riskProfile}*\n\nChoose a preset:\n\n${lines.join('\n\n')}`,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
      );
      return;
    }
    const cfg = applyPreset(name);
    if (!cfg) {
      bot.sendMessage(msg.chat.id, 'Unknown preset. Use: /risk easy | medium | hard');
      return;
    }
    bot.sendMessage(msg.chat.id, `✅ Risk set to *${cfg.riskProfile}*\n\n${statusText()}`, {
      parse_mode: 'Markdown',
      reply_markup: mainKeyboard(),
    });
    refreshLiveStatus(true);
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
        const c = getConfig();
        applyLocal({ paused: !c.paused });
        await bot.answerCallbackQuery(q.id, { text: getConfig().paused ? 'Paused' : 'Running' });
        await bot.editMessageText(statusText(), {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: mainKeyboard(),
        });
        refreshLiveStatus(true);
      } else if (data === 'risk_easy' || data === 'risk_medium' || data === 'risk_hard') {
        const name = data.replace('risk_', '');
        applyPreset(name);
        await bot.answerCallbackQuery(q.id, { text: `Set ${name}` });
        await bot.editMessageText(statusText(), {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: mainKeyboard(),
        });
        refreshLiveStatus(true);
      } else if (data === 'report' || data === 'refresh_report') {
        await bot.answerCallbackQuery(q.id, { text: 'Refreshed' });
        try {
          await bot.editMessageText(reportText(), {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            reply_markup: reportKeyboard(),
          });
        } catch (e) {
          if (!/message is not modified/i.test(e.message)) {
            await bot.sendMessage(q.message.chat.id, reportText(), { reply_markup: reportKeyboard() });
          }
        }
      } else if (data === 'menu') {
        await bot.answerCallbackQuery(q.id);
        await bot.editMessageText(statusText(), {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: mainKeyboard(),
        });
      } else if (data === 'pos') {
        await bot.answerCallbackQuery(q.id);
        await bot.sendMessage(q.message.chat.id, pnlText(), { reply_markup: mainKeyboard() });
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
      try {
        await bot.answerCallbackQuery(q.id, { text: 'Error' });
      } catch (_) {}
    }
  });
}

function notify(text) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  bot.sendMessage(TELEGRAM_CHAT_ID, text).catch(() => {});
}

module.exports = { start, notify };
