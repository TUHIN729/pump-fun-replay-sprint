// Early-flow snipe strategy for the pump.fun replay (agent-fun/replay/v2).
//
// Idea, from the dev window's own structure: a new coin's fate is decided in
// its first two trades. When the second trade is a large buy and the coin has
// already absorbed several SOL of buying, the price keeps drifting up for the
// next few trades (median +19% over five trades for that slice); by trade five
// the edge is gone. So this bot only ever enters on a coin's second trade,
// only when that trade is a big buy and cumulative buying is already large,
// sizes the buy to the 1%-of-real-reserve cap, and exits fast: a +20% take
// profit, a trailing stop once up +5%, or a hard age exit after eight more
// trades on the coin. Two small refinements: when several coins qualify in
// one batch and only some slots are free, the strongest early flow goes
// first (ranked by cumulative buy volume); and a held coin that has gone
// quiet for 1,000 slots is sold, so a dead coin stops blocking a slot.
// There is deliberately no hard stop-loss: a single large sell gaps the
// price through any stop and the fill lands after the gap, so a hard stop
// sells at the worst print; the trailing stop and the age exit cut losers
// instead. Nothing here names a mint, a slot, a signature or a trade from
// the dev window: every threshold is a round number on flow and price.
//
// Deterministic: no clock, no environment, no unseeded randomness. Prices are
// plain float ratios of the integer reserves (IEEE division is deterministic),
// iteration is over sorted mint lists, and every decision comes only from the
// batch the harness just sent and the fills it reported.

export const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- tuned constants (round numbers; see the header for why each exists) ---
export const ENTRY_TRADE = 2; // enter only on the coin's 2nd trade
export const ENTRY_MIN_LAST_BUY_SOL = 1.0; // that trade must be a buy >= 1 SOL
export const ENTRY_MIN_BUY_VOL_SOL = 3.0; // cumulative buying must reach 3 SOL
export const ENTRY_MIN_REAL_SOL = 1.0; // real SOL reserve must reach 1 SOL
export const TARGET_SIZE_SOL = 0.08; // target buy size (SOL); the 1% cap binds first
export const MIN_SIZE_SOL = 0.012; // skip when the 1% cap is below this
export const TAKE_PROFIT_BPS = 2000; // +20% vs entry price
export const TRAIL_ARM_BPS = 500; // arm the trailing stop once up +5%
export const TRAIL_BPS = 600; // trailing stop: sell at peak * (1 - 6%)
export const MAX_HOLD_TRADES = 8; // sell once the coin has traded 8 more times
export const MAX_HOLD_SLOTS = 4000; // or 4000 slots have passed, whichever first
export const MAX_IDLE_SLOTS = 1000; // or the coin has been quiet this long
export const BUY_SLIPPAGE_BPS = 1000; // 10% worst fill vs decision-time reserves
export const SELL_SLIPPAGE_BPS = 2000; // 20% worst fill vs decision-time reserves
export const MAX_OPEN_POSITIONS = 5;

export interface Reserves {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
}

export interface CoinTrack {
  p0: number; // price (vq/vt) at creation
  trades: number;
  buyVolLamports: bigint;
  lastTradeSol: number;
  lastTradeBuy: boolean;
  lastTradeSlot: number; // slot of the coin's most recent trade
  complete: boolean;
}

export interface PositionTrack {
  entryPrice: number;
  peakPrice: number;
  tradesAtEntry: number;
  buySlot: number;
  armed: boolean;
}

export interface OrderInput {
  side: 'buy' | 'sell';
  mint: string;
  amount: bigint;
  max_slippage_bps: number;
}

export interface StrategyView {
  slot: number;
  cashLamports: bigint;
  positions: Map<string, { tokens: bigint; costLamports: bigint }>;
  pendingBuyMints: Set<string>;
  pendingSellMints: Set<string>;
}

/** Price (quote per token) from effective reserves, as a float ratio. */
export function priceOf(r: Reserves): number {
  if (r.vt <= 0n) return 0;
  return Number(r.vq) / Number(r.vt);
}

