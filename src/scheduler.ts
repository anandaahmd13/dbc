import type { Db, LaunchRow } from "./db.js";
import type { TrackerDeps } from "./tracker.js";
import { applySocialBatch, runOrderCheck } from "./tracker.js";
import { DexScreenerError, fetchTokenInfo } from "./dexscreener/client.js";
import type { TokenInfo } from "./dexscreener/client.js";
import { log } from "./logger.js";

/**
 * Token-bucket limiter. `acquire()` resolves once a request slot is available,
 * keeping throughput under `rpm`. It starts with a small burst (not a full
 * minute's worth) so a restart cannot spend the whole budget instantly, and it
 * can be paused as a whole (`blockFor`) when the server says 429.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private blockedUntil = 0;

  constructor(
    private readonly rpm: number,
    private readonly now: () => number = Date.now,
    private readonly burst: number = Math.max(1, Math.ceil(rpm / 12)),
    /** Injectable so tests driving a fake clock can advance it instead of waiting. */
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = sleep
  ) {
    this.tokens = Math.min(burst, rpm);
    this.last = now();
  }

  private refill() {
    const t = this.now();
    const elapsed = (t - this.last) / 60_000;
    this.tokens = Math.min(Math.min(this.burst, this.rpm), this.tokens + elapsed * this.rpm);
    this.last = t;
  }

  /** Pause every consumer of this limiter for `ms` (e.g. after a 429). */
  blockFor(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  /** ms to wait until a token is available (0 if ready now). */
  msUntilToken(): number {
    this.refill();
    const blocked = Math.max(0, this.blockedUntil - this.now());
    if (this.tokens >= 1) return blocked;
    const need = 1 - this.tokens;
    return Math.max(blocked, Math.ceil((need / this.rpm) * 60_000));
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      const wait = this.msUntilToken();
      if (wait === 0) {
        this.tokens -= 1;
        return;
      }
      await this.wait(wait + jitter(50), signal);
    }
  }
}

export interface SchedulerConfig {
  ordersRpm: number;
  tokensRpm: number;
  /** how often each monitored token's socials are refreshed (ms) */
  pollIntervalMs: number;
}

const BATCH = 30;
/** Creators verified per step, and the pause after each (RPC politeness). */
const CREATOR_BATCH = 3;
const CREATOR_PACE_MS = 600;
/** Retry delay when a launch has no DEX Screener pair data yet. */
const NO_DATA_RETRY_MS = 15_000;

/** Verifies one creator; supplied by index.ts so the scheduler stays RPC-agnostic. */
export type CreatorVerifier = (
  creator: string,
  currentMint: string
) => Promise<"eligible" | "ineligible" | "unknown">;

export interface SchedulerHooks {
  /** Creator verification for launches whose creator is not yet proven. */
  verifyCreator?: CreatorVerifier;
  /** Injectable for tests; defaults to the real fetchers/clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchInfo?: (mints: string[]) => Promise<Map<string, TokenInfo>>;
  fetchOrders?: (mint: string) => Promise<import("./dexscreener/client.js").OrderEntry[]>;
  now?: () => number;
}

/**
 * Three independent workers over shared, fair rate limits:
 *
 *  - socials:  batches of 30 due launches -> baseline (silent) or change-diff.
 *              Uses ONLY the tokens limiter, so a backlog of orders can never
 *              delay it.
 *  - orders:   drains the durable `order_checks` queue (jobs are created only
 *              when a profile appears/changes). Uses ONLY the orders limiter.
 *
 * Neither waits on the other's cycle, and each re-reads the clock every
 * iteration, so a slow pass can't make the next one act on stale time.
 */
export class PollScheduler {
  readonly ordersRl: RateLimiter;
  readonly tokensRl: RateLimiter;
  private readonly abort = new AbortController();
  private running: Promise<void>[] = [];
  private readonly now: () => number;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly db: Db,
    private readonly deps: TrackerDeps,
    private readonly cfg: SchedulerConfig,
    private readonly hooks: SchedulerHooks = {}
  ) {
    this.now = hooks.now ?? Date.now;
    const wait = hooks.sleep ?? sleep;
    this.wait = (ms) => wait(ms, this.abort.signal).catch(() => {});
    this.ordersRl = new RateLimiter(cfg.ordersRpm, this.now, undefined, wait);
    this.tokensRl = new RateLimiter(cfg.tokensRpm, this.now, undefined, wait);
  }

  /** Start both workers. Resolves only after they have been stopped. */
  start(): Promise<void> {
    this.running = [
      this.loop("socials", () => this.socialStep()),
      this.loop("orders", () => this.orderStep()),
      this.loop("creators", () => this.creatorStep()),
    ];
    return Promise.all(this.running).then(() => undefined);
  }

  /** Kept for the existing entry point. */
  runForever(): Promise<void> {
    return this.start();
  }

