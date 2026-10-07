import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { Db } from "../db.js";
import { DbcClient } from "../solana/dbc.js";

/**
 * Explain why a given mint did or didn't produce an alert, by inspecting the
 * bot's SQLite state + on-chain facts.
 *
 *   npm run diagnose -- <mint>
 */
async function main() {
  const mint = process.argv[2];
  if (!mint) {
    console.error("usage: npm run diagnose -- <mint>");
    process.exit(1);
  }
  const cfg = loadConfig(false);
  const db = new Db(cfg.databasePath);

  console.log("=== DB STATE for", mint, "===");
  const launch = db.getLaunchByMint(mint);
  console.log("launch row:", launch ?? "NONE — bot never recorded this launch");

  if (launch) {
    const creator = db.getCreator(launch.creator);
    console.log("creator row:", creator ?? "NONE");
    console.log(
      "  -> eligible flag:",
      launch.eligible,
      "| watch_until:",
      launch.watch_until ? new Date(launch.watch_until).toISOString() : 0,
      launch.watch_until > Date.now() ? "(still active)" : "(expired / not tracked)"
    );
  }

  const snap = db.getSnapshot(mint);
  console.log("social snapshot:", snap ?? "NONE — never polled DEX Screener for socials");
  const orders = db.getOrders(mint);
  console.log("orders rows:", orders.length ? orders : "NONE");

  // Any events emitted for this mint?
  const events = db.raw
    .prepare("SELECT event_key, kind, created_at FROM events WHERE base_mint = ?")
    .all(mint);
  console.log("events emitted:", events.length ? events : "NONE");

  const total = db.raw.prepare("SELECT COUNT(*) c FROM launches").get() as { c: number };
  const active = db.activeLaunches(Date.now()).length;
  console.log(`\n=== TOTALS === launches=${total.c}, active(tracked now)=${active}`);
  const lastCursor = db.getCursor("launch_last_signature");
  console.log("launch cursor:", lastCursor);

  db.close();

  // On-chain cross-check
  console.log("\n=== ON-CHAIN ===");
  const connection = new Connection(cfg.heliusRpcUrl, "confirmed");
  const dbc = new DbcClient(connection);
  const pool = await dbc.getPoolByBaseMint(mint).catch((e) => {
    console.log("getPoolByBaseMint failed:", (e as Error).message);
    return null;
  });
  console.log("pool:", pool ?? "not a DBC token");
  if (pool) {
    try {
      const pools = await dbc.getPoolsByCreator(pool.creator);
      console.log("creator launch count (live):", new Set(pools.map((p) => p.baseMint)).size);
    } catch (e) {
      console.log("creator history: UNKNOWN (RPC failed:", (e as Error).message + ")");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
