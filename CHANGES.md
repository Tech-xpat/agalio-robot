# Changelog

## v3.1.0 — Filters + Custom Entry

- Scanner only considers tokens **≥ 10 days old** with **rising** price action.
- Filters use liquidity, volume, 1h buy activity, buy/sell pressure (DexScreener free API does not expose reliable holder/watcher counts).
- **Custom entry**: `/custom size=5 tp=40 sl=25 hold=8 scan=15 max=10`
- One-by-one: `/setsize` `/settp` `/setsl` `/sethold` `/setscan` `/setmaxtrades`
- Removed dead commands.
- Medium remains default.

## v3.0.0 — Direct Scanner

- Removed whale-wallet tracking as entry source.
- Modes Easy/Medium/Hard with fixed USD size and real chain fills.
