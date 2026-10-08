import { describe, it, expect } from "vitest";
import { Db } from "../src/db.js";

function mem() {
  return new Db(":memory:");
}

/** A launch whose creator is proven eligible, so its alerts are sent, not held. */
export function verifiedLaunch(db: Db, mint = "m", creator = "c") {
  db.insertLaunch({
    pool: `p-${mint}`, base_mint: mint, creator, signature: null,
    detected_at: Date.now(), watch_until: Date.now() + 3_600_000, eligible: true,
  });
  db.upsertCreator(creator, 1, "eligible");
}

describe("Db enqueueEvent dedup", () => {
  it("enqueues once per event key and writes outbox atomically", () => {
    const db = mem();
    verifiedLaunch(db);
    const first = db.enqueueEvent({ eventKey: "k1", baseMint: "m", kind: "order", text: "hi" });
    const second = db.enqueueEvent({ eventKey: "k1", baseMint: "m", kind: "order", text: "hi" });
    expect(first).toBe(true);
    expect(second).toBe(false);
    const pending = db.claimPendingOutbox(Date.now());
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toBe("hi");
    db.close();
  });

  it("outbox lifecycle: sent / retry", () => {
    const db = mem();
    verifiedLaunch(db);
    db.enqueueEvent({ eventKey: "k2", baseMint: "m", kind: "social", text: "x" });
    const [row] = db.claimPendingOutbox(Date.now());
    db.markOutboxRetry(row!.id, Date.now() + 10_000, "boom");
    expect(db.claimPendingOutbox(Date.now())).toHaveLength(0); // not due yet
    expect(db.claimPendingOutbox(Date.now() + 11_000)).toHaveLength(1);
    db.markOutboxSent(row!.id);
    expect(db.claimPendingOutbox(Date.now() + 11_000)).toHaveLength(0);
    db.close();
  });
});

describe("Db launches + creators", () => {
  it("insertLaunch is idempotent per base_mint and tracks active window", () => {
    const db = mem();
    const base = {
      pool: "p1",
      base_mint: "mint1",
      creator: "c1",
      signature: "sig",
      detected_at: Date.now(),
      watch_until: Date.now() + 60_000,
    };
    expect(db.insertLaunch({ ...base, eligible: true })).toBe(true);
    expect(db.insertLaunch({ ...base, eligible: true })).toBe(false);
    expect(db.activeLaunches(Date.now())).toHaveLength(1);
    expect(db.activeLaunches(Date.now() + 120_000)).toHaveLength(0); // window passed
    db.close();
  });

  it("creator eligibility persists and overrides unknown", () => {
    const db = mem();
    db.upsertCreator("c1", null, "unknown");
    expect(db.getCreator("c1")?.eligibility).toBe("unknown");
    db.upsertCreator("c1", 3, "eligible");
    expect(db.getCreator("c1")?.eligibility).toBe("eligible");
    expect(db.getCreator("c1")?.launch_count).toBe(3);
    db.close();
  });
});

