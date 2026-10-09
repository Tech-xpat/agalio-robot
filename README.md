# De-Government Strategy v3 — Direct Scanner

Solana meme-coin trader: **direct token scan + fixed-size real execution via PumpPortal**.
No whale wallets required. Free swaps through PumpPortal local API, free public RPCs.

## Strategy

1. Scanner pulls recent Solana tokens (DexScreener boosts + profiles + search).
2. Scores short-term chart quality (liquidity, 5m/1h change, volume).
3. Mode decides size, TP, SL, max hold, scan interval, max trades/day.
4. Buys via PumpPortal (`pool: auto`). Reads exact fill from the chain.
5. Exits on take-profit, stop-loss, or max hold. Sells escalate slippage on retry.
6. Positions persist (Supabase or local file). Restart resumes open trades.

## Modes

| Mode   | Size | TP    | SL    | Max hold | Scan every | Max trades/day |
|--------|------|-------|-------|----------|------------|----------------|
| Easy   | $2   | +30%  | −20%  | 2 min    | 5 min      | 7              |
| Medium | $5   | +60%  | −30%  | 5 min    | 10 min     | 15             |
| Hard   | $7   | +100% | −45%  | 8 min    | 30 min     | 20             |

## Quick start

```bash
cp .env.example .env
# set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# set WALLET_PRIVATE_KEY only when going live
npm install
npm start
```

Go live: `DRY_RUN=false`, dedicated wallet, small size first.

## Telegram

`/menu` · `/risk easy|medium|hard` · `/report` (refresh button) · `/pnl` · `/sellall` · `/pause` · `/resume` · `/balance`

Buttons: Start/Pause · Easy/Medium/Hard · Report + Refresh · Positions · Balance · Sell All
