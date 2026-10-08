import { describe, it, expect } from "vitest";
import { Db } from "../src/db.js";
import { OutboxWorker } from "../src/outbox.js";
import { TelegramError, type TelegramSender, escapeHtml, clampMessage } from "../src/telegram.js";

class StubSender implements TelegramSender {
  sent: string[] = [];
  failTimes: number;
  retryAfterMs?: number;
  constructor(failTimes = 0, retryAfterMs?: number) {
    this.failTimes = failTimes;
    this.retryAfterMs = retryAfterMs;
  }
  async send(text: string): Promise<void> {
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new TelegramError("429", 429, this.retryAfterMs);
    }
    this.sent.push(text);
  }
}

function verified(db: Db, mint = "m") {
  db.insertLaunch({
    pool: `p-${mint}`, base_mint: mint, creator: "c", signature: null,
    detected_at: Date.now(), watch_until: Date.now() + 3_600_000, eligible: true,
  });
  db.upsertCreator("c", 1, "eligible");
}

describe("OutboxWorker", () => {
  it("delivers a pending message", async () => {
    const db = new Db(":memory:");
    verified(db);
    db.enqueueEvent({ eventKey: "e1", baseMint: "m", kind: "order", text: "hello" });
    const sender = new StubSender();
    const worker = new OutboxWorker(db, sender);
    await worker.drainOnce();
    expect(sender.sent).toEqual(["hello"]);
    db.close();
  });

  it("retries on 429 then succeeds, honoring retry_after", async () => {
    const db = new Db(":memory:");
    verified(db);
    db.enqueueEvent({ eventKey: "e2", baseMint: "m", kind: "order", text: "hi" });
    const sender = new StubSender(1, 50);
    const worker = new OutboxWorker(db, sender);

    await worker.drainOnce(); // fails -> scheduled ~50ms out
    expect(sender.sent).toHaveLength(0);
    // not yet due
    await worker.drainOnce(Date.now());
    expect(sender.sent).toHaveLength(0);
    // due after backoff
    await worker.drainOnce(Date.now() + 1000);
    expect(sender.sent).toEqual(["hi"]);
    db.close();
  });
});

describe("telegram helpers", () => {
  it("escapes HTML", () => {
    expect(escapeHtml('<a>&"')).toBe('&lt;a&gt;&amp;"');
  });
  it("clamps long messages", () => {
    const big = "x".repeat(5000);
    expect(clampMessage(big).length).toBeLessThanOrEqual(4096);
  });
});

describe("dry run is not a delivery", () => {
  const rows = (db: Db) =>
    (db.raw.prepare("SELECT status FROM outbox").all() as { status: string }[]).map((r) => r.status);

  it("a dry-run send keeps the alert recoverable instead of burning it", async () => {
    const { DryRunSender } = await import("../src/telegram.js");
    const db = new Db(":memory:");
    verified(db);
    db.enqueueEvent({ eventKey: "d1", baseMint: "m", kind: "order", text: "paid" });

    await new OutboxWorker(db, new DryRunSender()).drainOnce();
    expect(rows(db)).toEqual(["dryrun"]);
    // The event key is already recorded, so without recovery this alert would be gone.
    expect(db.enqueueEvent({ eventKey: "d1", baseMint: "m", kind: "order", text: "paid" })).toBe(false);

    // Going live delivers it exactly once.
    expect(db.releaseDryRun()).toEqual({ released: 1, held: 0 });
    const live = new StubSender();
    await new OutboxWorker(db, live).drainOnce();
    await new OutboxWorker(db, live).drainOnce();
    expect(live.sent).toEqual(["paid"]);
    expect(rows(db)).toEqual(["sent"]);
    db.close();
  });

  it("a real send is marked sent and never re-queued by releaseDryRun", async () => {
    const db = new Db(":memory:");
    verified(db);
    db.enqueueEvent({ eventKey: "d2", baseMint: "m", kind: "order", text: "x" });
    await new OutboxWorker(db, new StubSender()).drainOnce();
    expect(rows(db)).toEqual(["sent"]);
    expect(db.releaseDryRun()).toEqual({ released: 0, held: 0 });
    db.close();
  });
});

