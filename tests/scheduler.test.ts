import { describe, it, expect } from "vitest";
import { RateLimiter, PollScheduler } from "../src/scheduler.js";
import { Db } from "../src/db.js";
import { emptyTokenInfo, DexScreenerError, type TokenInfo } from "../src/dexscreener/client.js";
import type { TrackerDeps } from "../src/tracker.js";

describe("RateLimiter", () => {
  it("starts with a small burst, then paces at rpm", () => {
    let t = 0;
    const rl = new RateLimiter(60, () => t); // 1/sec, burst = ceil(60/12) = 5
    const take = () => {
      expect(rl.msUntilToken()).toBe(0);
      (rl as any).tokens -= 1;
    };
    for (let i = 0; i < 5; i++) take();
    const wait = rl.msUntilToken();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1000);
    t += 1000;
    expect(rl.msUntilToken()).toBe(0);
  });

  it("does not hand out a whole minute of budget at once after idling", () => {
    let t = 0;
    const rl = new RateLimiter(240, () => t);
    t += 10 * 60_000; // idle 10 minutes
    let burst = 0;
    while (rl.msUntilToken() === 0 && burst < 1000) {
      (rl as any).tokens -= 1;
      burst++;
    }
    expect(burst).toBeLessThanOrEqual(20); // ceil(240/12)
  });

  it("blockFor pauses every consumer until the time passes", () => {
    let t = 0;
    const rl = new RateLimiter(60, () => t);
    rl.blockFor(5000);
    expect(rl.msUntilToken()).toBe(5000);
    t += 5000;
    expect(rl.msUntilToken()).toBe(0);
  });
});

/**
 * The reported failure: 1378 monitored tokens, none baselined, order polling
 * (1 request/token at ~50 rpm) hogging the loop. With independent workers the
 * social/baseline side must finish a full sweep on its own.
 */
