import { describe, it, expect } from "vitest";
import { Db } from "../src/db.js";
import {
  diffSocials,
  diffOrders,
  infoToSnapshotRow,
  pollOrders,
  pollSocials,
  applySocialBatch,
  runOrderCheck,
  fingerprintOf,
  isFullInfo,
  PROFILE_ORDER_TYPE,
  ORDER_CHECK_WINDOW_MS,
  type TrackerDeps,
} from "../src/tracker.js";
import type { TokenInfo, OrderEntry } from "../src/dexscreener/client.js";
import { parseOrders, emptyTokenInfo, normalizeImageUrl } from "../src/dexscreener/client.js";

function deps(db: Db): TrackerDeps {
  return {
    db,
    formatOrder: (m, c, b) => `order ${m} ${c.status} baseline=${b}`,
    formatSocial: (m, _d, b) => `social ${m} baseline=${b}`,
  };
}

const emptyInfo = (over: Partial<TokenInfo> = {}): TokenInfo => ({
  ...emptyTokenInfo(),
  present: true,
  ...over,
});

/** A complete DEX Screener profile (icon + banner + a link). */
const fullInfo = (over: Partial<TokenInfo> = {}): TokenInfo =>
  emptyInfo({
    hasInfo: true,
    imageUrl: "https://cdn.dexscreener.com/cms/images/ICON",
    headerUrl: "https://cdn.dexscreener.com/cms/images/HEADER",
    websites: ["https://a"],
    socials: [{ type: "twitter", url: "x1" }],
    ...over,
  });

function addLaunch(db: Db, mint = "m", origin: "live" | "backfill" = "live") {
  db.insertLaunch({
    pool: `p-${mint}`, base_mint: mint, creator: "c", signature: null,
    detected_at: Date.now(), watch_until: Date.now() + 3_600_000, eligible: true, origin,
  });
  db.upsertCreator("c", 1, "eligible"); // verified, so alerts are sent rather than held
}

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
    addLaunch(db);
    const r = await pollOrders(deps(db), "m", stub("approved"), { silent: true });
    expect(r.baseline).toBe(true);
    expect(db.getOrders("m")).toHaveLength(1);
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(0);
    db.close();
  });

  it("alerts a transition exactly once", async () => {
    const db = new Db(":memory:");
    addLaunch(db);
    const d = deps(db);
    await pollOrders(d, "m", stub("processing"), { silent: true });
    expect((await pollOrders(d, "m", stub("processing"))).changes).toHaveLength(0);
    const r = await pollOrders(d, "m", stub("approved"));
    expect(r.changes[0]!.previousStatus).toBe("processing");
    await pollOrders(d, "m", stub("approved"));
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(1);
    db.close();
  });

  it("an order without paymentTimestamp is one row, not one per poll", async () => {
    const db = new Db(":memory:");
    addLaunch(db);
    const d = deps(db);
    const noTs = async () => [{ type: PROFILE_ORDER_TYPE, status: "approved" } as OrderEntry];
    for (let i = 0; i < 3; i++) await pollOrders(d, "m", noTs);
    expect(db.getOrders("m")).toHaveLength(1);
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(1);
    db.close();
  });
});

describe("fingerprint / full info", () => {
  it("is independent of ordering and of image size/cache params", () => {
    const a = fullInfo({ websites: ["https://b", "https://a"], socials: [{ type: "twitter", url: "x1" }, { type: "telegram", url: "t1" }] });
    const b = fullInfo({ websites: ["https://a", "https://b"], socials: [{ type: "telegram", url: "t1" }, { type: "twitter", url: "x1" }] });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
    expect(normalizeImageUrl("https://cdn.x/img/ID?width=800&quality=95&timestamp=1")).toBe("https://cdn.x/img/ID");
  });
  it("changes when a link or image really changes", () => {
    const base = fingerprintOf(fullInfo());
    expect(fingerprintOf(fullInfo({ websites: ["https://other"] }))).not.toBe(base);
    expect(fingerprintOf(fullInfo({ imageUrl: "https://cdn.dexscreener.com/cms/images/NEW" }))).not.toBe(base);
  });
  it("isFullInfo needs icon, banner and a link", () => {
    expect(isFullInfo(fullInfo())).toBe(true);
    expect(isFullInfo(fullInfo({ imageUrl: null }))).toBe(false);
    expect(isFullInfo(fullInfo({ headerUrl: null }))).toBe(false);
    expect(isFullInfo(fullInfo({ websites: [], socials: [] }))).toBe(false);
  });
});

