import { describe, it, expect } from "vitest";
import { Db } from "../src/db.js";

function mem() {
  return new Db(":memory:");
}

describe("Db enqueueEvent dedup", () => {
  it("enqueues once per event key and writes outbox atomically", () => {
    const db = mem();
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
  it("applies 001 + 002 once and exposes baseline_done", () => {
    const db = mem();
    const applied = db.raw.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    expect(applied.map((r) => r.name)).toEqual(["001-init.sql", "002-baseline.sql"]);
    db.insertLaunch({
      pool: "p", base_mint: "m", creator: "c", signature: null,
      detected_at: 1, watch_until: Date.now() + 1000, eligible: true,
    });
    expect(db.getLaunchByMint("m")!.baseline_done).toBe(0);
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
