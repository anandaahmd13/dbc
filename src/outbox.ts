import type { Db } from "./db.js";
import type { TelegramSender } from "./telegram.js";
import { TelegramError } from "./telegram.js";
import { log } from "./logger.js";
import { resolvePaidAge } from "./age.js";
import { sleep } from "./scheduler.js";

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 2000;

/**
 * Drains the outbox table, delivering messages via the sender with retry +
 * exponential backoff. At-least-once: a timeout after a successful send may
 * duplicate a message.
 */
export class OutboxWorker {
  private stopped = false;

  constructor(private readonly db: Db, private readonly sender: TelegramSender) {}

  stop() {
    this.stopped = true;
  }

  async runForever(): Promise<void> {
    while (!this.stopped) {
      const processed = await this.drainOnce();
      if (processed === 0) await sleep(1000);
    }
  }

  /** Process one batch of due messages; returns how many were attempted. */
  async drainOnce(now = Date.now()): Promise<number> {
    const batch = this.db.claimPendingOutbox(now, 10);
    for (const row of batch) {
      try {
        const result = await this.sender.send(resolvePaidAge(row.text, Date.now()));
        // A dry run only logged the text. Marking it 'sent' would burn the alert
        // forever (its event key is already recorded), so keep it recoverable.
        if (result === "dryrun") this.db.markOutboxDryRun(row.id);
        else this.db.markOutboxSent(row.id);
      } catch (err) {
        this.onError(row.id, row.attempts, err);
      }
    }
    return batch.length;
  }

  private onError(id: number, attempts: number, err: unknown): void {
    const nextAttempt = attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    if (nextAttempt >= MAX_ATTEMPTS) {
      log.error(`outbox ${id} permanently failed after ${nextAttempt} attempts: ${message}`);
      this.db.markOutboxFailed(id, message);
      return;
    }
    let backoff = BASE_BACKOFF_MS * 2 ** attempts;
    if (err instanceof TelegramError && err.retryAfterMs) backoff = err.retryAfterMs;
    backoff = Math.min(backoff, 5 * 60_000);
    this.db.markOutboxRetry(id, Date.now() + backoff, message);
    log.warn(`outbox ${id} retry ${nextAttempt} in ${backoff}ms: ${message}`);
  }
}
