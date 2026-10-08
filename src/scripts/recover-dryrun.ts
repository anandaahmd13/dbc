import { loadConfig } from "../config.js";
import { Db } from "../db.js";

/**
 * Before the outbox distinguished dry-run from delivery, every message logged by
 * a DRY_RUN session was marked 'sent' — and, because its event key was already
 * recorded, could never be sent again. This puts those messages back in the queue.
 *
 * The database cannot tell a dry-run "sent" from a real one, so YOU supply the
 * moment the dry-run session started (UTC; see `pm2 logs` for the "[DRY_RUN]"
 * lines). Nothing changes unless --apply is passed.
 *
 *   npm run recover-dryrun -- 2026-10-08T02:50:00Z            # preview
 *   npm run recover-dryrun -- 2026-10-08T02:50:00Z --apply    # do it
 */
const since = process.argv[2];
const apply = process.argv.includes("--apply");
if (!since || Number.isNaN(Date.parse(since))) {
  console.error("usage: npm run recover-dryrun -- <ISO-UTC-start-of-dry-run> [--apply]");
  process.exit(1);
}
const sinceMs = Date.parse(since);
const db = new Db(loadConfig(false).databasePath);
const rows = db.raw
  .prepare("SELECT id, event_key, base_mint, sent_at, substr(text,1,60) AS head FROM outbox WHERE status='sent' AND sent_at >= ? ORDER BY sent_at")
  .all(sinceMs) as { id: number; base_mint: string | null; sent_at: number; head: string }[];

console.log(`${rows.length} message(s) marked 'sent' at or after ${new Date(sinceMs).toISOString()}:`);
for (const r of rows.slice(0, 40)) console.log(`  #${r.id} ${new Date(r.sent_at).toISOString()} ${r.base_mint?.slice(0, 8) ?? "?"} ${r.head.replace(/\n/g, " ")}`);
if (rows.length > 40) console.log(`  … and ${rows.length - 40} more`);
console.log("\nThese are re-queued ONLY if they were never actually delivered. If any were");
console.log("sent for real after that time, they will be sent a second time.");

if (!apply) {
  console.log("\nPreview only. Re-run with --apply to re-queue them.");
} else {
  const r = db.raw
    .prepare("UPDATE outbox SET status='pending', next_attempt_at=0, sent_at=NULL WHERE status='sent' AND sent_at >= ?")
    .run(sinceMs);
  console.log(`\nre-queued ${r.changes} message(s).`);
}
db.close();
