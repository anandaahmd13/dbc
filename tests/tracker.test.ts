import { describe, it, expect } from "vitest";
import { Db } from "../src/db.js";
import {
  diffSocials,
  diffOrders,
  infoToSnapshotRow,
  pollOrders,
  pollSocials,
  seedBaseline,
  PROFILE_ORDER_TYPE,
  type TrackerDeps,
} from "../src/tracker.js";
import type { TokenInfo, OrderEntry } from "../src/dexscreener/client.js";
import { parseOrders } from "../src/dexscreener/client.js";

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
  const stub = (status: string): ((m: string) => Promise<OrderEntry[]>) =>
    async () => [{ type: PROFILE_ORDER_TYPE, status, paymentTimestamp: 7 }];

  it("silent pass records state but never alerts", async () => {
    const db = new Db(":memory:");
    const d = deps(db);
    const r = await pollOrders(d, "m", stub("approved"), { silent: true });
    expect(r.baseline).toBe(true);
    expect(db.getOrders("m")).toHaveLength(1);
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(0);
    db.close();
  });

  it("after baseline: pre-existing approved order is NOT alerted, a transition IS (once)", async () => {
    const db = new Db(":memory:");
    const d = deps(db);
    await pollOrders(d, "m", stub("processing"), { silent: true }); // baseline

    // same status -> nothing
    expect((await pollOrders(d, "m", stub("processing"))).changes).toHaveLength(0);

    // processing -> approved ($299 paid) -> exactly one alert
    const r = await pollOrders(d, "m", stub("approved"));
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]!.previousStatus).toBe("processing");

    // repeat poll, no further change -> still one alert total
    await pollOrders(d, "m", stub("approved"));
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(1);
    db.close();
  });

  it("brand-new tokenProfile order after an empty baseline is alerted", async () => {
    const db = new Db(":memory:");
    const d = deps(db);
    await pollOrders(d, "m", async () => [], { silent: true }); // baseline: no orders
    const r = await pollOrders(d, "m", stub("approved"));
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]!.previousStatus).toBeUndefined();
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(1);
    db.close();
  });
});

describe("pollSocials", () => {
  it("absent response is not treated as removal", async () => {
    const db = new Db(":memory:");
    const d = deps(db);
    await pollSocials(d, ["m"], async () =>
      new Map([["m", emptyInfo({ hasInfo: true, websites: ["https://a"] })]]), { silent: true }
    );
    const seen = await pollSocials(d, ["m"], async () =>
      new Map([["m", { present: false, hasInfo: false, websites: [], socials: [] }]])
    );
    expect(seen).toEqual([]); // not reported as seen
    expect(JSON.parse(db.getSnapshot("m")!.websites_json)).toEqual(["https://a"]);
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(0);
    db.close();
  });

  it("silent baseline with existing socials does not alert; later change does", async () => {
    const db = new Db(":memory:");
    const d = deps(db);
    await pollSocials(d, ["m"], async () =>
      new Map([["m", emptyInfo({ hasInfo: true, websites: ["https://a"], socials: [{ type: "twitter", url: "x1" }] })]]),
      { silent: true }
    );
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(0);

    // unchanged -> no alert
    await pollSocials(d, ["m"], async () =>
      new Map([["m", emptyInfo({ hasInfo: true, websites: ["https://a"], socials: [{ type: "twitter", url: "x1" }] })]])
    );
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(0);

    // telegram added -> one alert
    await pollSocials(d, ["m"], async () =>
      new Map([["m", emptyInfo({ hasInfo: true, websites: ["https://a"], socials: [{ type: "twitter", url: "x1" }, { type: "telegram", url: "tg1" }] })]])
    );
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(1);
    db.close();
  });

  it("empty baseline then first socials appear -> alerted as a change", async () => {
    const db = new Db(":memory:");
    const d = deps(db);
    await pollSocials(d, ["m"], async () => new Map([["m", emptyInfo({ hasInfo: false })]]), { silent: true });
    await pollSocials(d, ["m"], async () =>
      new Map([["m", emptyInfo({ hasInfo: true, websites: ["https://x"] })]])
    );
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(1);
    db.close();
  });
});

describe("seedBaseline", () => {
  const present = (over: Partial<TokenInfo> = {}) => emptyInfo({ hasInfo: true, websites: ["https://a"], ...over });

  function launch(db: Db) {
    db.insertLaunch({
      pool: "p", base_mint: "m", creator: "c", signature: null,
      detected_at: Date.now(), watch_until: Date.now() + 60_000, eligible: true,
    });
  }

  const approved = async () => [
    { type: PROFILE_ORDER_TYPE, status: "approved", paymentTimestamp: 1 },
  ];

  it("live launch: socials baselined silently, orders left alone so a $299 order still alerts", async () => {
    const db = new Db(":memory:");
    launch(db);
    const ok = await seedBaseline(deps(db), "m", {
      origin: "live",
      fetchOrders: approved,
      fetchInfo: async () => new Map([["m", present()]]),
    });
    expect(ok).toBe(true);
    expect(db.getLaunchByMint("m")!.baseline_done).toBe(1);
    expect(db.getSnapshot("m")).toBeDefined();
    expect(db.getOrders("m")).toHaveLength(0); // orders NOT baselined for live launches
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(0);

    // The order is then read by the normal poll and alerts exactly once.
    await pollOrders(deps(db), "m", approved);
    await pollOrders(deps(db), "m", approved);
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(1);
    db.close();
  });

  it("backfilled launch: existing order is recorded silently (may predate us)", async () => {
    const db = new Db(":memory:");
    launch(db);
    const ok = await seedBaseline(deps(db), "m", {
      origin: "backfill",
      fetchOrders: approved,
      fetchInfo: async () => new Map([["m", present()]]),
    });
    expect(ok).toBe(true);
    expect(db.getOrders("m")).toHaveLength(1);
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(0);

    await pollOrders(deps(db), "m", approved); // same order again -> still silent
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(0);
    db.close();
  });

  it("does NOT mark done when DEX Screener has no pair data yet", async () => {
    const db = new Db(":memory:");
    launch(db);
    const ok = await seedBaseline(deps(db), "m", {
      fetchOrders: async () => [],
      fetchInfo: async () => new Map([["m", { present: false, hasInfo: false, websites: [], socials: [] }]]),
    });
    expect(ok).toBe(false);
    expect(db.getLaunchByMint("m")!.baseline_done).toBe(0);
    db.close();
  });
});

describe("parseOrders", () => {
  it("parses the live { orders, boosts } shape (BVNH tokenProfile approved)", () => {
    const live = {
      orders: [
        { chainId: "solana", tokenAddress: "BVNH", type: "tokenProfile", status: "approved", paymentTimestamp: 1791384517536 },
      ],
      boosts: [],
    };
    expect(parseOrders(live)).toEqual([
      { type: "tokenProfile", status: "approved", paymentTimestamp: 1791384517536 },
    ]);
  });

  it("still accepts a bare array", () => {
    expect(parseOrders([{ type: "tokenProfile", status: "processing" }])).toEqual([
      { type: "tokenProfile", status: "processing", paymentTimestamp: undefined },
    ]);
  });

  it("returns [] for junk", () => {
    expect(parseOrders(null)).toEqual([]);
    expect(parseOrders({})).toEqual([]);
    expect(parseOrders({ orders: "nope" })).toEqual([]);
    expect(parseOrders("x")).toEqual([]);
  });
});
