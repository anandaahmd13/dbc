import type { Connection } from "@solana/web3.js";
import type { Db } from "../db.js";
import { DBC_PROGRAM_ID, type DbcClient } from "./dbc.js";
import { evaluateCreator } from "./creator-history.js";
import { log } from "../logger.js";

export interface BackfillOptions {
  /** Only launches newer than this many ms are tracked. */
  lookbackMs: number;
  /** Max creator-eligible watch window, applied from the launch's own time. */
  watchWindowMs: number;
  maxLaunchesPerCreator: number;
  /** Hard cap on transactions inspected, so a busy program can't run away. */
  maxTransactions?: number;
  /** Pause between getTransaction calls (RPC politeness). */
  throttleMs?: number;
}

const PAGE = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Seed the tracker with DBC launches from the last `lookbackMs` (default intent:
 * 24h) so tokens that launched before the bot started are monitored too.
 *
 * - Walks program signatures newest -> oldest until older than the lookback.
 * - Decodes launches from inner instructions (`decodeLaunchesFromTx`).
 * - Eligible creators only; `detected_at` is the launch's real blockTime so the
 *   watch window ends 24h after the actual launch, not after bot start.
 * - No "new launch" Telegram alert (these are not new), and `baseline_done=0`
 *   so the scheduler records current orders/socials silently first.
 *
 * Idempotent (`insertLaunch` is INSERT OR IGNORE per base_mint).
 */
export async function backfillRecentLaunches(
  db: Db,
  connection: Connection,
  dbc: DbcClient,
  opts: BackfillOptions
): Promise<{ inspected: number; found: number; tracked: number }> {
  const maxTx = opts.maxTransactions ?? 5000;
  const throttle = opts.throttleMs ?? 100;
  const cutoffSec = Math.floor((Date.now() - opts.lookbackMs) / 1000);

  let before: string | undefined;
  let inspected = 0;
  let found = 0;
  let tracked = 0;
  const seenMints = new Set<string>();
  let reachedCutoff = false;
  let oldestSeenSec = 0;

  while (!reachedCutoff && inspected < maxTx) {
    let sigs;
    try {
      sigs = await connection.getSignaturesForAddress(DBC_PROGRAM_ID, { before, limit: PAGE });
    } catch (err) {
      log.warn("backfill-launches: getSignaturesForAddress failed", errMsg(err));
      break;
    }
    if (sigs.length === 0) break;

    for (const s of sigs) {
      if (s.blockTime && s.blockTime < cutoffSec) {
        reachedCutoff = true;
        break;
      }
      if (inspected >= maxTx) break;
      if (s.blockTime) oldestSeenSec = s.blockTime;
      if (s.err) continue;
      inspected++;

      let events;
      try {
        events = await dbc.decodeLaunchesFromTx(s.signature);
      } catch (err) {
        log.debug(`backfill-launches: decode failed ${s.signature}`, errMsg(err));
        continue;
      }
      await sleep(throttle);

      for (const ev of events) {
        if (seenMints.has(ev.baseMint)) continue;
        seenMints.add(ev.baseMint);
        found++;

        const launchedAt = (s.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
        const result = await evaluateCreator(db, dbc, ev.creator, opts.maxLaunchesPerCreator, {
          currentMint: ev.baseMint,
        });
        // ineligible: not worth tracking. eligible: track. unknown: track too, with
        // alerts held until the creator worker proves it (same as a live launch).
        const track = result.eligibility !== "ineligible";
        const watchUntil = track ? launchedAt + opts.watchWindowMs : 0;

        const inserted = db.insertLaunch({
          pool: ev.pool,
          base_mint: ev.baseMint,
          creator: ev.creator,
          signature: s.signature,
          detected_at: launchedAt,
          watch_until: watchUntil,
          eligible: result.eligibility === "eligible",
          pendingCreator: result.eligibility === "unknown",
          origin: "backfill",
        });
        if (inserted && track) tracked++;
      }
    }

    before = sigs[sigs.length - 1]!.signature;
    if (sigs.length < PAGE) break;
  }

  log.info(
    `backfill-launches: inspected ${inspected} tx, found ${found} launch(es), tracking ${tracked} eligible`
  );
  if (!reachedCutoff) {
    // The DBC program is extremely busy (measured ~1000 tx / 34s), so a tx cap
    // reached long before the lookback. Say so instead of implying full coverage.
    const coveredMin = oldestSeenSec
      ? Math.round((Date.now() / 1000 - oldestSeenSec) / 60)
      : 0;
    log.warn(
      `backfill-launches: stopped at the tx cap before reaching the ${Math.round(
        opts.lookbackMs / 60_000
      )}min lookback; only ~${coveredMin}min of history was covered`
    );
  }
  return { inspected, found, tracked };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
