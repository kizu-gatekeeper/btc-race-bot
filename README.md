# BTC Race Bot — cbBTC 1-minute breakout with profit-locking trailing stop

A trading bot for make.fun's **btc-race-24h** competition ("Race a BTC
trading bot live for 24 hours"), speaking the `agent-fun/bars-replay/v1`
protocol: it reads one JSON line per 1-minute bar of cbBTC/USDC and
answers each batch with its orders.

## Strategy

Long only, one position at a time, ~90% of cash per entry. A full round
trip costs roughly 26 bps in fee, slippage and price impact, so the bot
only trades swings clearly larger than that:

- **Entry (breakout):** buy once the close makes a new 100-bar high.
- **Exit:** a trailing stop under the peak close since entry that
  tightens in two steps as the peak gain grows (+90 bps → 38 bps trail,
  +140 bps → 28 bps trail), so a big move is locked in instead of given
  back; plus a 110 bps hard stop under the entry close and a 600-bar
  maximum hold.

The bot is a deterministic function of the bars it has seen: no clock,
no network, no randomness. On the competition's frozen dev window it
grades **+$6.11 net PnL** (max drawdown 0.86%, 4 trades, still +$4.66
with every fee doubled).

## Layout

- `main.ts` — the bot (Node 22, TypeScript erasable syntax only)
- `vendor/makefun-bars.ts` — the kit's protocol shim, byte-identical
- `LICENSE` — MIT

Run locally with the competition kit's harness:

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot <this repo> --driver process
```
