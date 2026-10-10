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
  if (c.paused) return { key: 'paused', text: '⏸  PAUSED\nBot is stopped. Open menu → Start.' };
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
    text: `🔍  SCANNING\n${String(c.riskProfile).toUpperCase()} · $${c.sizeUsd} · next ~${sc.nextInSec}s\nage≥${sc.minAgeDays || 10}d rising · max ${c.maxTradesDay}/day`,
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
        : c.riskProfile === 'custom'
          ? '⚙️ Custom'
          : '🟡 Medium';
  return [
    DRY_RUN ? '🧪 PAPER' : '🔴 LIVE',
    c.paused ? '⏸ PAUSED' : '🟢 RUNNING',
    `Mode: ${riskLabel}`,
    '',
    `$${c.sizeUsd} · TP +${c.takeProfitPct}% · SL −${c.stopLossPct}%`,
    `Hold ${c.maxHoldMin}m · Scan ${c.scanIntervalMin}m · Max ${c.maxTradesDay}/day`,
    `Age ≥ ${sc.minAgeDays || 10}d + rising`,
    `Today: ${daily.tradesToday || 0}/${c.maxTradesDay} trades · open ${open.length}`,
    `Next scan ~${sc.nextInSec}s`,
  ].join('\n');
}

function pnlText() {
  const open = positions.listOpen();
  const { daily, history, balanceKind } = positions.stats();
  const lines = [DRY_RUN ? '🧪 PAPER PnL' : '🔴 LIVE PnL'];
  if (open.length) {
    lines.push('', 'Open:');
    for (const p of open) {
      const pnl = p.lastPnl == null ? 'no price' : `${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}%`;
      const held = Math.round((Date.now() - p.openedAt) / 1000);
      const tag = p.status === 'stuck' ? ' ⚠️ STUCK' : p.status === 'selling' ? ' selling…' : '';
      lines.push(`${p.mint.slice(0, 6)}… · ${p.sizeSol.toFixed(4)} SOL · ${pnl} · ${held}s${tag}`);
    }
  } else {
    lines.push('', 'No open positions');
  }
  lines.push('', `Today: ${daily.realizedSol >= 0 ? '+' : ''}${(daily.realizedSol || 0).toFixed(4)} SOL`, `Trades: ${daily.tradesToday || 0}`);
  if (balanceKind === 'paper' && daily.paperBalanceSol != null) {
    lines.push(`Paper bal: ${daily.paperBalanceSol.toFixed(4)} SOL`);
  }
  const last = history.slice(0, 6);
  if (last.length) {
    lines.push('', 'Recent:');
    for (const h of last) {
      const r = h.realizedSol == null ? '?' : `${h.realizedSol >= 0 ? '+' : ''}${h.realizedSol.toFixed(4)} SOL`;
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
    '📊 REPORT',
    DRY_RUN ? 'PAPER' : 'LIVE',
    `${String(c.riskProfile).toUpperCase()} · $${c.sizeUsd} · TP+${c.takeProfitPct}% · SL−${c.stopLossPct}%`,
    `Hold ${c.maxHoldMin}m · Scan ${c.scanIntervalMin}m · next ~${sc.nextInSec}s`,
    `Today ${daily.tradesToday || 0}/${c.maxTradesDay} · ${daily.realizedSol >= 0 ? '+' : ''}${(daily.realizedSol || 0).toFixed(4)} SOL`,
    '',
  ];
  if (open.length) {
    lines.push('OPEN:');
    for (const p of open) {
      const pnl = p.lastPnl == null ? '…' : `${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}%`;
      lines.push(`• ${p.mint.slice(0, 8)}… ${pnl} · ${p.status}`);
    }
  } else {
    lines.push('No open positions.');
  }
  if (history.length) {
    lines.push('', 'CLOSED:');
    for (const h of history.slice(0, 5)) {
      const r = h.realizedSol == null ? '?' : `${h.realizedSol >= 0 ? '+' : ''}${h.realizedSol.toFixed(4)} SOL`;
      lines.push(`• ${h.mint.slice(0, 6)}… ${h.reason} ${r}`);
    }
  }
  lines.push('', `${new Date().toISOString().slice(11, 19)} UTC`);
  return lines.join('\n');
}

function settingsText() {
  const c = getConfig();
  return [
    '⚙️ SETTINGS',
    `Profile: ${String(c.riskProfile).toUpperCase()}`,
    '',
    `Size: $${c.sizeUsd}`,
    `Take profit: +${c.takeProfitPct}%`,
    `Stop loss: −${c.stopLossPct}%`,
    `Max hold: ${c.maxHoldMin} min`,
    `Scan every: ${c.scanIntervalMin} min`,
    `Max trades/day: ${c.maxTradesDay}`,
    '',
    'Tap a row to adjust.',
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
        { text: '⚙️ Settings', callback_data: 'nav_settings' },
        { text: '📁 Activity', callback_data: 'nav_activity' },
      ],
      [{ text: '🔥 Sell All', callback_data: 'sellall' }],
    ],
  };
}