describe("going live after a dry run", () => {
  const status = (db: Db) =>
    (db.raw.prepare("SELECT status FROM outbox").all() as { status: string }[]).map((r) => r.status);

  it("a dry-run message whose creator is no longer proven is held, not sent", async () => {
    const { DryRunSender } = await import("../src/telegram.js");
    const db = new Db(":memory:");
    verified(db);
    db.enqueueEvent({ eventKey: "g1", baseMint: "m", kind: "order", text: "paid" });
    await new OutboxWorker(db, new DryRunSender()).drainOnce();
    db.upsertCreator("c", null, "unknown"); // verdict reset while it sat in dry-run
    expect(db.releaseDryRun()).toEqual({ released: 0, held: 1 });
    expect(status(db)).toEqual(["held"]);
    expect(db.claimPendingOutbox(Date.now(), 10)).toHaveLength(0);
    db.close();
  });

  it("a stale 'Paid: 1 min ago' frozen in old text is replaced from the real payment time", async () => {
    const { resolvePaidAge } = await import("../src/age.js");
    const db = new Db(":memory:");
    verified(db);
    const paidAt = Date.now() - 3 * 3_600_000; // actually paid 3 hours ago
    db.upsertOrder({ base_mint: "m", order_type: "tokenProfile", status: "approved", payment_ts: paidAt, updated_at: 1 });
    db.enqueueEvent({
      eventKey: "g2", baseMint: "m", kind: "order",
      text: "Status: <b>approved</b>\nPaid: 1 min ago\n\nToken: x", // the label as old code froze it
    });
    await new OutboxWorker(db, new (await import("../src/telegram.js")).DryRunSender()).drainOnce();
    db.releaseDryRun();
    const text = (db.raw.prepare("SELECT text FROM outbox").get() as { text: string }).text;
    expect(text).not.toContain("1 min ago");
    const sent = resolvePaidAge(text, Date.now());
    expect(sent).toContain("Paid: 3 h ago (late catch-up)");
    db.close();
  });

  it("an old frozen label with no known payment time is dropped rather than left misleading", async () => {
    const { DryRunSender } = await import("../src/telegram.js");
    const db = new Db(":memory:");
    verified(db);
    db.enqueueEvent({ eventKey: "g3", baseMint: "m", kind: "order", text: "Status: <b>approved</b>\nPaid: 1 min ago\n\nToken: x" });
    await new OutboxWorker(db, new DryRunSender()).drainOnce();
    db.releaseDryRun();
    expect((db.raw.prepare("SELECT text FROM outbox").get() as { text: string }).text).not.toContain("Paid:");
    db.close();
  });

  it("the age is computed when the message is SENT, not when it was queued", async () => {
    const db = new Db(":memory:");
    verified(db);
    const { paidMarker } = await import("../src/age.js");
    const paid = Date.now() - 2 * 60_000;
    db.enqueueEvent({ eventKey: "g4", baseMint: "m", kind: "order", text: `x\n${paidMarker(paid)}\ny` });
    const sender = new StubSender();
    // Delivered two hours "later" than it was queued.
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 3_600_000;
    try {
      await new OutboxWorker(db, sender).drainOnce(Date.now());
    } finally {
      Date.now = realNow;
    }
    expect(sender.sent[0]).toContain("Paid: 2 h 2 min ago (late catch-up)");
    db.close();
  });

  it("token-controlled text cannot forge an age marker", async () => {
    const { escapeHtml } = await import("../src/telegram.js");
    expect(escapeHtml("evil \u0001PAID:1\u0001 name")).not.toContain("\u0001");
  });
});
