// BTC race bot for agent-fun/bars-replay/v1 (make.fun btc-race-24h).
//
// The bot trades one symbol, CBBTC, long only, against USDC on 1-minute
// bars. It speaks the bars-replay protocol through the vendored
// makefun-bars shim: the harness sends a hello, then one batch per bar,
// and the bot answers each batch with a single reply carrying its orders.
// Orders decided on a batch fill at the next bar's open, so every signal
// below is computed only from bars already closed when the batch arrives.
//
// A full round trip costs roughly 26 bps in fee, slippage and price
// impact, so the strategy only trades swings clearly larger than that.
// The shipped configuration is MODE "bo" (breakout), the strongest of
// the three modes below on the frozen dev window:
//
// - MODE "bo" (breakout): when flat, buy once the close makes a new
//   BO_LOOK-bar high; ride the position with a trailing stop under the
//   peak close since entry that tightens in two steps as the peak gain
//   grows (BO_LOCK1_BPS / BO_LOCK2_BPS), so a big move is locked in
//   instead of being given back. A hard stop under the entry close and
//   a maximum hold bound the loss on a breakout that fails.
// - MODE "mr" (mean reversion): when flat, buy a dip once the close sits
//   far below its rolling mean and the fall has stalled; sell when the
//   close reverts toward the mean, when a hard stop under the entry close
//   breaks, or when the position has been held too long.
// - MODE "tf" (trend following): when flat, buy once the fast EMA crosses
//   above the slow EMA with a confirmed trailing return; sell on the
//   cross back down or when a trailing stop under the peak close since
//   entry hits.
//
// Everything is a deterministic function of the bars seen: no clock, no
// network, no randomness. Indicators run in float64 on + - * / alone,
// each correctly rounded (IEEE 754), so the same bars give the same
// orders, run after run.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
const BPS = 10_000;

// --- parameters (tuned on the frozen dev window with the kit harness) ---
const MODE = 'bo'; // "mr" mean reversion, "tf" trend following
const SIZE_BPS = 9_000; // share of cash spent per entry, in bps of cash
const MAX_SLIP = 400; // max_slippage_bps attached to every order
const COOLDOWN = 10; // bars to wait after an exit before entering again

// mean reversion parameters
const MR_LOOK = 120; // bars in the rolling mean / stdev window
const MR_Z_IN = 140; // enter at mean - (z / 100) * stdev
const MR_Z_OUT = -20; // exit at mean - (z / 100) * stdev
const MR_STOP_BPS = 130; // hard stop below the entry close
const MR_MAX_HOLD = 360; // longest hold, in bars
const MR_TURN = 1; // 1: require the close to stop falling before entry

// trend following parameters
const TF_FAST = 12; // fast EMA length in bars
const TF_SLOW = 55; // slow EMA length in bars
const TF_RET = 20; // trailing return lookback in bars
const TF_MIN_RET_BPS = 20; // minimum trailing return to confirm an entry
const TF_TRAIL_BPS = 55; // trailing stop below the peak close since entry
const TF_MAX_HOLD = 480; // longest hold, in bars

// breakout parameters (MODE "bo"): buy a new BO_LOOK-bar high, ride it
// with a trailing stop under the peak close since entry
const BO_LOOK = 100; // bars in the entry channel
const BO_TRAIL_BPS = 70; // trailing stop below the peak close since entry
const BO_STOP_BPS = 110; // hard stop below the entry close
const BO_MAX_HOLD = 600; // longest hold, in bars
const BO_ATH_BPS = 0; // if > 0, enter only this far below the running high
const BO_LOCK1_BPS = 90; // peak gain where the trailing stop first tightens
const BO_TRAIL1_BPS = 38; // trailing stop once the peak gain reaches BO_LOCK1_BPS
const BO_LOCK2_BPS = 140; // peak gain where the trailing stop tightens again
const BO_TRAIL2_BPS = 28; // trailing stop once the peak gain reaches BO_LOCK2_BPS

// swing momentum parameters (MODE "sw"): buy once the trailing return
// over SW_IN_LOOK bars confirms a rise, sell when momentum fades
const SW_IN_LOOK = 45; // entry lookback in bars
const SW_IN_BPS = 35; // minimum trailing return to enter
const SW_OUT_LOOK = 20; // exit lookback in bars
const SW_OUT_BPS = -25; // exit when the trailing return falls to this
const SW_TRAIL_BPS = 70; // trailing stop below the peak close since entry
const SW_STOP_BPS = 120; // hard stop below the entry close
const SW_MAX_HOLD = 600; // longest hold, in bars

// All mutable strategy state, reset on hello.
let closes: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
let prevFast: number | null = null;
let prevSlow: number | null = null;
let entryClose: number | null = null; // close of the bar that decided the open position
let peakClose: number | null = null; // highest close since the position opened
let barsHeld = 0;
let cooldown = 0;

function reset(): void {
  closes = [];
  emaFast = null;
  emaSlow = null;
  prevFast = null;
  prevSlow = null;
  entryClose = null;
  peakClose = null;
  barsHeld = 0;
  cooldown = 0;
}

function rollingMeanStdev(look: number): [number, number] {
  const window = closes.slice(-look);
  const n = window.length;
  let sum = 0;
  for (const x of window) sum += x;
  const mean = sum / n;
  let sq = 0;
  for (const x of window) sq += (x - mean) * (x - mean);
  return [mean, Math.sqrt(sq / n)];
}

function trailingReturnBps(look: number): number {
  if (closes.length <= look) return 0;
  const base = closes[closes.length - 1 - look];
  return ((closes[closes.length - 1] - base) * BPS) / base;
}