function settingsKeyboard() {
  const c = getConfig();
  return {
    inline_keyboard: [
      [
        { text: `💵 Size $${c.sizeUsd}`, callback_data: 'edit_size' },
        { text: `🎯 TP +${c.takeProfitPct}%`, callback_data: 'edit_tp' },
      ],
      [
        { text: `🛡 SL −${c.stopLossPct}%`, callback_data: 'edit_sl' },
        { text: `⏱ Hold ${c.maxHoldMin}m`, callback_data: 'edit_hold' },
      ],
      [
        { text: `📡 Scan ${c.scanIntervalMin}m`, callback_data: 'edit_scan' },
        { text: `#️⃣ Max ${c.maxTradesDay}/d`, callback_data: 'edit_max' },
      ],
      [{ text: '« Main menu', callback_data: 'nav_main' }],
    ],
  };
}

function activityKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Report', callback_data: 'act_report' },
        { text: '📈 PnL', callback_data: 'act_pnl' },
      ],
      [
        { text: '📚 Advice', callback_data: 'act_advice' },
        { text: '📅 Review', callback_data: 'act_review' },
      ],
      [{ text: '💼 Balance', callback_data: 'act_bal' }],
      [{ text: '« Main menu', callback_data: 'nav_main' }],
    ],
  };
}

function adjustKeyboard(field) {
  const steps = {
    size: [
      { t: '−2', d: 'adj_size_-2' },
      { t: '−1', d: 'adj_size_-1' },
      { t: '+1', d: 'adj_size_1' },
      { t: '+2', d: 'adj_size_2' },
      { t: '+5', d: 'adj_size_5' },
    ],
    tp: [
      { t: '−10', d: 'adj_tp_-10' },
      { t: '−5', d: 'adj_tp_-5' },
      { t: '+5', d: 'adj_tp_5' },
      { t: '+10', d: 'adj_tp_10' },
      { t: '+20', d: 'adj_tp_20' },
    ],
    sl: [
      { t: '−10', d: 'adj_sl_-10' },
      { t: '−5', d: 'adj_sl_-5' },
      { t: '+5', d: 'adj_sl_5' },
      { t: '+10', d: 'adj_sl_10' },
    ],
    hold: [
      { t: '−5', d: 'adj_hold_-5' },
      { t: '−1', d: 'adj_hold_-1' },
      { t: '+1', d: 'adj_hold_1' },
      { t: '+5', d: 'adj_hold_5' },
      { t: '+10', d: 'adj_hold_10' },
    ],
    scan: [
      { t: '−10', d: 'adj_scan_-10' },
      { t: '−5', d: 'adj_scan_-5' },
      { t: '+5', d: 'adj_scan_5' },
      { t: '+10', d: 'adj_scan_10' },
      { t: '+15', d: 'adj_scan_15' },
    ],
    max: [
      { t: '−5', d: 'adj_max_-5' },
      { t: '−1', d: 'adj_max_-1' },
      { t: '+1', d: 'adj_max_1' },
      { t: '+5', d: 'adj_max_5' },
    ],
  };
  const row = (steps[field] || []).map((s) => ({ text: s.t, callback_data: s.d }));
  return {
    inline_keyboard: [
      row,
      [
        { text: '« Settings', callback_data: 'nav_settings' },
        { text: '« Menu', callback_data: 'nav_main' },
      ],
    ],
  };
}