describe("Db migrations", () => {
  it("applies all migrations once and exposes baseline_done/origin", () => {
    const db = mem();
    const applied = db.raw.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    expect(applied.map((r) => r.name)).toEqual([
      "001-init.sql",
      "002-baseline.sql",
      "003-launch-origin.sql",
      "004-monitoring-queues.sql",
      "005-reverify-legacy.sql",
    ]);
    db.insertLaunch({
      pool: "p", base_mint: "m", creator: "c", signature: null,
      detected_at: 1, watch_until: Date.now() + 1000, eligible: true,
    });
    expect(db.getLaunchByMint("m")!.baseline_done).toBe(0);
    expect(db.getLaunchByMint("m")!.origin).toBe("live");
    db.setBaselineDone("m");
    expect(db.getLaunchByMint("m")!.baseline_done).toBe(1);
    db.close();
  });

  it("upgrades a pre-tracking database (001 already applied, no schema_migrations)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFileSync } = await import("node:fs");
    const Database = (await import("better-sqlite3")).default;

    const dir = mkdtempSync(join(tmpdir(), "dbc-mig-"));
    const path = join(dir, "old.db");
    try {
      // Simulate the production DB created before migration tracking existed.
      const old = new Database(path);
      old.exec(readFileSync(join(process.cwd(), "src/migrations/001-init.sql"), "utf8"));
      old.prepare(
        "INSERT INTO launches (pool, base_mint, creator, detected_at, watch_until, eligible) VALUES ('p','m','c',1,2,1)"
      ).run();
      old.close();

      const db = new Db(path);
      expect(db.getLaunchByMint("m")!.baseline_done).toBe(0); // existing row gets default
      db.close();

      const again = new Db(path); // second open must not re-run ALTER TABLE
      expect(again.getLaunchByMint("m")).toBeDefined();
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration 004 on a production-shaped database", () => {
  async function legacyDb(withRows: (old: import("better-sqlite3").Database) => void) {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFileSync } = await import("node:fs");
    const Database = (await import("better-sqlite3")).default;
    const dir = mkdtempSync(join(tmpdir(), "dbc-m4-"));
    const path = join(dir, "prod.db");
    const old = new Database(path);
    // Exactly what the VPS has: 001..003 applied and recorded.
    old.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const f of ["001-init.sql", "002-baseline.sql", "003-launch-origin.sql"]) {
      old.exec(readFileSync(join(process.cwd(), "src/migrations", f), "utf8"));
      old.prepare("INSERT INTO schema_migrations VALUES (?, 1)").run(f);
    }
    withRows(old);
    old.close();
    return { dir, path };
  }

  it("dedups NULL-timestamp orders to one row and keeps the latest status", async () => {
    const { dir, path } = await legacyDb((old) => {
      const ins = old.prepare(
        "INSERT INTO orders (base_mint, order_type, status, payment_ts, updated_at) VALUES (?,?,?,?,?)"
      );
      ins.run("m", "tokenProfile", "processing", null, 100); // the NULL-key pile-up
      ins.run("m", "tokenProfile", "processing", null, 200);
      ins.run("m", "tokenProfile", "approved", null, 300);
      ins.run("m", "tokenProfile", "approved", 777, 50); // a real, distinct order
    });
    const { rmSync } = await import("node:fs");
    try {
      const db = new Db(path);
      const rows = db.getOrders("m").sort((a, b) => a.payment_ts - b.payment_ts);
      expect(rows.map((r) => [r.payment_ts, r.status])).toEqual([
        [0, "approved"], // latest of the three NULL rows
        [777, "approved"],
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps existing launches monitored, un-baselined and due, and forces creator re-verification", async () => {
    const { dir, path } = await legacyDb((old) => {
      old.prepare(
        "INSERT INTO launches (pool, base_mint, creator, detected_at, watch_until, eligible) VALUES ('p','m','c',1,?,1)"
      ).run(Date.now() + 3_600_000);
      const c = old.prepare("INSERT INTO creators (address, launch_count, eligibility, checked_at, created_at) VALUES (?,?,?,?,1)");
      c.run("good", 0, "eligible", 5); // the bogus 'count 0' verdicts from before
      c.run("serial", 14, "ineligible", 5); // a proven lower bound: kept
    });
    const { rmSync } = await import("node:fs");
    try {
      const db = new Db(path);
      const l = db.getLaunchByMint("m")!;
      expect(l.baseline_done).toBe(0); // nothing was recorded, so nothing is claimed
      expect(l.next_poll_at).toBe(0);
      expect(db.dueLaunches(Date.now(), 10).map((x) => x.base_mint)).toEqual(["m"]);
      expect(db.getCreator("good")!.eligibility).toBe("unknown");
      expect(db.getCreator("good")!.launch_count).toBeNull();
      expect(db.getCreator("serial")!.eligibility).toBe("ineligible");
      db.close();
      new Db(path).close(); // reopening must not re-run 004
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fail-closed alerting", () => {
  const mk = (db: Db, creator: string, opts: { eligible: boolean; pending: boolean }) =>
    db.insertLaunch({
      pool: "p", base_mint: "m", creator, signature: null, detected_at: Date.now(),
      watch_until: Date.now() + 3_600_000, eligible: opts.eligible, pendingCreator: opts.pending,
    });
  const status = (db: Db) =>
    (db.raw.prepare("SELECT status FROM outbox").all() as { status: string }[]).map((r) => r.status);

  it("holds an alert when the launch looks eligible but its creator verdict is unknown (the legacy-row leak)", () => {
    const db = mem();
    mk(db, "c", { eligible: true, pending: false }); // old row: flag says fine
    db.upsertCreator("c", null, "unknown");           // ...but 004 reset the verdict
    db.enqueueEvent({ eventKey: "k", baseMint: "m", kind: "order", text: "x" });
    expect(status(db)).toEqual(["held"]);
    db.close();
  });

  it("holds when there is no creator row at all", () => {
    const db = mem();
    mk(db, "ghost", { eligible: true, pending: false });
    db.enqueueEvent({ eventKey: "k", baseMint: "m", kind: "order", text: "x" });
    expect(status(db)).toEqual(["held"]);
    db.close();
  });

  it("holds when the mint has no launch row", () => {
    const db = mem();
    db.enqueueEvent({ eventKey: "k", baseMint: "nope", kind: "order", text: "x" });
    expect(status(db)).toEqual(["held"]);
    db.close();
  });

  it("sends immediately when both the launch and creator are verified eligible", () => {
    const db = mem();
    verifiedLaunch(db);
    db.enqueueEvent({ eventKey: "k", baseMint: "m", kind: "order", text: "x" });
    expect(status(db)).toEqual(["pending"]);
    db.close();
  });

  it("verdict eligible releases held alerts; ineligible drops them", () => {
    const db = mem();
    mk(db, "c", { eligible: false, pending: true });
    db.enqueueEvent({ eventKey: "k1", baseMint: "m", kind: "order", text: "x" });
    expect(status(db)).toEqual(["held"]);
    db.upsertCreator("c", 2, "eligible");
    expect(db.resolveCreator("m", true)).toEqual({ released: 1, dropped: 0 });
    expect(status(db)).toEqual(["pending"]);

    const db2 = mem();
    mk(db2, "c", { eligible: false, pending: true });
    db2.enqueueEvent({ eventKey: "k1", baseMint: "m", kind: "order", text: "x" });
    expect(db2.resolveCreator("m", false)).toEqual({ released: 0, dropped: 1 });
    expect(status(db2)).toEqual(["dropped"]);
    db.close();
    db2.close();
  });
});

describe("migration 005 on a production-shaped database", () => {
  it("re-queues verification for monitored launches whose creator is not proven, and leaves proven ones", async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const dir = mkdtempSync(join(tmpdir(), "dbc-m5-"));
    const path = join(dir, "prod.db");
    try {
      const old = new Database(path);
      old.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
      for (const f of ["001-init.sql", "002-baseline.sql", "003-launch-origin.sql", "004-monitoring-queues.sql"]) {
        old.exec(readFileSync(join(process.cwd(), "src/migrations", f), "utf8"));
        old.prepare("INSERT INTO schema_migrations VALUES (?, 1)").run(f);
      }
      const future = Date.now() + 3_600_000;
      const ins = old.prepare(
        "INSERT INTO launches (pool, base_mint, creator, detected_at, watch_until, eligible) VALUES (?,?,?,1,?,1)"
      );
      ins.run("p1", "unproven", "cU", future);
      ins.run("p2", "proven", "cP", future);
      ins.run("p3", "expired", "cU", Date.now() - 1000);
      old.prepare("INSERT INTO creators (address, launch_count, eligibility, checked_at, created_at) VALUES ('cU', NULL, 'unknown', 0, 1)").run();
      old.prepare("INSERT INTO creators (address, launch_count, eligibility, checked_at, created_at) VALUES ('cP', 2, 'eligible', 5, 1)").run();
      old.close();

      const db = new Db(path);
      const l = (m: string) => db.getLaunchByMint(m)!;
      expect([l("unproven").pending_creator, l("unproven").eligible]).toEqual([1, 0]);
      expect([l("proven").pending_creator, l("proven").eligible]).toEqual([0, 1]);
      expect(l("expired").pending_creator).toBe(0); // outside the window: not worth verifying
      expect(db.launchesAwaitingCreatorPrioritized(Date.now(), 10).map((x) => x.base_mint)).toEqual(["unproven"]);
      db.close();
      new Db(path).close(); // reopening must not re-run 005
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
