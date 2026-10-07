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