function updateEmas(close: number): void {
  if (emaFast === null || emaSlow === null) {
    emaFast = close;
    emaSlow = close;
  }
  prevFast = emaFast;
  prevSlow = emaSlow;
  emaFast += ((close - emaFast) * 2) / (TF_FAST + 1);
  emaSlow += ((close - emaSlow) * 2) / (TF_SLOW + 1);
}

function buyOrder(state: BarsState): OrderInput | null {
  let spend = (state.cash * BigInt(SIZE_BPS)) / BigInt(BPS);
  const room = state.weightRoom(SYM);
  if (room < spend) spend = room;
  if (spend < 1_000_000n) return null; // below the 1 USDC minimum notional
  return { side: 'buy', symbol: SYM, notional_quote_units: spend, max_slippage_bps: MAX_SLIP };
}

function shouldEnter(close: number): boolean {
  if (MODE === 'mr') {
    if (closes.length < MR_LOOK) return false;
    const [mean, stdev] = rollingMeanStdev(MR_LOOK);
    if (stdev <= 0) return false;
    if ((mean - close) * 100 < MR_Z_IN * stdev) return false;
    if (MR_TURN === 1 && closes.length >= 2 && close < closes[closes.length - 2]) {
      return false; // still falling: wait for the fall to stall
    }
    return true;
  }
  if (MODE === 'bo') {
    if (closes.length <= BO_LOOK) return false;
    let high = 0;
    for (let i = closes.length - 1 - BO_LOOK; i < closes.length - 1; i++) {
      if (closes[i] > high) high = closes[i];
    }
    if (close < high) return false;
    if (BO_ATH_BPS > 0) {
      let ath = 0;
      for (const x of closes) if (x > ath) ath = x;
      if (close * BPS > ath * (BPS - BO_ATH_BPS)) return false;
    }
    return true;
  }
  if (MODE === 'sw') {
    if (closes.length <= SW_IN_LOOK) return false;
    return trailingReturnBps(SW_IN_LOOK) >= SW_IN_BPS;
  }
  // trend following
  if (closes.length < TF_SLOW + 2 || prevFast === null || prevSlow === null) return false;
  if (emaFast === null || emaSlow === null) return false;
  const crossed = prevFast <= prevSlow && emaFast > emaSlow;
  if (!crossed) return false;
  return trailingReturnBps(TF_RET) >= TF_MIN_RET_BPS;
}

function shouldExit(close: number): boolean {
  if (MODE === 'mr') {
    if (barsHeld >= MR_MAX_HOLD) return true;
    if (entryClose !== null && close * BPS <= entryClose * (BPS - MR_STOP_BPS)) return true;
    if (closes.length >= MR_LOOK) {
      const [mean, stdev] = rollingMeanStdev(MR_LOOK);
      if (stdev > 0 && (mean - close) * 100 <= MR_Z_OUT * stdev) return true;
    }
    return false;
  }
  if (MODE === 'bo') {
    if (barsHeld >= BO_MAX_HOLD) return true;
    if (entryClose !== null && close * BPS <= entryClose * (BPS - BO_STOP_BPS)) return true;
    if (peakClose === null || entryClose === null) return false;
    // the trailing stop tightens as the peak gain grows: lock in a big
    // move instead of giving most of it back to the base trailing stop
    let trail = BO_TRAIL_BPS;
    const gain = ((peakClose - entryClose) * BPS) / entryClose;
    if (gain >= BO_LOCK2_BPS) trail = BO_TRAIL2_BPS;
    else if (gain >= BO_LOCK1_BPS) trail = BO_TRAIL1_BPS;
    return close * BPS <= peakClose * (BPS - trail);
  }
  if (MODE === 'sw') {
    if (barsHeld >= SW_MAX_HOLD) return true;
    if (entryClose !== null && close * BPS <= entryClose * (BPS - SW_STOP_BPS)) return true;
    if (peakClose !== null && close * BPS <= peakClose * (BPS - SW_TRAIL_BPS)) return true;
    return closes.length > SW_OUT_LOOK && trailingReturnBps(SW_OUT_LOOK) <= SW_OUT_BPS;
  }
  // trend following
  if (barsHeld >= TF_MAX_HOLD) return true;
  if (peakClose !== null && close * BPS <= peakClose * (BPS - TF_TRAIL_BPS)) return true;
  return prevFast !== null && emaFast !== null && emaSlow !== null && emaFast < emaSlow;
}

function onBatch(state: BarsState): OrderInput[] {
  if (state.warmingUp) return [];
  const bar = state.latest.get(SYM);
  if (bar === undefined) return [];
  const close = Number(bar.c);
  closes.push(close);
  updateEmas(close);
  if (cooldown > 0) cooldown -= 1;

  const holding = state.positions.get(SYM);
  if (holding !== undefined && holding.qty > 0n) {
    if (entryClose === null) {
      entryClose = close;
      peakClose = close;
      barsHeld = 0;
    }
    barsHeld += 1;
    if (peakClose === null || close > peakClose) peakClose = close;
    if (shouldExit(close)) {
      entryClose = null;
      peakClose = null;
      barsHeld = 0;
      cooldown = COOLDOWN;
      return [{ side: 'sell', symbol: SYM, qty: holding.qty, max_slippage_bps: MAX_SLIP }];
    }
    return [];
  }

  // flat: forget the closed position's bookkeeping, then look for an entry
  entryClose = null;
  peakClose = null;
  barsHeld = 0;
  if (cooldown > 0) return [];
  if (shouldEnter(close)) {
    const order = buyOrder(state);
    if (order !== null) {
      entryClose = close;
      peakClose = close;
      return [order];
    }
  }
  return [];
}

await runBars({
  onHello: () => reset(),
  onBatch,
});