function fieldLabel(field) {
  const c = getConfig();
  const map = {
    size: `💵 Trade size: $${c.sizeUsd}`,
    tp: `🎯 Take profit: +${c.takeProfitPct}%`,
    sl: `🛡 Stop loss: −${c.stopLossPct}%`,
    hold: `⏱ Max hold: ${c.maxHoldMin} min`,
    scan: `📡 Scan interval: ${c.scanIntervalMin} min`,
    max: `#️⃣ Max trades/day: ${c.maxTradesDay}`,
  };
  return map[field] || field;
}

function applyAdjust(field, delta) {
  const c = getConfig();
  const patch = {};
  if (field === 'size') patch.sizeUsd = Math.max(1, Math.min(50, Number(c.sizeUsd) + delta));
  else if (field === 'tp') patch.takeProfitPct = Math.max(5, Math.min(300, Number(c.takeProfitPct) + delta));
  else if (field === 'sl') patch.stopLossPct = Math.max(5, Math.min(90, Number(c.stopLossPct) + delta));
  else if (field === 'hold') patch.maxHoldMin = Math.max(1, Math.min(120, Number(c.maxHoldMin) + delta));
  else if (field === 'scan') patch.scanIntervalMin = Math.max(1, Math.min(120, Number(c.scanIntervalMin) + delta));
  else if (field === 'max') patch.maxTradesDay = Math.max(1, Math.min(50, Number(c.maxTradesDay) + delta));
  applyCustom(patch);
  return getConfig();
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

async function editOrSend(q, text, keyboard) {
  try {
    await bot.editMessageText(text, {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      reply_markup: keyboard,
    });
  } catch (e) {
    if (!/message is not modified/i.test(e.message)) {
      await bot.sendMessage(q.message.chat.id, text, { reply_markup: keyboard });
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

  bot.onText(/\/(start|menu|status|help)/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    bot.sendMessage(msg.chat.id, statusText(), { reply_markup: mainKeyboard() });
  });

  bot.on('callback_query', async (q) => {
    if (!allowed(q.message.chat.id)) {
      bot.answerCallbackQuery(q.id, { text: 'Unauthorized' });
      return;
    }
    const data = q.data || '';
    try {
      if (data === 'nav_main') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, statusText(), mainKeyboard());
        return;
      }
      if (data === 'nav_settings') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, settingsText(), settingsKeyboard());
        return;
      }
      if (data === 'nav_activity') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, '📁 ACTIVITY\nReport · PnL · Advice · Review · Balance', activityKeyboard());
        return;
      }
      if (data === 'toggle_pause') {
        applyLocal({ paused: !getConfig().paused });
        await bot.answerCallbackQuery(q.id, { text: getConfig().paused ? 'Paused' : 'Running' });
        await editOrSend(q, statusText(), mainKeyboard());
        refreshLiveStatus(true);
        return;
      }
      if (data === 'risk_easy' || data === 'risk_medium' || data === 'risk_hard') {
        applyPreset(data.replace('risk_', ''));
        await bot.answerCallbackQuery(q.id, { text: `Mode: ${data.replace('risk_', '')}` });
        await editOrSend(q, statusText(), mainKeyboard());
        refreshLiveStatus(true);
        return;
      }
      if (data === 'edit_size') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, fieldLabel('size') + '\n\nAdjust amount ($):', adjustKeyboard('size'));
        return;
      }
      if (data === 'edit_tp') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, fieldLabel('tp') + '\n\nAdjust take-profit %:', adjustKeyboard('tp'));
        return;
      }
      if (data === 'edit_sl') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, fieldLabel('sl') + '\n\nAdjust stop-loss %:', adjustKeyboard('sl'));
        return;
      }
      if (data === 'edit_hold') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, fieldLabel('hold') + '\n\nAdjust max hold (minutes):', adjustKeyboard('hold'));
        return;
      }
      if (data === 'edit_scan') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, fieldLabel('scan') + '\n\nAdjust scan interval (minutes):', adjustKeyboard('scan'));
        return;
      }
      if (data === 'edit_max') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, fieldLabel('max') + '\n\nAdjust max trades per day:', adjustKeyboard('max'));
        return;
      }
      if (data.startsWith('adj_')) {
        const parts = data.split('_');
        const field = parts[1];
        const delta = Number(parts[2]);
        if (!Number.isFinite(delta)) {
          await bot.answerCallbackQuery(q.id, { text: 'Bad value' });
          return;
        }
        applyAdjust(field, delta);
        await bot.answerCallbackQuery(q.id, { text: 'Updated' });
        await editOrSend(q, fieldLabel(field) + '\n\nAdjust again or go back.', adjustKeyboard(field));
        refreshLiveStatus(true);
        return;
      }
      if (data === 'act_report') {
        await bot.answerCallbackQuery(q.id, { text: 'Report' });
        await editOrSend(q, reportText(), {
          inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'act_report' }],
            [{ text: '« Activity', callback_data: 'nav_activity' }],
          ],
        });
        return;
      }
      if (data === 'act_pnl') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, pnlText(), {
          inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'act_pnl' }],
            [{ text: '« Activity', callback_data: 'nav_activity' }],
          ],
        });
        return;
      }
      if (data === 'act_advice') {
        await bot.answerCallbackQuery(q.id, { text: 'Loading…' });
        try {
          const { text, n } = await memory.advice();
          await editOrSend(q, n ? text : 'Not enough history yet.\nClose more trades, then open Advice again.', {
            inline_keyboard: [
              [{ text: '🔄 Refresh', callback_data: 'act_advice' }],
              [{ text: '« Activity', callback_data: 'nav_activity' }],
            ],
          });
        } catch (e) {
          await editOrSend(q, `Advice error: ${e.message}`, activityKeyboard());
        }
        return;
      }
      if (data === 'act_review') {
        await bot.answerCallbackQuery(q.id, { text: 'Loading…' });
        try {
          const { text, n } = await memory.review({ days: 7 });
          await editOrSend(q, n ? text : text + '\n\n(No trade_log rows yet.)', {
            inline_keyboard: [
              [{ text: '🔄 Refresh', callback_data: 'act_review' }],
              [{ text: '« Activity', callback_data: 'nav_activity' }],
            ],
          });
        } catch (e) {
          await editOrSend(q, `Review error: ${e.message}`, activityKeyboard());
        }
        return;
      }
      if (data === 'act_bal') {
        await bot.answerCallbackQuery(q.id);
        try {
          loadWallet();
          const sol = await getSolBalance();
          await editOrSend(q, `💼 Wallet\n${sol.toFixed(4)} SOL`, {
            inline_keyboard: [
              [{ text: '🔄 Refresh', callback_data: 'act_bal' }],
              [{ text: '« Activity', callback_data: 'nav_activity' }],
            ],
          });
        } catch (e) {
          await editOrSend(q, `Balance error: ${e.message}`, activityKeyboard());
        }
        return;
      }
      if (data === 'sellall') {
        const n = positions.exitAll('manual');
        await bot.answerCallbackQuery(q.id, { text: n ? `Selling ${n}` : 'None open' });
        return;
      }
      await bot.answerCallbackQuery(q.id);
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
