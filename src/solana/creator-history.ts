import type { Db, Eligibility } from "../db.js";
import type { DbcClient } from "./dbc.js";
import { log } from "../logger.js";

export interface EligibilityResult {
  eligibility: Eligibility;
  launchCount: number | null;
  /** Distinct base mints this creator has launched (when known). */
  mints?: string[];
}

/**
 * Determine whether a creator is eligible: launched <= max DBC pools (inclusive).
 *
 * We count distinct base mints from `getPoolsByCreator`. If the RPC call throws
 * (e.g. getProgramAccounts not permitted / times out), completeness cannot be
 * proven, so the result is `unknown` — never silently treated as 0 or eligible.
 *
 * Results are cached in the `creators` table. `forceRefresh` re-evaluates even a
 * cached eligible/ineligible verdict (used to re-check queued `unknown` creators
 * and to confirm just before alerting).
 */
export async function evaluateCreator(
  db: Db,
  dbc: DbcClient,
  creator: string,
  maxLaunches: number,
  forceRefresh = false
): Promise<EligibilityResult> {
  if (!forceRefresh) {
    const cached = db.getCreator(creator);
    if (cached && cached.eligibility !== "unknown") {
      return { eligibility: cached.eligibility, launchCount: cached.launch_count };
    }
  }

  let pools;
  try {
    pools = await dbc.getPoolsByCreator(creator);
  } catch (err) {
    log.warn(`creator history lookup failed for ${creator}; marking unknown`, errMsg(err));
    db.upsertCreator(creator, null, "unknown");
    return { eligibility: "unknown", launchCount: null };
  }

  const mints = [...new Set(pools.map((p) => p.baseMint))];
  const count = mints.length;
  const eligibility: Eligibility = count <= maxLaunches ? "eligible" : "ineligible";
  db.upsertCreator(creator, count, eligibility);
  return { eligibility, launchCount: count, mints };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
