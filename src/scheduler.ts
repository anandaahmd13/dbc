import type { Db, LaunchRow } from "./db.js";
import type { TrackerDeps } from "./tracker.js";
import { pollOrders, pollSocials } from "./tracker.js";
import { DexScreenerError } from "./dexscreener/client.js";
import { log } from "./logger.js";

/**
 * Simple token-bucket rate limiter. `acquire()` resolves once a request slot is
 * available, keeping throughput under `rpm` requests per minute.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(private readonly rpm: number, private readonly now: () => number = Date.now) {
    this.tokens = rpm;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    const elapsed = (t - this.last) / 60_000;
    this.tokens = Math.min(this.rpm, this.tokens + elapsed * this.rpm);
    this.last = t;
  }

  /** ms to wait until a token is available (0 if ready now). */
  msUntilToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const need = 1 - this.tokens;
    return Math.ceil((need / this.rpm) * 60_000);
  }

  async acquire(): Promise<void> {
    for (;;) {
      const wait = this.msUntilToken();
      if (wait === 0) {
        this.tokens -= 1;
        return;
      }
      await sleep(wait + jitter(50));
    }
  }
}

export interface SchedulerConfig {
  ordersRpm: number;
  tokensRpm: number;
  /** base poll interval per token (ms) */
  pollIntervalMs: number;
}

/**
 * Drives DEX Screener polling for all active (eligible, in-window) launches,
 * respecting rate budgets. Social info is batched (30/call); orders are 1/call.
 */
export class PollScheduler {
  private ordersRl: RateLimiter;
  private tokensRl: RateLimiter;
  private stopped = false;
  private readonly nextOrderPoll = new Map<string, number>();
  private lastSocialCycle = 0;

  constructor(
    private readonly db: Db,
    private readonly deps: TrackerDeps,
    private readonly cfg: SchedulerConfig
  ) {
    this.ordersRl = new RateLimiter(cfg.ordersRpm);
    this.tokensRl = new RateLimiter(cfg.tokensRpm);
  }

  stop() {
    this.stopped = true;
  }

  async runForever(): Promise<void> {
    while (!this.stopped) {
      const now = Date.now();
      const active = this.db.activeLaunches(now);
      if (active.length === 0) {
        await sleep(2000);
        continue;
      }
      await this.cycleSocials(active, now);
      await this.cycleOrders(active, now);
      await sleep(1000);
    }
  }

  /** Poll socials for all active mints in batches of 30, once per interval. */
  private async cycleSocials(active: LaunchRow[], now: number): Promise<void> {
    if (now - this.lastSocialCycle < this.cfg.pollIntervalMs) return;
    this.lastSocialCycle = now;
    const mints = active.map((l) => l.base_mint);
    for (let i = 0; i < mints.length; i += 30) {
      const batch = mints.slice(i, i + 30);
      await this.tokensRl.acquire();
      try {
        await pollSocials(this.deps, batch);
      } catch (err) {
        this.handleDexErr("socials", err);
      }
    }
  }

  /** Poll orders one mint at a time, each on its own schedule. */
  private async cycleOrders(active: LaunchRow[], now: number): Promise<void> {
    for (const l of active) {
      if (this.stopped) return;
      const due = this.nextOrderPoll.get(l.base_mint) ?? 0;
      if (due > now) continue;
      await this.ordersRl.acquire();
      try {
        await pollOrders(this.deps, l.base_mint);
        this.nextOrderPoll.set(l.base_mint, Date.now() + this.cfg.pollIntervalMs);
      } catch (err) {
        const backoff = this.handleDexErr("orders", err);
        this.nextOrderPoll.set(l.base_mint, Date.now() + backoff);
      }
    }
  }

  private handleDexErr(label: string, err: unknown): number {
    if (err instanceof DexScreenerError) {
      const wait = err.retryAfterMs ?? 5000;
      log.warn(`DEX Screener ${label} ${err.status}; backing off ${wait}ms`);
      return wait;
    }
    log.warn(`DEX Screener ${label} error`, err instanceof Error ? err.message : String(err));
    return 5000;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}
