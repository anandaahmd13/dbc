# DBC DEX Tracker

Telegram bot that watches **new Meteora Dynamic Bonding Curve (DBC)** launches and alerts when:

- a token gets a **DEX Screener paid profile** order (`tokenProfile`), or
- a token's **socials / website** (X/Twitter, Telegram, website) change on DEX Screener.

Only tokens whose **creator wallet has launched ≤ N DBC pools** (default 10, inclusive, counting the current one) are tracked.

> Telegram-only. No web dashboard, no wallet signing, no trading. The bot only reads chain + DEX Screener data and sends messages.

## How it works

1. **Launch watcher** subscribes to DBC program logs via Helius WebSocket, decodes `EvtInitializePool`, and records `{pool, creator, baseMint}`. On restart it backfills from the last cursor signature.
2. **Creator history** counts a creator's DBC pools with `client.state.getPoolsByCreator`. If the count can't be proven complete, the creator is marked `unknown` and re-checked — it is **not** treated as 0.
3. **Tracker** polls DEX Screener per eligible token:
   - `GET /orders/v1/solana/{mint}` for paid `tokenProfile` status (docs: 60 req/min).
   - token batch endpoint for `info.websites` / `info.socials` (docs: 300 req/min).
   The first poll is a **baseline** (labelled "first seen"); later changes are diffed.
4. **Telegram outbox** stores alerts in SQLite and a worker delivers them with retry + 429 backoff.

### Important limitations

- **Not real-time.** The orders endpoint has no batch form; more tracked tokens means longer polling cycles. The bot stays under documented rate limits rather than guaranteeing latency.
- **Delivery is at-least-once.** A timeout after a successful send can duplicate a message.
- **History completeness depends on your RPC.** If Helius can't return a creator's full pool history, eligibility is `unknown` until proven.
- Example mints are **not** assumed to be DBC until found on-chain. Use `npm run inspect` to check one.

## Setup

```bash
npm install
cp .env.example .env     # then fill in HELIUS_* and TELEGRAM_*
```

Keep `DRY_RUN=true` until you've confirmed the target chat. In dry-run the bot logs messages instead of sending them.

### Inspect a single mint (read-only, no Telegram)

```bash
npm run inspect -- BDrr8vBvEggLZNVsxYvYmR31YEEBCky71KZNHufJwoco
```

Prints whether the mint is a DBC pool, its creator, the creator's launch count, and current DEX Screener order/social state — or why it can't be verified.

### Run

```bash
npm run dev        # tsx, no build
# or
npm run build && npm start
```

### Test / typecheck

```bash
npm run typecheck
npm test
```

## Config (`.env`)

| Key | Meaning |
| --- | --- |
| `HELIUS_RPC_URL` / `HELIUS_WS_URL` | Helius HTTP + WS endpoints (with your api-key). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | From @BotFather; target chat id. |
| `DRY_RUN` | `true` = log instead of send (default). |
| `MAX_CREATOR_LAUNCHES` | Eligibility cap, inclusive (default 10). |
| `WATCH_WINDOW_MINUTES` | How long to poll a token after launch (default 1440). |
| `ORDERS_RPM` / `TOKENS_RPM` | Polling budgets, kept under DEX Screener limits. |
| `DATABASE_PATH` | SQLite file (default `./data/tracker.db`). |

## References

- DEX Screener API: https://docs.dexscreener.com/api/reference
- Meteora DBC SDK: https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/reference
