import { describe, it, expect } from "vitest";
import { Db } from "../src/db.js";
import { PROFILE_ORDER_TYPE, type TrackerDeps } from "../src/tracker.js";
import { PollScheduler } from "../src/scheduler.js";
import { emptyTokenInfo, type OrderEntry, type TokenInfo } from "../src/dexscreener/client.js";

/**
 * End to end through the real scheduler (injected clock + fetchers): a live
 * launch gets a baseline, later buys the profile, and exactly the right alerts
 * come out — no per-token order polling in between.
 */
describe("live launch -> paid profile, through PollScheduler", () => {
  const deps = (db: Db): TrackerDeps => ({
    db,
    formatOrder: (m, c) =>
      c.previousStatus ? `ORDER ${m} ${c.previousStatus}->${c.status}` : `ORDER ${m} -${c.status}`,
    formatSocial: (m) => `SOCIAL ${m}`,
  });
  const full = (): TokenInfo => ({
    ...emptyTokenInfo(),
    present: true,
    hasInfo: true,
    imageUrl: "https://cdn/i",
    headerUrl: "https://cdn/h",
    websites: ["https://a"],
    socials: [{ type: "twitter", url: "x1" }],
  });
  const none = (): TokenInfo => ({ ...emptyTokenInfo(), present: true });
  const sent = (db: Db) => db.claimPendingOutbox(Date.now() + 1e9, 100).map((r) => r.text);

  function rig() {
    const db = new Db(":memory:");
    let clock = Date.now();
    let info: TokenInfo = none();
    let orders: OrderEntry[] = [];
    let orderCalls = 0;
    db.insertLaunch({
      pool: "p", base_mint: "m", creator: "c", signature: null,
      detected_at: clock, watch_until: clock + 86_400_000, eligible: true, origin: "live",
    });
    const sch = new PollScheduler(db, deps(db), { ordersRpm: 6000, tokensRpm: 6000, pollIntervalMs: 60_000 }, {
      now: () => clock,
      fetchInfo: async (mints) => new Map(mints.map((m) => [m, info])),
      fetchOrders: async () => {
        orderCalls++;
        return orders;
      },
    });
    return {
      db, sch,
      advance: (ms: number) => (clock += ms),
      setInfo: (i: TokenInfo) => (info = i),
      setOrders: (o: OrderEntry[]) => (orders = o),
      orderCalls: () => orderCalls,
    };
  }

  it("never polls orders for a token whose profile never changes", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      await r.sch.socialStep();
      await r.sch.orderStep();
      r.advance(61_000);
    }
    expect(r.orderCalls()).toBe(0);
    expect(sent(r.db)).toEqual([]);
    r.db.close();
  });

  it("baseline, then profile appears: exactly the paid-order alert plus the new-links alert", async () => {
    const r = rig();
    await r.sch.socialStep(); // baseline (empty profile)
    expect(r.db.getLaunchByMint("m")!.baseline_done).toBe(1);
    expect(sent(r.db)).toEqual([]);

    r.advance(61_000);
    r.setInfo(full()); // dev buys the profile: info appears
    await r.sch.socialStep();
    expect(r.db.getOrderCheck("m")!.status).toBe("pending");

    // Orders endpoint lags: first check sees nothing, second sees the order.
    await r.sch.orderStep();
    expect(r.orderCalls()).toBe(1);
    r.setOrders([{ type: PROFILE_ORDER_TYPE, status: "approved", paymentTimestamp: 42 }]);
    r.advance(130_000);
    await r.sch.orderStep();
    r.advance(130_000);
    await r.sch.orderStep(); // nothing left to do
    expect(r.orderCalls()).toBe(2);

    expect(sent(r.db).sort()).toEqual(["ORDER m -approved", "SOCIAL m"].sort());
    r.db.close();
  });

  it("an order that exists at the first poll is still caught (live launch, no baseline for orders)", async () => {
    const r = rig();
    r.setInfo(full());
    r.setOrders([{ type: PROFILE_ORDER_TYPE, status: "approved", paymentTimestamp: 1 }]);
    await r.sch.socialStep(); // first snapshot is already full -> order check queued, no social alert
    expect(sent(r.db)).toEqual([]);
    await r.sch.orderStep();
    expect(sent(r.db)).toEqual(["ORDER m -approved"]);
    r.db.close();
  });

  it("a 429 on the order endpoint pauses orders only; socials keep running", async () => {
    const r = rig();
    const { DexScreenerError } = await import("../src/dexscreener/client.js");
    let calls = 0;
    const sch = new PollScheduler(r.db, deps(r.db), { ordersRpm: 6000, tokensRpm: 6000, pollIntervalMs: 60_000 }, {
      now: () => Date.now(),
      fetchInfo: async (mints) => new Map(mints.map((m) => [m, full()])),
      fetchOrders: async () => {
        calls++;
        throw new DexScreenerError("429", 429, 40);
      },
    });
    await sch.socialStep();
    await sch.orderStep();
    expect(calls).toBe(1);
    expect(sch.ordersRl.msUntilToken()).toBeGreaterThan(0); // orders paused
    expect(sch.tokensRl.msUntilToken()).toBe(0); // socials unaffected
    expect(r.db.getOrderCheck("m")!.status).toBe("pending"); // job kept for retry
    r.db.close();
  });
});