/** Effective reserves: recorded reserves shifted by our own net flow. */
export function effectiveReserves(rec: Reserves, off: { dq: bigint; dt: bigint }): Reserves {
  let { dq, dt } = off;
  let s = 1;
  if (dq < 0n && rec.rq + dq < 0n) s = Math.min(s, Number(rec.rq) / Number(-dq));
  if (dt > 0n && rec.rt - dt < 0n) s = Math.min(s, Number(rec.rt) / Number(dt));
  if (s < 1) {
    dq = BigInt(Math.floor(Number(dq) * s));
    dt = BigInt(Math.floor(Number(dt) * s));
  }
  return { vq: rec.vq + dq, vt: rec.vt - dt, rq: rec.rq + dq, rt: rec.rt - dt };
}

export class EarlyFlowSnipe {
  readonly coins = new Map<string, CoinTrack>();
  readonly positions = new Map<string, PositionTrack>();
  readonly recorded = new Map<string, Reserves>();
  readonly offset = new Map<string, { dq: bigint; dt: bigint }>();
  readonly exited = new Set<string>();

  onCreate(mint: string, p0: number, vq: bigint, vt: bigint, rt: bigint): void {
    this.coins.set(mint, {
      p0,
      trades: 0,
      buyVolLamports: 0n,
      lastTradeSol: 0,
      lastTradeBuy: false,
      lastTradeSlot: 0,
      complete: false,
    });
    this.recorded.set(mint, { vq, vt, rq: 0n, rt });
  }

  onTrade(mint: string, price: number, isBuy: boolean, solLamports: bigint, vq: bigint, vt: bigint, rq: bigint, rt: bigint, slot: number): void {
    const c = this.coins.get(mint);
    if (c === undefined) return;
    c.trades += 1;
    c.lastTradeSol = Number(solLamports) / Number(LAMPORTS_PER_SOL);
    c.lastTradeBuy = isBuy;
    c.lastTradeSlot = slot;
    if (isBuy) c.buyVolLamports += solLamports;
    this.recorded.set(mint, { vq, vt, rq, rt });
  }

  onComplete(mint: string): void {
    const c = this.coins.get(mint);
    if (c !== undefined) c.complete = true;
    this.positions.delete(mint);
    this.exited.add(mint);
  }

  /** Fold a reported fill into the offset and position tracking. */
  onFill(fill: {
    client_id: string;
    side: 'buy' | 'sell';
    status: 'filled' | 'rejected' | 'failed';
    mint: string;
    quote_lamports: string;
    token_amount: string;
    fee_lamports: string;
    slot: number;
  }): void {
    if (fill.status !== 'filled') return;
    const mint = fill.mint;
    const tokens = BigInt(fill.token_amount);
    const quote = BigInt(fill.quote_lamports);
    const fee = BigInt(fill.fee_lamports);
    if (fill.client_id.startsWith('_writeoff')) {
      // Tokens abandoned, no trade: the curve does not move.
      this.positions.delete(mint);
      this.exited.add(mint);
      return;
    }
    const off = this.offset.get(mint) ?? { dq: 0n, dt: 0n };
    if (fill.side === 'buy') {
      const q = quote - fee; // curve quote in (fees excluded)
      this.offset.set(mint, { dq: off.dq + q, dt: off.dt + tokens });
      const entryPrice = tokens > 0n ? Number(quote) / Number(tokens) : 0;
      const prev = this.positions.get(mint);
      if (prev === undefined) {
        const c = this.coins.get(mint);
        this.positions.set(mint, {
          entryPrice,
          peakPrice: entryPrice,
          tradesAtEntry: c !== undefined ? c.trades : 0,
          buySlot: fill.slot,
          armed: false,
        });
      } else {
        // A later add blends the entry price (not used by the current config).
        prev.entryPrice = entryPrice;
        prev.peakPrice = Math.max(prev.peakPrice, entryPrice);
      }
    } else {
      const q = quote + fee; // curve quote out (fees excluded)
      this.offset.set(mint, { dq: off.dq - q, dt: off.dt - tokens });
      if (fill.client_id.startsWith('_complete') || fill.client_id.startsWith('_flatten')) {
        this.positions.delete(mint);
        this.exited.add(mint);
      }
    }
  }

  /** Mark a mint's position record gone when the harness closed it. */
  dropPosition(mint: string): void {
    this.positions.delete(mint);
    this.exited.add(mint);
  }

