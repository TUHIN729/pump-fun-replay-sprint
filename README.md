# pump-fun-replay-sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/TUHIN729/pump-fun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/TUHIN729/pump-fun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A TypeScript paper-trading bot for the Pump.fun Replay Sprint on make.fun.
It trades 10 SOL of paper money on a 24-hour replay of recorded pump.fun
bonding-curve activity. Places go by net PnL; a placement needs net PnL above
holding cash.

## How it trades

A new coin's fate is decided in its first two trades, so the bot only ever
enters on a coin's **second trade**, and only when that trade is a large buy
(>= 1 SOL) and the coin has already absorbed >= 3 SOL of buying. The buy is
sized to the 1%-of-real-reserve cap (at most 0.08 SOL). It exits fast: a +20%
take profit, a trailing stop that arms once the position is up +5% and sells
6% below its peak, or a hard age exit after eight more trades on the coin.
There is deliberately no hard stop-loss: a single large sell gaps the price
through any stop and the fill lands after the gap, so a hard stop sells at the
worst print; the trailing stop and the age exit cut losers instead.

Everything is rule-based and deterministic: no clock, no network, no unseeded
randomness, no hardcoded mint, slot or trade from any window. Two runs on the
same data produce the same action log.

## Layout

- `main.ts` — entrypoint: speaks the `agent-fun/replay/v2` protocol through
  the kit SDK and hands every decision to the strategy.
- `strategy.ts` — the early-flow snipe strategy (all trading logic).
- `vendor/makefun-bot.ts` — the kit's TypeScript SDK, vendored as-is.

## Run it

```sh
# Grade locally on the dev window (needs the kit unpacked next to this repo):
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

The bot needs Node 22.18+ (it runs as erasable TypeScript, no build step) and
reads the replay on stdin, writing one reply per batch on stdout.

<sub>Entered on [make.fun](https://make.fun/?ref=ecdsgx0z&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
