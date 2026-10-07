import { describe, it, expect } from "vitest";
import { Db } from "../src/db.js";
import { seedBaseline, pollOrders, PROFILE_ORDER_TYPE, type TrackerDeps } from "../src/tracker.js";
import type { OrderEntry, TokenInfo } from "../src/dexscreener/client.js";

/**
 * Scenario for the user's requirement: a live launch buys the $299 profile
 * AFTER the bot started watching it, and nothing else should alert.
 */
describe("live launch -> $299 order end to end", () => {
  const deps = (db: Db): TrackerDeps => ({
    db,
    formatOrder: (m, c) => c.previousStatus ? `ORDER ${m} ${c.previousStatus}->${c.status}` : `ORDER ${m} -${c.status}`,
    formatSocial: (m) => `SOCIAL ${m}`,
  });
  const info: TokenInfo = { present: true, hasInfo: false, websites: [], socials: [] };
  const sent = (db: Db) => db.claimPendingOutbox(Date.now(), 50).map((r) => r.text);

  it("alerts once when the order appears, never before, never twice", async () => {
    const db = new Db(":memory:");
    const d = deps(db);
    db.insertLaunch({
      pool: "p", base_mint: "m", creator: "c", signature: null,
      detected_at: Date.now(), watch_until: Date.now() + 60_000, eligible: true, origin: "live",
    });

    let orders: OrderEntry[] = []; // nothing paid yet
    const fetchOrders = async () => orders;

    await seedBaseline(d, "m", { origin: "live", fetchOrders, fetchInfo: async () => new Map([["m", info]]) });
    await pollOrders(d, "m", fetchOrders);
    expect(sent(db)).toEqual([]); // no order yet -> silence

    orders = [{ type: PROFILE_ORDER_TYPE, status: "processing", paymentTimestamp: 42 }];
    await pollOrders(d, "m", fetchOrders);
    orders = [{ type: PROFILE_ORDER_TYPE, status: "approved", paymentTimestamp: 42 }];
    await pollOrders(d, "m", fetchOrders);
    await pollOrders(d, "m", fetchOrders); // repeat poll, no change

    const alerts = sent(db);
    expect(alerts).toEqual(["ORDER m -processing", "ORDER m processing->approved"]);
    db.close();
  });
});