  /** Stop both workers and wait for in-flight work to finish. */
  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.running);
  }

  private async loop(name: string, step: () => Promise<number>): Promise<void> {
    while (!this.abort.signal.aborted) {
      let worked = 0;
      try {
        worked = await step();
      } catch (err) {
        if (this.abort.signal.aborted) return;
        log.warn(`${name} worker error`, err instanceof Error ? err.message : String(err));
        await sleep(2000, this.abort.signal).catch(() => {});
      }
      if (worked === 0) await sleep(1000, this.abort.signal).catch(() => {});
    }
  }

  /**
   * One social step: take up to 30 due launches (un-baselined first), fetch them
   * in a single request, apply atomically, reschedule. Returns launches handled.
   */
  async socialStep(): Promise<number> {
    const now = this.now();
    const due = this.db.dueLaunches(now, BATCH);
    if (due.length === 0) return 0;
    const mints = due.map((l) => l.base_mint);

    await this.tokensRl.acquire(this.abort.signal);
    let infos: Map<string, TokenInfo>;
    try {
      infos = await (this.hooks.fetchInfo ?? fetchTokenInfo)(mints);
    } catch (err) {
      const wait = this.backoff("socials", err, this.tokensRl);
      this.db.reschedulePolls(mints, this.now() + wait, false);
      return due.length;
    }

    const res = applySocialBatch(this.deps, mints, infos, this.now());
    const seen = new Set(res.seen);
    const next = this.now();
    this.db.reschedulePolls(
      mints.filter((m) => seen.has(m)),
      next + this.cfg.pollIntervalMs,
      true
    );
    // Not indexed yet (or thin response): try again soon, never read as removal.
    // Back off per token (15s, 30s, 60s ...) up to the normal interval so tokens
    // DEX Screener never indexes stop crowding batches meant for live ones.
    for (const m of mints.filter((x) => !seen.has(x))) {
      const attempts = this.db.getLaunchByMint(m)?.poll_attempts ?? 0;
      const delay = Math.min(NO_DATA_RETRY_MS * 2 ** attempts, this.cfg.pollIntervalMs);
      this.db.reschedulePolls([m], next + delay, false);
    }
    if (res.baselined.length || res.orderChecksQueued.length || res.alerted.length) {
      log.debug(
        `socials batch=${mints.length} seen=${seen.size} baselined=${res.baselined.length} ` +
          `orderChecks=${res.orderChecksQueued.length} alerts=${res.alerted.length}`
      );
    }
    return due.length;
  }

  /** One order step: run due jobs from the durable queue. Returns jobs run. */
  async orderStep(): Promise<number> {
    const now = this.now();
    const jobs = this.db.dueOrderChecks(now, 5);
    for (const job of jobs) {
      if (this.abort.signal.aborted) return jobs.length;
      await this.ordersRl.acquire(this.abort.signal);
      try {
        await runOrderCheck(this.deps, job.base_mint, {
          fetchOrders: this.hooks.fetchOrders,
          now: this.now(),
        });
      } catch (err) {
        const wait = this.backoff("orders", err, this.ordersRl);
        // Keep the job pending; the deadline still bounds total retries.
        const fresh = this.db.getOrderCheck(job.base_mint);
        if (fresh && this.now() >= fresh.deadline_at) this.db.finishOrderCheck(job.base_mint, "expired");
        else this.db.retryOrderCheck(job.base_mint, this.now() + wait);
      }
    }
    return jobs.length;
  }

  /**
   * One creator step: verify up to a few launches whose creator is unproven, one
   * RPC scan at a time. Unknown stays monitored and retries with growing backoff
   * until the watch window ends; a verdict releases or drops its held alerts.
   */
  async creatorStep(): Promise<number> {
    const verify = this.hooks.verifyCreator;
    if (!verify) return 0;
    const jobs = this.db.launchesAwaitingCreatorPrioritized(this.now(), CREATOR_BATCH);
    for (const job of jobs) {
      if (this.abort.signal.aborted) return jobs.length;
      let verdict: "eligible" | "ineligible" | "unknown" = "unknown";
      try {
        verdict = await verify(job.creator, job.base_mint);
      } catch (err) {
        log.warn(`creator verification error for ${job.creator}`, err instanceof Error ? err.message : String(err));
      }
      // Pace the scans: ~1 per CREATOR_PACE_MS so re-verifying a large backlog
      // can never hammer the RPC (each scan is a heavy getProgramAccounts call).
      await this.wait(CREATOR_PACE_MS);
      if (verdict === "unknown") {
        // 10s, 20s, 40s ... capped at 5 min, with jitter.
        const delay = Math.min(10_000 * 2 ** job.creator_attempts, 300_000);
        this.db.rescheduleCreatorCheck(job.base_mint, this.now() + delay + jitter(2000));
        continue;
      }
      // The verdict is per creator: resolve every launch of theirs that was waiting.
      for (const l of this.db.launchesByCreatorPending(job.creator)) {
        const r = this.db.resolveCreator(l.base_mint, verdict === "eligible");
        log.info(
          `creator ${job.creator} ${verdict}: ${l.base_mint} released=${r.released} dropped=${r.dropped}`
        );
      }
    }
    return jobs.length;
  }

  /** Log + return a backoff; on 429/5xx pause the whole limiter for everyone. */
  private backoff(label: string, err: unknown, limiter: RateLimiter): number {
    if (err instanceof DexScreenerError) {
      const wait = err.retryAfterMs ?? 5000 + jitter(2000);
      log.warn(`DEX Screener ${label} ${err.status}; pausing ${label} for ${wait}ms`);
      limiter.blockFor(wait);
      return wait;
    }
    log.warn(`DEX Screener ${label} error`, err instanceof Error ? err.message : String(err));
    return 5000;
  }
}

export type { LaunchRow };

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}
