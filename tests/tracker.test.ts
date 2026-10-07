import { describe, it, expect } from "vitest";
import { Db } from "../src/db.js";
import {
  diffSocials,
  diffOrders,
  infoToSnapshotRow,
  pollOrders,
  pollSocials,
  PROFILE_ORDER_TYPE,
  type TrackerDeps,
} from "../src/tracker.js";
import type { TokenInfo, OrderEntry } from "../src/dexscreener/client.js";

function deps(db: Db): TrackerDeps {
  return {
    db,
    formatOrder: (m, c, b) => `order ${m} ${c.status} baseline=${b}`,
    formatSocial: (m, _d, b) => `social ${m} baseline=${b}`,
  };
}

const emptyInfo = (over: Partial<TokenInfo> = {}): TokenInfo => ({
  present: true,
  hasInfo: false,
  websites: [],
  socials: [],
  ...over,
});

describe("diffSocials", () => {
  it("returns null when nothing changed", () => {
    const row = infoToSnapshotRow("m", emptyInfo({ hasInfo: true, websites: ["https://a"] }), 1);
    const diff = diffSocials(row, emptyInfo({ hasInfo: true, websites: ["https://a"] }));
    expect(diff).toBeNull();
  });

  it("detects added + removed website and socials", () => {
    const prev = infoToSnapshotRow(
      "m",
      emptyInfo({ hasInfo: true, websites: ["https://old"], socials: [{ type: "twitter", url: "x1" }] }),
      1
    );
    const diff = diffSocials(
      prev,
      emptyInfo({
        hasInfo: true,
        websites: ["https://new"],
        socials: [{ type: "telegram", url: "tg1" }],
      })
    );
    expect(diff).not.toBeNull();
    expect(diff!.websitesAdded).toEqual(["https://new"]);
    expect(diff!.websitesRemoved).toEqual(["https://old"]);
    expect(diff!.socialsAdded.map((s) => s.url)).toEqual(["tg1"]);
    expect(diff!.socialsRemoved.map((s) => s.url)).toEqual(["x1"]);
  });
});

describe("diffOrders", () => {
  const stored = [
    { base_mint: "m", order_type: "tokenProfile", status: "processing", payment_ts: 100, updated_at: 1 },
  ];
  it("ignores non-profile order types", () => {
    const fresh: OrderEntry[] = [{ type: "tokenAd", status: "approved", paymentTimestamp: 1 }];
    expect(diffOrders([], fresh)).toHaveLength(0);
  });
  it("detects new profile order", () => {
    const fresh: OrderEntry[] = [{ type: PROFILE_ORDER_TYPE, status: "processing", paymentTimestamp: 1 }];
    const c = diffOrders([], fresh);
    expect(c).toHaveLength(1);
    expect(c[0]!.previousStatus).toBeUndefined();
  });
  it("detects status transition", () => {
    const fresh: OrderEntry[] = [{ type: PROFILE_ORDER_TYPE, status: "approved", paymentTimestamp: 100 }];
    const c = diffOrders(stored, fresh);
    expect(c).toHaveLength(1);
    expect(c[0]!.previousStatus).toBe("processing");
    expect(c[0]!.status).toBe("approved");
  });
  it("no change when status identical", () => {
    const fresh: OrderEntry[] = [{ type: PROFILE_ORDER_TYPE, status: "processing", paymentTimestamp: 100 }];
    expect(diffOrders(stored, fresh)).toHaveLength(0);
  });
});

describe("pollOrders", () => {
  it("baseline then transition enqueues deduped events", async () => {
    const db = new Db(":memory:");
    const d = deps(db);
    const stub = (status: string): ((m: string) => Promise<OrderEntry[]>) =>
      async () => [{ type: PROFILE_ORDER_TYPE, status, paymentTimestamp: 7 }];

    const r1 = await pollOrders(d, "m", stub("processing"));
    expect(r1.baseline).toBe(true);
    expect(r1.changes).toHaveLength(1);

    // same status again -> no new event
    const r2 = await pollOrders(d, "m", stub("processing"));
    expect(r2.changes).toHaveLength(0);

    // transition -> new event
    const r3 = await pollOrders(d, "m", stub("approved"));
    expect(r3.changes).toHaveLength(1);
    expect(r3.changes[0]!.previousStatus).toBe("processing");

    const pending = db.claimPendingOutbox(Date.now(), 50);
    expect(pending).toHaveLength(2); // one per real change
    db.close();
  });
});

describe("pollSocials", () => {
  it("absent response is not treated as removal", async () => {
    const db = new Db(":memory:");
    const d = deps(db);
    // baseline with a website
    await pollSocials(d, ["m"], async () =>
      new Map([["m", emptyInfo({ hasInfo: true, websites: ["https://a"] })]])
    );
    // next poll: mint absent (present=false) -> must NOT enqueue a removal
    await pollSocials(d, ["m"], async () =>
      new Map([["m", { present: false, hasInfo: false, websites: [], socials: [] }]])
    );
    const snap = db.getSnapshot("m");
    expect(JSON.parse(snap!.websites_json)).toEqual(["https://a"]); // unchanged
    db.close();
  });

  it("empty baseline (no info) does not alert, later real add does", async () => {
    const db = new Db(":memory:");
    const d = deps(db);
    await pollSocials(d, ["m"], async () =>
      new Map([["m", emptyInfo({ hasInfo: false })]])
    );
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(0);

    await pollSocials(d, ["m"], async () =>
      new Map([["m", emptyInfo({ hasInfo: true, websites: ["https://x"] })]])
    );
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(1);
    db.close();
  });
});
