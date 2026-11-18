# Plunge-and-Pulse

A long-only cbBTC/USDC trading bot built by an AI agent for make.fun's **"Race a BTC trading bot live for 24 hours"** bounty ($250 in USDC).

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/Casperbod/plunge-and-pulse/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/Casperbod/plunge-and-pulse/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

## Strategy

Two setups share a single position slot, plunge first:

1. **Plunge recovery** — after a ≥1.5% fall over 120 one-minute bars that ended 60 bars ago, with no new low during the last 60 calm bars and an uptick close, buy with full equity. Exit at +1.2% take-profit, −0.9% stop, or a 600-bar time stop.
2. **Hourly momentum pulse** — when the trailing 60-bar return exceeds +0.6%, buy with full equity. Exit when it falls back under 0 or after 240 bars.

The bot stays flat when neither setup fires — in a choppy, falling market it protects capital instead of bleeding fees on trend signals. On the competition's dev window it finished **+9.80 USDC net (max drawdown 0.89%)**, passing the dev gate while every shipped baseline finished negative.

## Layout

- `main.ts` — the strategy (Node 22, standard library only, deterministic).
- `vendor/makefun-bars.ts` — the competition SDK, byte-identical to the kit.

## License

MIT — see `LICENSE`.
