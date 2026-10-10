-- Run once in the Supabase SQL editor.
-- This bot only touches rows whose key starts with "degov:" and the trade_log table below.

create table if not exists public.bot_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.bot_state enable row level security;

-- Structured trade log for self-learning / daily review
create table if not exists public.trade_log (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  mode          text,
  profile       text,
  mint          text not null,
  entry_reason  text,
  exit_reason   text,
  cost_sol      double precision,
  proceeds_sol  double precision,
  realized_sol  double precision,
  pct           double precision,
  hold_sec      integer,
  age_days      double precision,
  liquidity_usd double precision,
  volume_1h     double precision,
  price_change_1h double precision,
  price_change_6h double precision,
  buys_1h       integer,
  score         double precision,
  size_usd      double precision,
  take_profit_pct double precision,
  stop_loss_pct double precision,
  max_hold_min  integer,
  buy_sig       text,
  sell_sig      text,
  meta          jsonb
);

create index if not exists trade_log_created_at_idx on public.trade_log (created_at desc);
create index if not exists trade_log_mode_idx on public.trade_log (mode);
create index if not exists trade_log_profile_idx on public.trade_log (profile);

alter table public.trade_log enable row level security;
