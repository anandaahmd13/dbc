import Database from "better-sqlite3";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Eligibility = "eligible" | "ineligible" | "unknown";

export interface CreatorRow {
  address: string;
  launch_count: number | null;
  eligibility: Eligibility;
  checked_at: number | null;
  created_at: number;
}

export interface LaunchRow {
  pool: string;
  base_mint: string;
  creator: string;
  signature: string | null;
  detected_at: number;
  watch_until: number;
  eligible: number;
  baseline_done: number;
  origin: string;
  next_poll_at: number;
  poll_attempts: number;
  pending_creator: number;
  creator_attempts: number;
  creator_next_check_at: number;
}

export interface SnapshotRow {
  base_mint: string;
  websites_json: string;
  socials_json: string;
  has_info: number;
  updated_at: number;
  image_url?: string | null;
  header_url?: string | null;
  info_fingerprint?: string | null;
  pending_fingerprint?: string | null;
}

export interface OrderCheckRow {
  base_mint: string;
  reason: string;
  status: "pending" | "done" | "expired";
  attempts: number;
  next_attempt_at: number;
  deadline_at: number;
  created_at: number;
  updated_at: number;
}

export interface OrderRow {
  base_mint: string;
  order_type: string;
  status: string;
  /** 0 when the API gave no paymentTimestamp (stable identity, never NULL). */
  payment_ts: number;
  updated_at: number;
}

export interface OutboxRow {
  id: number;
  event_key: string;
  text: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
  base_mint: string | null;
  hold_reason: string | null;
}