describe("applySocialBatch", () => {
  const batch = (db: Db, info: TokenInfo, mint = "m") =>
    applySocialBatch(deps(db), [mint], new Map([[mint, info]]));
  const alerts = (db: Db) => db.claimPendingOutbox(Date.now(), 50);

  it("first response is the silent baseline: no social alert, baseline_done set", () => {
    const db = new Db(":memory:");
    addLaunch(db);
    const r = batch(db, fullInfo());
    expect(r.baselined).toEqual(["m"]);
    expect(db.getLaunchByMint("m")!.baseline_done).toBe(1);
    expect(alerts(db)).toHaveLength(0);
    db.close();
  });

  it("a live launch whose FIRST snapshot is already full queues one order check", () => {
    const db = new Db(":memory:");
    addLaunch(db);
    const r = batch(db, fullInfo());
    expect(r.orderChecksQueued).toEqual(["m"]);
    expect(db.getOrderCheck("m")!.reason).toBe("baseline_info");
    expect(alerts(db)).toHaveLength(0);
    db.close();
  });

  it("a backfilled launch's first full snapshot does NOT queue an order check", () => {
    const db = new Db(":memory:");
    addLaunch(db, "m", "backfill");
    expect(batch(db, fullInfo()).orderChecksQueued).toEqual([]);
    db.close();
  });

  it("empty baseline then profile appears: queues an order check and alerts the new links", () => {
    const db = new Db(":memory:");
    addLaunch(db);
    batch(db, emptyInfo()); // baseline, nothing there
    expect(db.getOrderCheck("m")).toBeUndefined();
    const r = batch(db, fullInfo());
    expect(r.orderChecksQueued).toEqual(["m"]);
    expect(db.getOrderCheck("m")!.reason).toBe("info_appeared");
    expect(r.alerted).toEqual(["m"]);
    db.close();
  });

  it("no change -> no alert and no new order check", () => {
    const db = new Db(":memory:");
    addLaunch(db);
    batch(db, fullInfo());
    const r = batch(db, fullInfo());
    expect(r.alerted).toEqual([]);
    expect(r.orderChecksQueued).toEqual([]);
    expect(alerts(db)).toHaveLength(0);
    db.close();
  });

  it("icon-only change queues an order check but is not a social alert", () => {
    const db = new Db(":memory:");
    addLaunch(db);
    batch(db, fullInfo());
    db.finishOrderCheck("m", "done");
    const r = batch(db, fullInfo({ imageUrl: "https://cdn.dexscreener.com/cms/images/NEWICON" }));
    expect(r.orderChecksQueued).toEqual(["m"]);
    expect(db.getOrderCheck("m")!.reason).toBe("info_changed");
    expect(r.alerted).toEqual([]);
    db.close();
  });

  it("a newly added link alerts once", () => {
    const db = new Db(":memory:");
    addLaunch(db);
    batch(db, fullInfo());
    batch(db, fullInfo({ socials: [{ type: "twitter", url: "x1" }, { type: "telegram", url: "t1" }] }));
    expect(alerts(db)).toHaveLength(1);
    db.close();
  });

  it("a mint missing from the response is not a removal", () => {
    const db = new Db(":memory:");
    addLaunch(db);
    batch(db, fullInfo());
    const r = batch(db, emptyTokenInfo()); // present:false
    expect(r.seen).toEqual([]);
    expect(JSON.parse(db.getSnapshot("m")!.websites_json)).toEqual(["https://a"]);
    expect(alerts(db)).toHaveLength(0);
    db.close();
  });

  it("a removal needs two consecutive sightings before it is applied", () => {
    const db = new Db(":memory:");
    addLaunch(db);
    batch(db, fullInfo());
    const thin = fullInfo({ socials: [] }); // x link vanished
    batch(db, thin);
    expect(JSON.parse(db.getSnapshot("m")!.socials_json)).toHaveLength(1); // not yet applied
    expect(alerts(db)).toHaveLength(0);
    batch(db, thin);
    expect(JSON.parse(db.getSnapshot("m")!.socials_json)).toHaveLength(0); // confirmed
    expect(alerts(db)).toHaveLength(1);
    db.close();
  });

  it("a one-off thin response that recovers leaves no alert behind", () => {
    const db = new Db(":memory:");
    addLaunch(db);
    batch(db, fullInfo());
    batch(db, fullInfo({ socials: [] })); // blip
    batch(db, fullInfo());                // back to normal
    expect(alerts(db)).toHaveLength(0);
    db.close();
  });
});