describe("PollScheduler at production scale (1378 tokens)", () => {
  const N = 1378;
  const pending = (db: Db) =>
    (db.raw.prepare("SELECT COUNT(*) c FROM launches WHERE baseline_done = 0").get() as { c: number }).c;
  const count = (db: Db, sql: string) => (db.raw.prepare(sql).get() as { c: number }).c;
  const deps = (db: Db): TrackerDeps => ({
    db,
    formatOrder: (m) => `ORDER ${m}`,
    formatSocial: (m) => `SOCIAL ${m}`,
  });
  const profile = (): TokenInfo => ({ ...emptyTokenInfo(), present: true });

  function rig() {
    const db = new Db(":memory:");
    let clock = 1_000_000_000_000;
    const mints = Array.from({ length: N }, (_, i) => `mint${i}`);
    const ins = db.raw.prepare(
      `INSERT INTO launches (pool, base_mint, creator, detected_at, watch_until, eligible, origin)
       VALUES (?, ?, 'c', ?, ?, 1, 'live')`
    );
    db.raw.transaction(() => mints.forEach((m) => ins.run(`p-${m}`, m, clock, clock + 86_400_000)))();
    const calls = { info: 0, orders: 0, largest: 0 };
    // Waiting on a limiter advances the fake clock instead of blocking for real.
    const fakeSleep = async (ms: number) => {
      clock += ms;
    };
    const sch = new PollScheduler(db, deps(db), { ordersRpm: 50, tokensRpm: 240, pollIntervalMs: 60_000 }, {
      now: () => clock,
      sleep: fakeSleep,
      fetchInfo: async (batch) => {
        calls.info++;
        calls.largest = Math.max(calls.largest, batch.length);
        return new Map(batch.map((m) => [m, profile()]));
      },
      fetchOrders: async () => {
        calls.orders++;
        return [];
      },
    });
    return { db, sch, calls, tick: (ms: number) => (clock += ms), now: () => clock, fakeSleep };
  }

  it("baselines all 1378 tokens in ceil(1378/30)=46 requests, without a single order call", async () => {
    const { db, sch, calls } = rig();
    let guard = 0;
    while (pending(db) > 0 && guard++ < 200) {
      await sch.socialStep();
    }
    expect(calls.info).toBe(46);
    expect(calls.largest).toBe(30);
    expect(calls.orders).toBe(0);
    const row = db.raw.prepare("SELECT COUNT(*) c FROM token_snapshots").get() as { c: number };
    expect(row.c).toBe(N);
    db.close();
  });

  it("a backlog of order checks does not slow the social sweep", async () => {
    const { db, sch, calls, now } = rig();
    // 400 pending order jobs, far more than orders rpm can clear in a minute.
    for (let i = 0; i < 400; i++) db.enqueueOrderCheck(`mint${i}`, "info_appeared", now(), 600_000);
    let guard = 0;
    while (pending(db) > 0 && guard++ < 200) {
      await sch.socialStep(); // orders worker never runs here, and must not be needed
    }
    expect(calls.info).toBe(46);
    expect(count(db, "SELECT COUNT(*) c FROM order_checks WHERE status='pending'")).toBe(400);
    db.close();
  });

  it("tokens launched mid-sweep queue FIFO behind the backlog: nobody starves, and all finish", async () => {
    const { db, sch, tick, now } = rig();
    for (let i = 0; i < 20; i++) await sch.socialStep(); // partway through baselining
    db.insertLaunch({
      pool: "p-new", base_mint: "newtoken", creator: "c", signature: null,
      detected_at: now(), watch_until: now() + 86_400_000, eligible: true,
    });
    await sch.socialStep();
    // FIFO among un-baselined: the newcomer is behind the ~758 still waiting.
    expect(db.getLaunchByMint("newtoken")!.baseline_done).toBe(0);
    let steps = 0;
    while (pending(db) > 0 && steps < 200) {
      await sch.socialStep();
      steps++;
    }
    // ...but it is reached within the same sweep (<= 26 remaining batches of 30).
    expect(db.getLaunchByMint("newtoken")!.baseline_done).toBe(1);
    expect(steps).toBeLessThanOrEqual(26);
    // Once baselined, every token comes due again each interval.
    tick(61_000);
    expect(db.dueLaunches(now(), 5000).length).toBe(N + 1);
    db.close();
  });

  it("a thin/absent response retries soon instead of waiting a full interval", async () => {
    const { db, now, fakeSleep } = rig();
    const sch2 = new PollScheduler(db, deps(db), { ordersRpm: 50, tokensRpm: 240, pollIntervalMs: 60_000 }, {
      now,
      sleep: fakeSleep,
      fetchInfo: async (batch) => new Map(batch.map((m) => [m, emptyTokenInfo()])), // present:false
      fetchOrders: async () => [],
    });
    await sch2.socialStep();
    const row = db.getLaunchByMint("mint0")!;
    expect(row.baseline_done).toBe(0);
    expect(row.next_poll_at - now()).toBeLessThanOrEqual(15_000);
    expect(row.poll_attempts).toBe(1);
    db.close();
  });

  it("a 429 on the token endpoint reschedules the batch and pauses only that limiter", async () => {
    const { db, now, fakeSleep } = rig();
    const sch2 = new PollScheduler(db, deps(db), { ordersRpm: 50, tokensRpm: 240, pollIntervalMs: 60_000 }, {
      now,
      sleep: fakeSleep,
      fetchInfo: async () => {
        throw new DexScreenerError("429", 429, 20_000);
      },
      fetchOrders: async () => [],
    });
    await sch2.socialStep();
    expect(sch2.tokensRl.msUntilToken()).toBeGreaterThan(0);
    expect(sch2.ordersRl.msUntilToken()).toBe(0);
    expect(db.getLaunchByMint("mint0")!.next_poll_at).toBeGreaterThanOrEqual(now() + 20_000);
    db.close();
  });
});
