# Changelog

## v3.0.0 — Direct Scanner

- Removed whale-wallet tracking as entry source.
- New scanner: DexScreener boosts/profiles/search → score chart → buy.
- Modes rewritten:
  - Easy: $2, TP 30%, SL 20%, hold 2m, every 5m, max 7/day
  - Medium: $5, TP 60%, SL 30%, hold 5m, every 10m, max 15/day
  - Hard: $7, TP 100%, SL 45%, hold 8m, every 30m, max 20/day
- Fixed USD size converted live to SOL.
- Daily trade counter enforced.
- Telegram: /report + Refresh button, real open/closed status, Sell All.
- Bot active on start. Real fills still read from chain. PumpPortal swaps unchanged.