describe("runOrderCheck", () => {
  const ord = (status: string): (() => Promise<OrderEntry[]>) =>
    async () => [{ type: PROFILE_ORDER_TYPE, status, paymentTimestamp: 5 }];
  const none = async () => [] as OrderEntry[];

  function job(db: Db, now = Date.now()) {
    addLaunch(db);
    db.enqueueOrderCheck("m", "info_appeared", now, ORDER_CHECK_WINDOW_MS);
  }

  it("approved order alerts once and finishes the job", async () => {
    const db = new Db(":memory:");
    job(db);
    expect(await runOrderCheck(deps(db), "m", { fetchOrders: ord("approved") })).toBe("done");
    expect(db.getOrderCheck("m")!.status).toBe("done");
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(1);
    db.close();
  });

  it("no order yet -> retry with a later next_attempt_at, no alert", async () => {
    const db = new Db(":memory:");
    const t0 = Date.now();
    job(db, t0);
    expect(await runOrderCheck(deps(db), "m", { fetchOrders: none, now: t0 })).toBe("retry");
    const j = db.getOrderCheck("m")!;
    expect(j.status).toBe("pending");
    expect(j.attempts).toBe(1);
    expect(j.next_attempt_at).toBeGreaterThan(t0);
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(0);
    db.close();
  });

  it("processing then approved: both alert, job ends only on approved", async () => {
    const db = new Db(":memory:");
    const t0 = Date.now();
    job(db, t0);
    expect(await runOrderCheck(deps(db), "m", { fetchOrders: ord("processing"), now: t0 })).toBe("retry");
    expect(await runOrderCheck(deps(db), "m", { fetchOrders: ord("approved"), now: t0 + 20_000 })).toBe("done");
    expect(db.claimPendingOutbox(Date.now(), 50)).toHaveLength(2);
    db.close();
  });

  it("gives up after the 10 minute deadline", async () => {
    const db = new Db(":memory:");
    const t0 = Date.now();
    job(db, t0);
    const late = t0 + ORDER_CHECK_WINDOW_MS + 1;
    expect(await runOrderCheck(deps(db), "m", { fetchOrders: none, now: late })).toBe("expired");
    expect(db.getOrderCheck("m")!.status).toBe("expired");
    db.close();
  });

  it("a pending job is not extended by another trigger; an expired one reopens", () => {
    const db = new Db(":memory:");
    const t0 = 1_000_000;
    addLaunch(db);
    db.enqueueOrderCheck("m", "info_appeared", t0, ORDER_CHECK_WINDOW_MS);
    db.enqueueOrderCheck("m", "info_changed", t0 + 5 * 60_000, ORDER_CHECK_WINDOW_MS);
    expect(db.getOrderCheck("m")!.deadline_at).toBe(t0 + ORDER_CHECK_WINDOW_MS); // unchanged
    db.finishOrderCheck("m", "expired");
    db.enqueueOrderCheck("m", "info_changed", t0 + 20 * 60_000, ORDER_CHECK_WINDOW_MS);
    const j = db.getOrderCheck("m")!;
    expect(j.status).toBe("pending");
    expect(j.deadline_at).toBe(t0 + 20 * 60_000 + ORDER_CHECK_WINDOW_MS);
    db.close();
  });

  it("survives a restart: the job is in the DB, not in memory", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "dbc-q-"));
    const path = join(dir, "q.db");
    try {
      const a = new Db(path);
      job(a);
      a.close();
      const b = new Db(path);
      expect(b.dueOrderChecks(Date.now() + 1, 10).map((j) => j.base_mint)).toEqual(["m"]);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pollSocials wrapper", () => {
  it("returns only the mints present in the response", async () => {
    const db = new Db(":memory:");
    addLaunch(db, "a");
    addLaunch(db, "b");
    const seen = await pollSocials(deps(db), ["a", "b"], async () => new Map([["a", fullInfo()], ["b", emptyTokenInfo()]]));
    expect(seen).toEqual(["a"]);
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

  it("ignores boosts and still accepts a bare array", () => {
    expect(parseOrders({ orders: [], boosts: [{ id: "x", amount: 30 }] })).toEqual([]);
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

describe("paid-alert age label", () => {
  it("shows how long ago it was paid and flags a late catch-up", async () => {
    const { makeOrderFormatter, formatAge } = await import("../src/format.js");
    const now = 1_800_000_000_000;
    const fmt = makeOrderFormatter(() => ({ creator: "c", launchCount: 1 }), () => now);
    const fresh = fmt("m", { type: "tokenProfile", status: "approved", paymentTimestamp: now - 2 * 60_000 }, false);
    expect(fresh).toContain("Paid: 2 min ago");
    expect(fresh).not.toContain("late");
    const late = fmt("m", { type: "tokenProfile", status: "approved", paymentTimestamp: now - 93 * 60_000 }, false);
    expect(late).toContain("Paid: 1 h 33 min ago (late catch-up)");
    expect(formatAge(now - 20_000, now)).toBe("just now");
    expect(formatAge(now - 30_000, now)).toBe("1 min ago"); // rounds to the nearest minute
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
  it("omits the line when there is no usable timestamp", async () => {
    const { makeOrderFormatter } = await import("../src/format.js");
    const fmt = makeOrderFormatter(() => ({ creator: "c", launchCount: 1 }), () => 1_800_000_000_000);
    expect(fmt("m", { type: "tokenProfile", status: "approved" }, false)).not.toContain("Paid:");
  });
});
