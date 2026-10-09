/**
 * Small key/value store so open positions survive a restart or redeploy.
 *  - Supabase (REST) when SUPABASE_URL + SUPABASE_SERVICE_KEY are set (use this on Railway:
 *    its disk is wiped on every deploy)
 *  - otherwise local files in STATE_DIR
 * Keys are namespaced by mode (paper/live) and wallet, so this bot never touches another
 * bot's rows even if they share the same table (see supabase.sql).
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

const usingSupabase = () => !!(config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY);

function headers(extra = {}) {
  const key = config.SUPABASE_SERVICE_KEY;
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

function fullKey(ns, name) {
  return `degov:${config.DRY_RUN ? 'paper' : 'live'}:${ns}:${name}`;
}

function file(ns, name) {
  const safe = fullKey(ns, name).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(config.STATE_DIR, `${safe}.json`);
}

async function get(ns, name) {
  if (usingSupabase()) {
    const res = await fetch(
      `${config.SUPABASE_URL}/rest/v1/bot_state?key=eq.${encodeURIComponent(fullKey(ns, name))}&select=value`,
      { headers: headers(), signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`supabase get ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    return rows.length ? rows[0].value : null;
  }
  try {
    return JSON.parse(fs.readFileSync(file(ns, name), 'utf8'));
  } catch (_) {
    return null;
  }
}

async function set(ns, name, value) {
  if (usingSupabase()) {
    const res = await fetch(`${config.SUPABASE_URL}/rest/v1/bot_state?on_conflict=key`, {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ key: fullKey(ns, name), value, updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`supabase set ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  fs.mkdirSync(config.STATE_DIR, { recursive: true });
  fs.writeFileSync(file(ns, name), JSON.stringify(value, null, 2));
}

const chains = new Map();
function save(ns, name, snapshot, onError) {
  const k = `${ns}:${name}`;
  const prev = chains.get(k) || Promise.resolve();
  const next = prev
    .then(() => set(ns, name, snapshot()))
    .catch((e) => {
      logger.error(`store save ${name} failed:`, e.message);
      if (onError) onError(e);
    });
  chains.set(k, next);
  return next;
}

function flush() {
  return Promise.all([...chains.values()]);
}

module.exports = { get, set, save, flush, usingSupabase };
