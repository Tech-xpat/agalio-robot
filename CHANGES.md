# Changelog

## v3.2.0 — Self-learning trade memory

- New Supabase table `trade_log` stores every closed trade with entry features.
- Features: age, liquidity, volume, momentum, buys, score, profile, TP/SL, hold, PnL.
- Telegram: `/review`, `/advice` (or `/learn`).
- Uses existing SUPABASE_URL + SUPABASE_SERVICE_KEY. Run the new SQL once.

## v3.1.0 — Filters + Custom Entry

- Scanner: age ≥ 10d + rising + activity filters.
- Custom entry via /custom and /set* commands.

## v3.0.0 — Direct Scanner

- Direct scanner, fixed USD modes, real chain fills.
