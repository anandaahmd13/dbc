import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { Db } from "../db.js";
import { DbcClient } from "../solana/dbc.js";

/**
 * Explain what the bot did (or did not do) for a mint, with timings.
 *
 *   npm run diagnose -- <mint>      one token
 *   npm run diagnose                overall health of the queues
 */
const iso = (ms: number | null | undefined) =>
  ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z" : "-";
const ago = (ms: number | null | undefined, now: number) =>
  ms ? `${Math.round((now - ms) / 60000)}m ago` : "-";
const one = <T>(db: Db, sql: string, ...p: unknown[]) => db.raw.prepare(sql).get(...p) as T;
const all = <T>(db: Db, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p) as T[];

function health(db: Db, now: number) {
  console.log("=== QUEUE HEALTH ===");
  const monitored = db.countMonitored(now);
  const c = (sql: string) => one<{ c: number }>(db, sql, now).c;
  console.log("monitored launches        :", monitored);
  console.log(
    "  awaiting first baseline :",
    c("SELECT COUNT(*) c FROM launches WHERE (eligible=1 OR pending_creator=1) AND watch_until>? AND baseline_done=0")
  );
  console.log(
    "  awaiting creator verdict:",
    c("SELECT COUNT(*) c FROM launches WHERE pending_creator=1 AND watch_until>?")
  );
  const oldestDue = one<{ m: number | null }>(
    db,
    "SELECT MIN(next_poll_at) m FROM launches WHERE (eligible=1 OR pending_creator=1) AND watch_until>? AND next_poll_at<=?",
    now,
    now
  ).m;
  console.log("  most overdue poll       :", oldestDue ? `${Math.round((now - oldestDue) / 1000)}s late` : "none overdue");

  const oc = all<{ status: string; n: number; oldest: number | null }>(
    db,
    "SELECT status, COUNT(*) n, MIN(created_at) oldest FROM order_checks GROUP BY status"
  );
  console.log("order_checks              :", oc.length ? oc.map((r) => `${r.status}=${r.n}`).join(" ") : "none");
  const pend = all<{ base_mint: string; attempts: number; deadline_at: number; next_attempt_at: number }>(
    db,
    "SELECT * FROM order_checks WHERE status='pending' ORDER BY created_at LIMIT 5"
  );
  for (const j of pend)
    console.log(`  pending ${j.base_mint.slice(0, 8)} attempts=${j.attempts} next=${iso(j.next_attempt_at)} deadline=${iso(j.deadline_at)}`);

  const ob = all<{ status: string; n: number }>(db, "SELECT status, COUNT(*) n FROM outbox GROUP BY status");
  console.log("outbox                    :", ob.map((r) => `${r.status}=${r.n}`).join(" ") || "empty");
  const held = one<{ n: number; oldest: number | null }>(
    db,
    "SELECT COUNT(*) n, MIN(created_at) oldest FROM outbox WHERE status='held'"
  );
  if (held.n) console.log(`  HELD alerts: ${held.n}, oldest ${ago(held.oldest, now)} (waiting on creator verification)`);

  // paid -> alert -> telegram, for orders that produced a message
  const lat = all<{ payment_ts: number; created_at: number; sent_at: number | null; base_mint: string }>(
    db,
    `SELECT o.payment_ts, e.created_at, b.sent_at, e.base_mint
     FROM events e
     JOIN outbox b ON b.event_key = e.event_key
     JOIN orders o ON o.base_mint = e.base_mint AND o.order_type = 'tokenProfile' AND o.payment_ts > 0
     WHERE e.kind = 'order' ORDER BY e.created_at DESC LIMIT 10`
  );
  if (lat.length) {
    console.log("\nlatest paid-profile alerts (paid -> event -> telegram sent):");
    for (const r of lat) {
      const toEvent = ((r.created_at - r.payment_ts) / 60000).toFixed(1);
      const toSent = r.sent_at ? ((r.sent_at - r.payment_ts) / 60000).toFixed(1) : "not sent";
      console.log(`  ${r.base_mint.slice(0, 8)} paid ${iso(r.payment_ts)}  event +${toEvent}m  sent +${toSent}m`);
    }
  }
}

async function token(db: Db, mint: string, now: number) {
  console.log("=== DB STATE for", mint, "===");
  const launch = db.getLaunchByMint(mint);
  if (!launch) {
    console.log("launch row: NONE — the bot never recorded this launch");
  } else {
    console.log("launch      :", {
      detected: iso(launch.detected_at),
      watch_until: iso(launch.watch_until),
      origin: launch.origin,
      eligible: launch.eligible,
      pending_creator: launch.pending_creator,
      baseline_done: launch.baseline_done,
      next_poll_at: iso(launch.next_poll_at),
      poll_attempts: launch.poll_attempts,
      creator_attempts: launch.creator_attempts,
    });
    console.log("creator row :", db.getCreator(launch.creator) ?? "NONE");
  }
  const snap = db.getSnapshot(mint);
  console.log(
    "snapshot    :",
    snap
      ? { updated: `${iso(snap.updated_at)} (${ago(snap.updated_at, now)})`, has_info: snap.has_info, fingerprint: snap.info_fingerprint?.slice(0, 8) ?? null, pending_removal: Boolean(snap.pending_fingerprint) }
      : "NONE — never polled"
  );
  console.log("order_check :", db.getOrderCheck(mint) ?? "none");
  console.log(
    "orders      :",
    db.getOrders(mint).map((o) => ({ status: o.status, paid: iso(o.payment_ts), seen: iso(o.updated_at) }))
  );
  const rows = all<{ kind: string; created_at: number; status: string | null; sent_at: number | null; attempts: number | null; hold_reason: string | null }>(
    db,
    `SELECT e.kind, e.created_at, b.status, b.sent_at, b.attempts, b.hold_reason
     FROM events e LEFT JOIN outbox b ON b.event_key = e.event_key WHERE e.base_mint = ? ORDER BY e.created_at`,
    mint
  );
  console.log("alerts      :", rows.length ? "" : "none");
  for (const r of rows)
    console.log(`  ${r.kind.padEnd(6)} created ${iso(r.created_at)}  outbox=${r.status} sent=${iso(r.sent_at)} attempts=${r.attempts}${r.hold_reason ? " HELD:" + r.hold_reason : ""}`);

  const cfg = loadConfig(false);
  const dbc = new DbcClient(new Connection(cfg.heliusRpcUrl, "confirmed"));
  const pool = await dbc.getPoolByBaseMint(mint).catch(() => null);
  console.log("\n=== ON-CHAIN ===");
  console.log("pool        :", pool ?? "not a DBC token");
  if (pool && launch && pool.creator !== launch.creator)
    console.log(`creator differs: launch event ${launch.creator} vs account ${pool.creator} (pool creator was transferred)`);
}

async function main() {
  const cfg = loadConfig(false);
  const db = new Db(cfg.databasePath);
  const now = Date.now();
  const mint = process.argv[2];
  if (mint) await token(db, mint, now);
  console.log();
  health(db, now);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
