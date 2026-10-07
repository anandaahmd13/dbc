import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
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
}

export interface SnapshotRow {
  base_mint: string;
  websites_json: string;
  socials_json: string;
  has_info: number;
  updated_at: number;
}

export interface OrderRow {
  base_mint: string;
  order_type: string;
  status: string;
  payment_ts: number | null;
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

  private migrate() {
    const sql = readFileSync(resolve(__dirname, "migrations/001-init.sql"), "utf8");
    this.raw.exec(sql);
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

  insertLaunch(row: Omit<LaunchRow, "eligible"> & { eligible: boolean }): boolean {
    const res = this.raw
      .prepare(
        `INSERT OR IGNORE INTO launches
         (pool, base_mint, creator, signature, detected_at, watch_until, eligible)
         VALUES (@pool, @base_mint, @creator, @signature, @detected_at, @watch_until, @eligible)`
      )
      .run({ ...row, eligible: row.eligible ? 1 : 0 });
    return res.changes > 0;
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
        `INSERT INTO token_snapshots (base_mint, websites_json, socials_json, has_info, updated_at)
         VALUES (@base_mint, @websites_json, @socials_json, @has_info, @updated_at)
         ON CONFLICT(base_mint) DO UPDATE SET
           websites_json = excluded.websites_json,
           socials_json = excluded.socials_json,
           has_info = excluded.has_info,
           updated_at = excluded.updated_at`
      )
      .run(row);
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
      .run(row);
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
      this.raw
        .prepare(
          `INSERT OR IGNORE INTO outbox (event_key, text, created_at, next_attempt_at)
           VALUES (?, ?, ?, 0)`
        )
        .run(params.eventKey, params.text, now);
      return true;
    });
    return tx();
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

  close() {
    this.raw.close();
  }
}
