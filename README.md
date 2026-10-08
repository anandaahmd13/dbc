# DBC DEX Tracker

Telegram bot that watches **new Meteora Dynamic Bonding Curve (DBC)** launches and alerts when:

- a token gets a **DEX Screener paid profile** order (`tokenProfile`), or
- a token's **socials / website** (X/Twitter, Telegram, website) change on DEX Screener.

Only tokens whose **creator wallet has launched ≤ N DBC pools** (default 10, inclusive, counting the current one) are tracked.

> Telegram-only. No web dashboard, no wallet signing, no trading. The bot only reads chain + DEX Screener data and sends messages.

## How it works

1. **Launch watcher** subscribes to DBC program logs via Helius WebSocket, decodes `EvtInitializePool` from the transaction's inner instructions, and records `{pool, creator, baseMint}` immediately. The token is monitored right away.
2. **Creator check** runs in its own worker (a heavy RPC scan, `getProgramAccountsV2` with pagination). The mint being evaluated is always counted. A creator with more than `MAX_CREATOR_LAUNCHES` (inclusive limit) is dropped for good. If the check fails or cannot be proven complete, the creator is `unknown`: monitoring continues, retries back off, and alerts for that token are **held** (not sent, not lost) until a verdict arrives — eligible releases them, ineligible discards them.
3. **Social worker** refreshes DEX Screener token info in batches of 30 (one request per 30 tokens). The first response per token is a silent baseline; later link changes are diffed and alerted. A removal must be seen twice in a row before it counts.
4. **Order worker** drains a durable queue. A token's orders are checked **only** when its profile appears or changes (icon, banner, website, socials) — never by polling every token. Each check retries with backoff for up to 10 minutes, then gives up until the profile changes again. Only an order of type `tokenProfile` produces a paid alert.
5. **Telegram outbox** stores alerts in SQLite; a worker delivers them with retry + 429 backoff.

The three workers are independent and use separate rate limits, so a backlog in one cannot delay the others.

### Limitations

- **A profile change is a trigger, not proof of payment.** The orders endpoint reports `tokenProfile` orders but not the USD amount, so alerts say "Enhanced Token Info", not a verified price. A payment that never changes the profile, or whose order shows up after the 10-minute retry window, can be missed.
- **Not real-time.** Launch detection takes about a second. Profile changes are seen on the next social refresh (`POLL_INTERVAL_SECONDS`, default 60), plus API latency; 429s add delay.
- **Creator history is not a full lifetime record.** The scan sees pools a wallet currently holds, plus launches this bot saw it create. A pool transferred to another wallet before the bot was watching is invisible. `eligible` therefore means "no more than N launches we can see", while `ineligible` is proven.
- **Delivery is at-least-once.** A timeout after a successful send can duplicate a message.
- Startup backfill of the last 24h is off by default (`BACKFILL_MAX_TX=0`); the DBC program is too busy for a signature scan to reach back that far.
- `npm run inspect -- <mint>` and `npm run diagnose [-- <mint>]` are read-only tools for checking a token and the queues.

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
| `ORDERS_RPM` / `TOKENS_RPM` | Rate budgets, kept under DEX Screener limits. |
| `POLL_INTERVAL_SECONDS` | How often each token's profile is refreshed (default 60). |
| `ALERT_ON_LAUNCH` | `true` = also message on every new eligible launch (default `false`). |
| `DATABASE_PATH` | SQLite file (default `./data/tracker.db`). |

## References

- DEX Screener API: https://docs.dexscreener.com/api/reference
- Meteora DBC SDK: https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/reference
