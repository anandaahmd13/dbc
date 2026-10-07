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

describe("OutboxWorker", () => {
  it("delivers a pending message", async () => {
    const db = new Db(":memory:");
    db.enqueueEvent({ eventKey: "e1", baseMint: "m", kind: "order", text: "hello" });
    const sender = new StubSender();
    const worker = new OutboxWorker(db, sender);
    await worker.drainOnce();
    expect(sender.sent).toEqual(["hello"]);
    db.close();
  });

  it("retries on 429 then succeeds, honoring retry_after", async () => {
    const db = new Db(":memory:");
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
