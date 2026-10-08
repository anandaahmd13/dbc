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
    expect(db.releaseDryRun()).toBe(1);
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
    expect(db.releaseDryRun()).toBe(0);
    db.close();
  });
});
