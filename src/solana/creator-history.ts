import type { Db, Eligibility } from "../db.js";
import type { DbcClient } from "./dbc.js";
import { log } from "../logger.js";

export interface EligibilityResult {
  eligibility: Eligibility;
  launchCount: number | null;
  /** Distinct base mints this creator has launched (when known). */
  mints?: string[];
}

export interface EvaluateOptions {
  /** Re-evaluate even a fresh cached verdict. */
  forceRefresh?: boolean;
  /**
   * The mint being evaluated right now. It is counted even if the account scan
   * does not list it yet (the scan can run before the pool is visible, which
   * previously made a brand-new creator look like it had launched 0 tokens).
   */
  currentMint?: string;
  /** How long an `eligible` verdict is trusted. Default 5 minutes. */
  eligibleTtlMs?: number;
  /** How long a still-`unknown` verdict is trusted before retrying. Default 30 s. */
  unknownTtlMs?: number;
  now?: number;
}

const DEFAULT_ELIGIBLE_TTL_MS = 5 * 60_000;
const DEFAULT_UNKNOWN_TTL_MS = 30_000;

/** One in-flight evaluation per creator, so a burst of launches costs one scan. */
const inflight = new Map<string, Promise<EligibilityResult>>();

/**
 * Decide whether a creator is eligible: launched <= `maxLaunches` DBC tokens
 * (inclusive, counting the one being evaluated).
 *
 * What counts as evidence:
 *  - Distinct base mints from the creator's CURRENT pool accounts (paginated).
 *  - Every launch this bot recorded from a creation event for this creator, which
 *    survives a later `transferPoolCreator`.
 *  - `currentMint`.
 *
 * Verdicts:
 *  - More than `maxLaunches` distinct mints  -> `ineligible`. Launches never
 *    un-happen, so this is proven even from a partial scan, and it never expires.
 *  - <= `maxLaunches`, the account scan completed, and `currentMint` is covered
 *    -> `eligible` (cached for a short TTL, then re-counted).
 *  - Anything else (RPC rejected/failed, truncated scan) -> `unknown`. Never
 *    treated as 0 and never as eligible.
 *
 * Limit: an account scan cannot see pools whose creator was changed away before
 * this bot started watching, so `eligible` means "no more than N launches that
 * this wallet currently holds or that we saw it create" — not a full history.
 */
export function evaluateCreator(
  db: Db,
  dbc: DbcClient,
  creator: string,
  maxLaunches: number,
  opts: EvaluateOptions | boolean = {}
): Promise<EligibilityResult> {
  const o: EvaluateOptions = typeof opts === "boolean" ? { forceRefresh: opts } : opts;
  const existing = inflight.get(creator);
  if (existing && !o.forceRefresh) return existing;
  const p = run(db, dbc, creator, maxLaunches, o).finally(() => {
    if (inflight.get(creator) === p) inflight.delete(creator);
  });
  inflight.set(creator, p);
  return p;
}

async function run(
  db: Db,
  dbc: DbcClient,
  creator: string,
  maxLaunches: number,
  o: EvaluateOptions
): Promise<EligibilityResult> {
  const now = o.now ?? Date.now();

  if (!o.forceRefresh) {
    const cached = db.getCreator(creator);
    if (cached) {
      const age = now - (cached.checked_at ?? 0);
      if (cached.eligibility === "ineligible") {
        return { eligibility: "ineligible", launchCount: cached.launch_count };
      }
      if (cached.eligibility === "eligible" && age < (o.eligibleTtlMs ?? DEFAULT_ELIGIBLE_TTL_MS)) {
        return { eligibility: "eligible", launchCount: cached.launch_count };
      }
      if (cached.eligibility === "unknown" && age < (o.unknownTtlMs ?? DEFAULT_UNKNOWN_TTL_MS)) {
        return { eligibility: "unknown", launchCount: null };
      }
    }
  }

  // Evidence we already hold from creation events (survives creator transfers).
  const mints = new Set<string>(db.mintsLaunchedBy(creator));
  if (o.currentMint) mints.add(o.currentMint);

  let scanComplete = false;
  try {
    const scan = await dbc.getCreatorPools(creator);
    for (const p of scan.pools) mints.add(p.baseMint);
    scanComplete = scan.complete;
  } catch (err) {
    log.warn(`creator history lookup failed for ${creator}`, errMsg(err));
  }

  if (mints.size > maxLaunches) {
    // Proven from a lower bound; holds even if the scan was partial or failed.
    db.upsertCreator(creator, mints.size, "ineligible");
    return { eligibility: "ineligible", launchCount: mints.size, mints: [...mints] };
  }

  if (!scanComplete) {
    db.upsertCreator(creator, null, "unknown");
    return { eligibility: "unknown", launchCount: null };
  }

  db.upsertCreator(creator, mints.size, "eligible");
  return { eligibility: "eligible", launchCount: mints.size, mints: [...mints] };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