export class Db {
  readonly raw: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.migrate();
  }

  /**
   * Run every `migrations/*.sql` once, in filename order, tracked in
   * `schema_migrations`. 001 is `IF NOT EXISTS`-only so it is safe to re-run on
   * databases created before tracking existed; later files (ALTER TABLE) are not
   * idempotent and rely on the tracking table.
   */
  private migrate() {
    this.raw.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at INTEGER NOT NULL
       )`
    );
    const dir = resolve(__dirname, "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const applied = new Set(
      (this.raw.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
        (r) => r.name
      )
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(resolve(dir, file), "utf8");
      const run = this.raw.transaction(() => {
        this.raw.exec(sql);
        this.raw
          .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
          .run(file, Date.now());
      });
      run();
    }
  }

  // --- cursors ---
  getCursor(name: string): string | null {
    const row = this.raw
      .prepare("SELECT value FROM cursors WHERE name = ?")
      .get(name) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  setCursor(name: string, value: string | null) {
    this.raw
      .prepare(
        `INSERT INTO cursors (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(name, value, Date.now());
  }

  // --- creators ---
  getCreator(address: string): CreatorRow | undefined {
    return this.raw.prepare("SELECT * FROM creators WHERE address = ?").get(address) as
      | CreatorRow
      | undefined;
  }

  upsertCreator(
    address: string,
    launchCount: number | null,
    eligibility: Eligibility
  ): void {
    const now = Date.now();
    this.raw
      .prepare(
        `INSERT INTO creators (address, launch_count, eligibility, checked_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           launch_count = excluded.launch_count,
           eligibility = excluded.eligibility,
           checked_at = excluded.checked_at`
      )
      .run(address, launchCount, eligibility, now, now);
  }

  // --- launches ---
  getLaunchByMint(mint: string): LaunchRow | undefined {
    return this.raw.prepare("SELECT * FROM launches WHERE base_mint = ?").get(mint) as
      | LaunchRow
      | undefined;
  }

  /** Mark the silent baseline pass as done so later polls alert on changes. */
  setBaselineDone(mint: string): void {
    this.raw.prepare("UPDATE launches SET baseline_done = 1 WHERE base_mint = ?").run(mint);
  }

  insertLaunch(
    row: Pick<
      LaunchRow,
      "pool" | "base_mint" | "creator" | "signature" | "detected_at" | "watch_until"
    > & {
      eligible: boolean;
      origin?: "live" | "backfill";
      /** Creator not yet proven: monitor now, hold alerts until verified. */
      pendingCreator?: boolean;
    }
  ): boolean {
    const res = this.raw
      .prepare(
        `INSERT OR IGNORE INTO launches
         (pool, base_mint, creator, signature, detected_at, watch_until, eligible, origin, pending_creator)
         VALUES (@pool, @base_mint, @creator, @signature, @detected_at, @watch_until, @eligible, @origin, @pending_creator)`
      )
      .run({
        pool: row.pool,
        base_mint: row.base_mint,
        creator: row.creator,
        signature: row.signature,
        detected_at: row.detected_at,
        watch_until: row.watch_until,
        eligible: row.eligible ? 1 : 0,
        origin: row.origin ?? "live",
        pending_creator: row.pendingCreator ? 1 : 0,
      });
    return res.changes > 0;
  }

  /** Most recent launches the bot has recorded (eligible or not). */
  recentLaunches(limit = 10): LaunchRow[] {
    return this.raw
      .prepare("SELECT * FROM launches ORDER BY detected_at DESC LIMIT ?")
      .all(limit) as LaunchRow[];
  }

  activeLaunches(now: number): LaunchRow[] {
    return this.raw
      .prepare("SELECT * FROM launches WHERE eligible = 1 AND watch_until > ? ORDER BY detected_at ASC")
      .all(now) as LaunchRow[];
  }

  // --- snapshots ---
  getSnapshot(mint: string): SnapshotRow | undefined {
    return this.raw.prepare("SELECT * FROM token_snapshots WHERE base_mint = ?").get(mint) as
      | SnapshotRow
      | undefined;
  }

  upsertSnapshot(row: SnapshotRow): void {
    this.raw
      .prepare(
        `INSERT INTO token_snapshots
           (base_mint, websites_json, socials_json, has_info, updated_at,
            image_url, header_url, info_fingerprint, pending_fingerprint)
         VALUES (@base_mint, @websites_json, @socials_json, @has_info, @updated_at,
                 @image_url, @header_url, @info_fingerprint, @pending_fingerprint)
         ON CONFLICT(base_mint) DO UPDATE SET
           websites_json = excluded.websites_json,
           socials_json = excluded.socials_json,
           has_info = excluded.has_info,
           updated_at = excluded.updated_at,
           image_url = excluded.image_url,
           header_url = excluded.header_url,
           info_fingerprint = excluded.info_fingerprint,
           pending_fingerprint = excluded.pending_fingerprint`
      )
      .run({
        image_url: null,
        header_url: null,
        info_fingerprint: null,
        pending_fingerprint: null,
        ...row,
      });
  }

  // --- orders ---
  getOrders(mint: string): OrderRow[] {
    return this.raw.prepare("SELECT * FROM orders WHERE base_mint = ?").all(mint) as OrderRow[];
  }

  upsertOrder(row: OrderRow): void {
    this.raw
      .prepare(
        `INSERT INTO orders (base_mint, order_type, status, payment_ts, updated_at)
         VALUES (@base_mint, @order_type, @status, @payment_ts, @updated_at)
         ON CONFLICT(base_mint, order_type, payment_ts) DO UPDATE SET
           status = excluded.status,
           updated_at = excluded.updated_at`
      )
      .run({ ...row, payment_ts: row.payment_ts ?? 0 });
  }

  // --- events + outbox (atomic) ---
  /**
   * Record an event and enqueue its message in one transaction.
   * Returns true if newly enqueued, false if the event_key already existed.
   */
  enqueueEvent(params: {
    eventKey: string;
    baseMint: string;
    kind: string;
    text: string;
  }): boolean {
    const now = Date.now();
    const tx = this.raw.transaction(() => {
      const ins = this.raw
        .prepare(
          `INSERT OR IGNORE INTO events (event_key, base_mint, kind, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(params.eventKey, params.baseMint, params.kind, now);
      if (ins.changes === 0) return false;
      // Fail closed: if the launch's creator is not proven <= the limit, park the
      // message instead of sending it. Verification later releases or drops it.
      const pending = this.raw
        .prepare("SELECT pending_creator FROM launches WHERE base_mint = ?")
        .get(params.baseMint) as { pending_creator: number } | undefined;
      const hold = pending?.pending_creator === 1;
      this.raw
        .prepare(
          `INSERT OR IGNORE INTO outbox
             (event_key, text, created_at, next_attempt_at, status, base_mint, hold_reason)
           VALUES (?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          params.eventKey,
          params.text,
          now,
          hold ? "held" : "pending",
          params.baseMint,
          hold ? "creator_unverified" : null
        );
      return true;
    });
    return tx();
  }

  /**
   * A creator verdict arrived for this launch. Eligible: monitoring stays on and
   * held alerts are released. Ineligible: stop monitoring and discard held alerts.
   * Returns how many held messages were released/dropped.
   */
  resolveCreator(mint: string, eligible: boolean): { released: number; dropped: number } {
    const tx = this.raw.transaction(() => {
      this.raw
        .prepare(
          `UPDATE launches SET pending_creator = 0, eligible = ?, creator_attempts = 0
           WHERE base_mint = ?`
        )
        .run(eligible ? 1 : 0, mint);
      if (eligible) {
        const r = this.raw
          .prepare(
            `UPDATE outbox SET status = 'pending', hold_reason = NULL
             WHERE base_mint = ? AND status = 'held'`
          )
          .run(mint);
        return { released: r.changes, dropped: 0 };
      }
      const r = this.raw
        .prepare(
          `UPDATE outbox SET status = 'dropped', hold_reason = 'creator_ineligible'
           WHERE base_mint = ? AND status = 'held'`
        )
        .run(mint);
      return { released: 0, dropped: r.changes };
    });
    return tx();
  }

  // --- creator verification queue ---

  /** Launches monitored but still waiting for a proven creator verdict. */
  launchesAwaitingCreator(now: number, limit: number): LaunchRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM launches
         WHERE pending_creator = 1 AND watch_until > @now AND creator_next_check_at <= @now
         ORDER BY creator_next_check_at ASC, detected_at ASC LIMIT @limit`
      )
      .all({ now, limit }) as LaunchRow[];
  }

  rescheduleCreatorCheck(mint: string, nextAt: number): void {
    this.raw
      .prepare(
        `UPDATE launches SET creator_attempts = creator_attempts + 1, creator_next_check_at = ?
         WHERE base_mint = ?`
      )
      .run(nextAt, mint);
  }

  /** Distinct mints this creator launched, as recorded from creation events. */
  mintsLaunchedBy(creator: string): string[] {
    return (
      this.raw.prepare("SELECT DISTINCT base_mint FROM launches WHERE creator = ?").all(creator) as {
        base_mint: string;
      }[]
    ).map((r) => r.base_mint);
  }

  /** Other launches by the same creator that are waiting on its verdict. */
  launchesByCreatorPending(creator: string): LaunchRow[] {
    return this.raw
      .prepare("SELECT * FROM launches WHERE creator = ? AND pending_creator = 1")
      .all(creator) as LaunchRow[];
  }

  claimPendingOutbox(now: number, limit = 10): OutboxRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY id ASC LIMIT ?`
      )
      .all(now, limit) as OutboxRow[];
  }

  markOutboxSent(id: number): void {
    this.raw
      .prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  markOutboxRetry(id: number, nextAttemptAt: number, error: string): void {
    this.raw
      .prepare(
        `UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?`
      )
      .run(nextAttemptAt, error.slice(0, 500), id);
  }

  markOutboxFailed(id: number, error: string): void {
    this.raw
      .prepare(
        `UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`
      )
      .run(error.slice(0, 500), id);
  }

  // --- scheduling (per-launch, survives restart) ---

  /**
   * Launches whose DEX Screener data is due, oldest-due first. Includes launches
   * still waiting on creator verification (monitoring continues; alerts are held).
   */
  dueLaunches(now: number, limit: number): LaunchRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM launches
         WHERE (eligible = 1 OR pending_creator = 1)
           AND watch_until > @now
           AND next_poll_at <= @now
         ORDER BY baseline_done ASC, next_poll_at ASC, detected_at ASC
         LIMIT @limit`
      )
      .all({ now, limit }) as LaunchRow[];
  }

  /** Count of launches still being monitored (for diagnostics). */
  countMonitored(now: number): number {
    const r = this.raw
      .prepare(
        `SELECT COUNT(*) c FROM launches
         WHERE (eligible = 1 OR pending_creator = 1) AND watch_until > ?`
      )
      .get(now) as { c: number };
    return r.c;
  }

  /** Record the outcome of a poll for a set of mints. */
  reschedulePolls(mints: string[], nextPollAt: number, ok: boolean): void {
    const upd = this.raw.prepare(
      `UPDATE launches SET next_poll_at = ?, poll_attempts = CASE WHEN ? THEN 0 ELSE poll_attempts + 1 END
       WHERE base_mint = ?`
    );
    const tx = this.raw.transaction(() => {
      for (const m of mints) upd.run(nextPollAt, ok ? 1 : 0, m);
    });
    tx();
  }

  // --- order-check jobs (durable) ---

  /**
   * Ask for one order check for this mint. A pending job is left alone (its
   * deadline is NOT extended, so retries stay bounded); a finished or expired job
   * is reopened with a fresh deadline.
   */
  enqueueOrderCheck(mint: string, reason: string, now: number, windowMs: number): void {
    this.raw
      .prepare(
        `INSERT INTO order_checks
           (base_mint, reason, status, attempts, next_attempt_at, deadline_at, created_at, updated_at)
         VALUES (@mint, @reason, 'pending', 0, @now, @deadline, @now, @now)
         ON CONFLICT(base_mint) DO UPDATE SET
           reason = excluded.reason,
           status = 'pending',
           attempts = 0,
           next_attempt_at = excluded.next_attempt_at,
           deadline_at = excluded.deadline_at,
           updated_at = excluded.updated_at
         WHERE order_checks.status != 'pending'`
      )
      .run({ mint, reason, now, deadline: now + windowMs });
  }

  dueOrderChecks(now: number, limit: number): OrderCheckRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM order_checks
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT ?`
      )
      .all(now, limit) as OrderCheckRow[];
  }

  getOrderCheck(mint: string): OrderCheckRow | undefined {
    return this.raw.prepare("SELECT * FROM order_checks WHERE base_mint = ?").get(mint) as
      | OrderCheckRow
      | undefined;
  }

  retryOrderCheck(mint: string, nextAttemptAt: number): void {
    this.raw
      .prepare(
        `UPDATE order_checks SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
         WHERE base_mint = ? AND status = 'pending'`
      )
      .run(nextAttemptAt, Date.now(), mint);
  }

  finishOrderCheck(mint: string, status: "done" | "expired"): void {
    this.raw
      .prepare("UPDATE order_checks SET status = ?, updated_at = ? WHERE base_mint = ?")
      .run(status, Date.now(), mint);
  }

  close() {
    this.raw.close();
  }
}