  decide(view: StrategyView, eventMints: string[]): OrderInput[] {
    const orders: OrderInput[] = [];
    const eff = (mint: string): Reserves | undefined => {
      const rec = this.recorded.get(mint);
      if (rec === undefined) return undefined;
      return effectiveReserves(rec, this.offset.get(mint) ?? { dq: 0n, dt: 0n });
    };

    // --- exits first ---
    for (const mint of [...view.positions.keys()].sort()) {
      if (view.pendingSellMints.has(mint)) continue;
      const coin = this.coins.get(mint);
      if (coin !== undefined && coin.complete) continue; // harness closes it
      const track = this.positions.get(mint);
      const held = view.positions.get(mint);
      if (held === undefined) continue;
      const res = eff(mint);
      if (res === undefined) continue;
      const price = priceOf(res);
      if (price <= 0) continue;
      let entry = track !== undefined ? track.entryPrice : Number(held.costLamports) / Number(held.tokens);
      let peak = track !== undefined ? track.peakPrice : entry;
      let armed = track !== undefined ? track.armed : false;
      const tradesAtEntry = track !== undefined ? track.tradesAtEntry : 0;
      const buySlot = track !== undefined ? track.buySlot : view.slot;
      if (track === undefined) {
        this.positions.set(mint, { entryPrice: entry, peakPrice: peak, tradesAtEntry, buySlot, armed });
      } else if (price > track.peakPrice) {
        track.peakPrice = price;
        peak = price;
      }
      if (price >= entry * (1 + TRAIL_ARM_BPS / 10000)) armed = true;
      if (track !== undefined) track.armed = armed;
      let sell = false;
      if (price >= entry * (1 + TAKE_PROFIT_BPS / 10000)) sell = true;
      else if (armed && price <= peak * (1 - TRAIL_BPS / 10000)) sell = true;
      else {
        const c = this.coins.get(mint);
        if (c !== undefined && c.trades - tradesAtEntry >= MAX_HOLD_TRADES) sell = true;
        else if (view.slot - buySlot >= MAX_HOLD_SLOTS) sell = true;
        else if (c !== undefined && view.slot - c.lastTradeSlot >= MAX_IDLE_SLOTS) sell = true;
      }
      if (sell) {
        orders.push({ side: 'sell', mint, amount: held.tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }

    // --- entries: only coins with events in this batch, only on trade 2 ---
    // When several qualify and slots are scarce, strongest early flow first
    // (cumulative buy volume desc, mint asc as the deterministic tie-break).
    let committed = view.positions.size + view.pendingBuyMints.size;
    let cash = view.cashLamports;
    const txFee = 105000n;
    const orderedThisBatch = new Set<string>();
    const ranked = [...eventMints].sort((a, b) => {
      const va = this.coins.get(a)?.buyVolLamports ?? 0n;
      const vb = this.coins.get(b)?.buyVolLamports ?? 0n;
      if (va !== vb) return va > vb ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const mint of ranked) {
      if (committed >= MAX_OPEN_POSITIONS) break;
      if (orderedThisBatch.has(mint)) continue;
      if (view.positions.has(mint) || view.pendingBuyMints.has(mint)) continue;
      if (this.exited.has(mint)) continue;
      const c = this.coins.get(mint);
      if (c === undefined || c.complete) continue;
      if (c.trades !== ENTRY_TRADE) continue;
      if (!c.lastTradeBuy || c.lastTradeSol < ENTRY_MIN_LAST_BUY_SOL) continue;
      if (c.buyVolLamports < BigInt(Math.floor(ENTRY_MIN_BUY_VOL_SOL * Number(LAMPORTS_PER_SOL)))) continue;
      const res = eff(mint);
      if (res === undefined) continue;
      if (res.rq < BigInt(Math.floor(ENTRY_MIN_REAL_SOL * Number(LAMPORTS_PER_SOL)))) continue;
      const cap = res.rq / 100n; // 1% of real quote reserves
      const target = BigInt(Math.floor(TARGET_SIZE_SOL * Number(LAMPORTS_PER_SOL)));
      const size = target < cap ? target : cap;
      if (size < BigInt(Math.floor(MIN_SIZE_SOL * Number(LAMPORTS_PER_SOL)))) continue;
      if (size + txFee > cash) continue;
      orders.push({ side: 'buy', mint, amount: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
      orderedThisBatch.add(mint);
      committed += 1;
      cash -= size + txFee;
    }
    return orders;
  }
}
