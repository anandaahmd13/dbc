import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { DbcClient } from "../solana/dbc.js";
import { fetchOrders, fetchTokenInfo } from "../dexscreener/client.js";

/**
 * Read-only inspector. No Telegram, no DB writes.
 *   npm run inspect -- <mint> [<mint> ...]
 */
async function main() {
  const mints = process.argv.slice(2).filter(Boolean);
  if (mints.length === 0) {
    console.error("usage: npm run inspect -- <mint> [<mint> ...]");
    process.exit(1);
  }
  const cfg = loadConfig(false);
  const connection = new Connection(cfg.heliusRpcUrl, "confirmed");
  const dbc = new DbcClient(connection);

  for (const mint of mints) {
    console.log("\n==============================");
    console.log("mint:", mint);
    let pool;
    try {
      pool = await dbc.getPoolByBaseMint(mint);
    } catch (e) {
      console.log("  ERROR resolving pool:", (e as Error).message);
      continue;
    }
    if (!pool) {
      console.log("  not a DBC token (no pool found)");
      continue;
    }
    console.log("  pool:", pool.pool);
    console.log("  creator:", pool.creator);
    console.log("  migrated:", pool.isMigrated);

    try {
      const pools = await dbc.getPoolsByCreator(pool.creator);
      const unique = new Set(pools.map((p) => p.baseMint));
      const eligible = unique.size <= cfg.maxCreatorLaunches;
      console.log(`  creator launches: ${unique.size} -> ${eligible ? "ELIGIBLE" : "ineligible"} (max ${cfg.maxCreatorLaunches})`);
    } catch (e) {
      console.log("  creator history: UNKNOWN (RPC failed:", (e as Error).message + ")");
    }

    try {
      const orders = await fetchOrders(mint);
      const profile = orders.filter((o) => o.type === "tokenProfile");
      console.log("  paid orders (tokenProfile):", profile.length ? JSON.stringify(profile) : "none");
    } catch (e) {
      console.log("  orders fetch failed:", (e as Error).message);
    }

    try {
      const info = (await fetchTokenInfo([mint])).get(mint);
      if (info?.present) {
        console.log("  websites:", info.websites);
        console.log("  socials:", info.socials);
      } else {
        console.log("  DEX Screener: no pair data yet");
      }
    } catch (e) {
      console.log("  token info fetch failed:", (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
