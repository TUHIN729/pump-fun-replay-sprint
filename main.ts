// Pump.fun Replay Sprint — paper trading bot (agent-fun/replay/v2).
//
// Entrypoint: speaks the harness protocol through the kit SDK and hands every
// decision to the early-flow snipe strategy in strategy.ts. It reads one batch
// at a time (hello / batch / done), folds the batch's events and fills into
// the strategy, and returns at most the orders the strategy chose. Nothing
// here touches the clock, the environment or unseeded randomness, so two runs
// on the same data give the same action log.

import { runBot, type Batch, type BotState, type Fill } from './vendor/makefun-bot.ts';
import { EarlyFlowSnipe, type StrategyView } from './strategy.ts';

const strategy = new EarlyFlowSnipe();

function priceFromReserves(virtualQuote: string, virtualToken: string): number {
  const vt = BigInt(virtualToken);
  if (vt <= 0n) return 0;
  return Number(BigInt(virtualQuote)) / Number(vt);
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const eventMintSet = new Set<string>();
    for (const e of batch.events) {
      eventMintSet.add(e.mint);
      if (e.event === 'CreateEvent') {
        const p0 = priceFromReserves(e.virtual_sol_reserves, e.virtual_token_reserves);
        strategy.onCreate(
          e.mint,
          p0,
          BigInt(e.virtual_quote_reserves),
          BigInt(e.virtual_token_reserves),
          BigInt(e.real_token_reserves),
        );
      } else if (e.event === 'TradeEvent') {
        const price = priceFromReserves(e.virtual_sol_reserves, e.virtual_token_reserves);
        strategy.onTrade(
          e.mint,
          price,
          e.is_buy,
          BigInt(e.sol_amount),
          BigInt(e.virtual_quote_reserves),
          BigInt(e.virtual_token_reserves),
          BigInt(e.real_quote_reserves),
          BigInt(e.real_token_reserves),
          batch.slot,
        );
      } else {
        strategy.onComplete(e.mint);
      }
    }

    for (const f of batch.fills as Fill[]) {
      strategy.onFill({
        client_id: f.client_id,
        side: f.side,
        status: f.status,
        mint: f.mint,
        quote_lamports: f.quote_lamports,
        token_amount: f.token_amount,
        fee_lamports: f.fee_lamports,
        slot: f.slot,
      });
    }
    // Drop metadata for positions the account no longer holds (sold or closed).
    for (const mint of [...strategy.positions.keys()]) {
      if (!state.positions.has(mint)) strategy.dropPosition(mint);
    }

    const pendingBuyMints = new Set<string>();
    const pendingSellMints = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuyMints.add(p.order.mint);
      else pendingSellMints.add(p.order.mint);
    }
    const positions = new Map<string, { tokens: bigint; costLamports: bigint }>();
    for (const [mint, h] of state.positions) {
      positions.set(mint, { tokens: h.token_amount, costLamports: h.cost_lamports });
    }
    const view: StrategyView = {
      slot: batch.slot,
      cashLamports: state.freeCashLamports(),
      positions,
      pendingBuyMints,
      pendingSellMints,
    };
    const orders = strategy.decide(view, [...eventMintSet]);
    return orders.map((o) => ({
      side: o.side,
      mint: o.mint,
      ...(o.side === 'buy'
        ? { quote_lamports: o.amount }
        : { token_amount: o.amount }),
      max_slippage_bps: o.max_slippage_bps,
    }));
  },
  onDone(state: BotState) {
    const cash = state.cash;
    const held = state.positions.size;
    console.error(`done: cash ${cash} lamports, ${held} positions open (flattened by harness)`);
  },
});
