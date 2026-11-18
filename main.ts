// Plunge-and-Pulse: a long-only cbBTC bot for agent-fun/bars-replay/v1.
//
// Two independent setups share the single position slot; a round trip costs about 26 bps in
// fees, slippage and impact, so the bot trades rarely and only on moves much larger than that.
//
//   1. Plunge recovery (priority). The close has fallen at least 1.5% over the 120 bars that
//      ended 60 bars ago, the last 60 bars have stopped making new lows against that drop
//      window, and the latest close ticks up: the plunge is over and the snap-back is the
//      trade. Buy with the whole equity. Exit the whole position at +1.2% over the decision
//      close (take profit), at -0.9% under it (stop), or after 600 bars held.
//   2. Hourly momentum pulse. The trailing 60-bar return is over +0.6%: hourly moves that
//      strong have tended to continue rather than revert. Buy with the whole equity. Exit
//      when the trailing 60-bar return falls back under 0, or after 240 bars held.
//
// Everything is decided on closes (an order fills at the next bar's open), in float64 on
// + - * / alone, so the same bars give the same orders in every execution. No clock, no
// randomness, no state outside this file's memory. A sell whose exit reason still holds is
// sent again on the next bar, so a fill the market refuses (a gap past the slippage cap)
// never strands the position.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Plunge: the 120-bar return ending 60 bars ago is at most this (a fall of 1.5%). */
const PLUNGE_DROP = -0.015;
/** Plunge: bars since that drop window ended over which no new low may print. */
const PLUNGE_CALM_BARS = 60;
/** Plunge: the drop is measured over this many bars. */
const PLUNGE_LOOKBACK = 120;
/** Plunge exit: gain over the decision close that takes the profit. */
const PLUNGE_TAKE_PROFIT = 0.012;
/** Plunge exit: loss under the decision close that stops the trade out. */
const PLUNGE_STOP = -0.009;
/** Plunge exit: bars held after which the position is closed whatever it shows. */
const PLUNGE_MAX_HOLD = 600;
/** Momentum: trailing return over MOMENTUM_BARS that opens a position. */
const MOMENTUM_ENTRY = 0.006;
/** Momentum: the trailing-return window, and the exit when it falls back under 0. */
const MOMENTUM_BARS = 60;
/** Momentum exit: bars held after which the position is closed whatever it shows. */
const MOMENTUM_MAX_HOLD = 240;
/** Every order refuses a fill further than this past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;
/** Closes kept per symbol: enough for the plunge lookback plus its calm window, with slack. */
const HISTORY_BARS = 300;

type Mode = 'plunge' | 'momentum';

interface Track {
  /** Closes seen, oldest first, capped at HISTORY_BARS. */
  closes: number[];
  /** The setup that opened the position, while one is open. */
  mode: Mode | null;
  /** The close the entry was decided on: the take-profit and stop anchor. */
  entryClose: number;
  /** Bars held since the entry was decided. */
  heldBars: number;
}

const tracks = new Map<string, Track>();

function track(symbol: string): Track {
  let t = tracks.get(symbol);
  if (t === undefined) {
    t = { closes: [], mode: null, entryClose: 0, heldBars: 0 };
    tracks.set(symbol, t);
  }
  return t;
}

function push(t: Track, bar: Bar): void {
  t.closes.push(Number(bar.c));
  if (t.closes.length > HISTORY_BARS) t.closes.splice(0, t.closes.length - HISTORY_BARS);
}

/** The smallest close of closes[from..to] (inclusive indexes into the kept history). */
function minClose(closes: number[], from: number, to: number): number {
  let m = Infinity;
  for (let i = from; i <= to; i++) if (closes[i] < m) m = closes[i];
  return m;
}

/** Whether the plunge setup fires on the latest close: a hard fall, then calm, then an uptick. */
function plungeFires(closes: number[]): boolean {
  const i = closes.length - 1;
  const calm = PLUNGE_CALM_BARS;
  const look = PLUNGE_LOOKBACK;
  if (i < calm + look) return false;
  const drop = closes[i - calm] / closes[i - calm - look] - 1;
  if (drop > PLUNGE_DROP) return false;
  // No new low in the calm window against the drop window's own low: the fall has stopped.
  if (minClose(closes, i - calm, i) < minClose(closes, i - calm - look, i - calm)) return false;
  return closes[i] > closes[i - 1];
}

/** The trailing MOMENTUM_BARS return on the latest close, or null before enough bars. */
function momentumReturn(closes: number[]): number | null {
  const i = closes.length - 1;
  if (i < MOMENTUM_BARS) return null;
  return closes[i] / closes[i - MOMENTUM_BARS] - 1;
}

/** Whether the open position exits on this close, by its own setup's rules. */
function exitFires(t: Track): boolean {
  const closes = t.closes;
  const last = closes[closes.length - 1];
  if (t.mode === 'plunge') {
    const gain = last / t.entryClose - 1;
    return gain >= PLUNGE_TAKE_PROFIT || gain <= PLUNGE_STOP || t.heldBars >= PLUNGE_MAX_HOLD;
  }
  const r = momentumReturn(closes);
  return (r !== null && r < 0) || t.heldBars >= MOMENTUM_MAX_HOLD;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(track(bar.symbol), bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const orders: (BuyInput | SellInput)[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const t = track(symbol);
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (t.mode === null) {
          // A position with no tracked setup (its entry predates this process's memory of
          // it): close it rather than hold something no rule is managing.
          t.mode = 'momentum';
          t.entryClose = t.closes[t.closes.length - 1];
          t.heldBars = 0;
        }
        t.heldBars += 1;
        if (exitFires(t)) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }
      t.mode = null;
      t.heldBars = 0;
      // Flat: the plunge setup takes the slot first, the momentum pulse second.
      let mode: Mode | null = null;
      if (plungeFires(t.closes)) mode = 'plunge';
      else {
        const r = momentumReturn(t.closes);
        if (r !== null && r > MOMENTUM_ENTRY) mode = 'momentum';
      }
      if (mode === null) continue;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      const notional = byWeight < state.cash ? byWeight : state.cash;
      if (notional < BigInt(fees.min_notional_quote_units)) continue;
      t.mode = mode;
      t.entryClose = t.closes[t.closes.length - 1];
      t.heldBars = 0;
      orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
