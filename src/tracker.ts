import type { Db, SnapshotRow, OrderRow } from "./db.js";
import type { OrderEntry, TokenInfo, TokenSocial } from "./dexscreener/client.js";
import { fetchOrders, fetchTokenInfo } from "./dexscreener/client.js";
import { createHash } from "node:crypto";

/** How long an order check keeps retrying after a profile appears/changes. */
export const ORDER_CHECK_WINDOW_MS = 10 * 60_000;
/** Retry delays between order checks (ms), capped at the last entry. */
const ORDER_RETRY_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000];

export const PROFILE_ORDER_TYPE = "tokenProfile";

export interface SocialDiff {
  websitesAdded: string[];
  websitesRemoved: string[];
  socialsAdded: TokenSocial[];
  socialsRemoved: TokenSocial[];
}

export interface OrderChange {
  type: string;
  status: string;
  paymentTimestamp?: number;
  previousStatus?: string;
}

/** Normalize an OrderEntry to a stable identity key for dedup. */
export function orderKey(mint: string, o: { type: string; paymentTimestamp?: number }): string {
  return `${mint}:${o.type}:${o.paymentTimestamp ?? 0}`;
}

/** Deterministic event key -> used both for dedup and outbox uniqueness. */
export function eventKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/**
 * Diff a fresh DEX Screener social snapshot against the stored one.
 * Returns null if there's no meaningful change.
 *
 * Caller must only pass `info.present === true` snapshots: a missing/empty
 * response must NOT be interpreted as "everything removed".
 */
export function diffSocials(prev: SnapshotRow | undefined, next: TokenInfo): SocialDiff | null {
  const prevWebsites = prev ? (JSON.parse(prev.websites_json) as string[]) : [];
  const prevSocials = prev ? (JSON.parse(prev.socials_json) as TokenSocial[]) : [];

  const nextW = new Set(next.websites);
  const prevW = new Set(prevWebsites);
  const websitesAdded = [...nextW].filter((w) => !prevW.has(w));
  const websitesRemoved = [...prevW].filter((w) => !nextW.has(w));

  const key = (s: TokenSocial) => `${s.type}|${s.url}`;
  const nextS = new Map(next.socials.map((s) => [key(s), s]));
  const prevS = new Map(prevSocials.map((s) => [key(s), s]));
  const socialsAdded = [...nextS].filter(([k]) => !prevS.has(k)).map(([, s]) => s);
  const socialsRemoved = [...prevS].filter(([k]) => !nextS.has(k)).map(([, s]) => s);

  if (
    websitesAdded.length === 0 &&
    websitesRemoved.length === 0 &&
    socialsAdded.length === 0 &&
    socialsRemoved.length === 0
  ) {
    return null;
  }
  return { websitesAdded, websitesRemoved, socialsAdded, socialsRemoved };
}

/**
 * Stable hash over everything that makes up a token's DEX Screener profile.
 * Order-independent (sorted, deduped) and ignores image size/cache params.
 */
export function fingerprintOf(info: TokenInfo): string {
  const parts = [
    info.imageUrl ?? "",
    info.headerUrl ?? "",
    JSON.stringify([...new Set(info.websites)].sort()),
    JSON.stringify(info.socials.map((s) => `${s.type}|${s.url}`).sort()),
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

/** A profile counts as "full" once it has an icon, a banner and any link. */
export function isFullInfo(info: TokenInfo): boolean {
  return Boolean(
    info.hasInfo && info.imageUrl && info.headerUrl && (info.websites.length || info.socials.length)
  );
}

export function infoToSnapshotRow(
  mint: string,
  info: TokenInfo,
  now: number,
  pendingFingerprint: string | null = null
): SnapshotRow {
  return {
    base_mint: mint,
    websites_json: JSON.stringify([...new Set(info.websites)].sort()),
    socials_json: JSON.stringify(info.socials),
    has_info: info.hasInfo ? 1 : 0,
    updated_at: now,
    image_url: info.imageUrl,
    header_url: info.headerUrl,
    info_fingerprint: fingerprintOf(info),
    pending_fingerprint: pendingFingerprint,
  };
}

/**
 * Compare fresh orders to stored ones, returning newly-seen orders or ones whose
 * status changed. Only `tokenProfile` type is considered (paid profile).
 */
export function diffOrders(stored: OrderRow[], fresh: OrderEntry[]): OrderChange[] {
  const storedMap = new Map<string, OrderRow>();
  for (const s of stored) storedMap.set(`${s.order_type}:${s.payment_ts ?? 0}`, s);

  const changes: OrderChange[] = [];
  for (const o of fresh) {
    if (o.type !== PROFILE_ORDER_TYPE) continue;
    const k = `${o.type}:${o.paymentTimestamp ?? 0}`;
    const prev = storedMap.get(k);
    if (!prev) {
      changes.push({ type: o.type, status: o.status, paymentTimestamp: o.paymentTimestamp });
    } else if (prev.status !== o.status) {
      changes.push({
        type: o.type,
        status: o.status,
        paymentTimestamp: o.paymentTimestamp,
        previousStatus: prev.status,
      });
    }
  }
  return changes;
}

export interface PollResult {
  socialDiff: SocialDiff | null;
  socialBaseline: boolean;
  orderChanges: OrderChange[];
  orderBaseline: boolean;
}

export interface TrackerDeps {
  db: Db;
  formatSocial: (mint: string, diff: SocialDiff, baseline: boolean, info: TokenInfo) => string;
  formatOrder: (mint: string, change: OrderChange, baseline: boolean) => string;
}

export interface PollOpts {
  /** Record state without enqueueing alerts (used for the baseline pass). */
  silent?: boolean;
}

/**
 * Poll a single mint's orders and persist/diff. Pure of network concerns except
 * the injected fetcher (so tests can stub). Enqueues alerts atomically unless
 * `opts.silent` (baseline pass), in which case state is recorded quietly.
 *
 * Outside the baseline pass every difference is a real change after we started
 * watching, so alerts are never flagged as "first seen".
 */
export async function pollOrders(
  deps: TrackerDeps,
  mint: string,
  fetchOrdersFn: (m: string) => Promise<OrderEntry[]> = fetchOrders,
  opts: PollOpts = {}
): Promise<{ changes: OrderChange[]; baseline: boolean }> {
  const fresh = await fetchOrdersFn(mint);
  const stored = deps.db.getOrders(mint);
  const baseline = Boolean(opts.silent);
  const changes = diffOrders(stored, fresh);
  const now = Date.now();

  for (const o of fresh) {
    if (o.type !== PROFILE_ORDER_TYPE) continue;
    deps.db.upsertOrder({
      base_mint: mint,
      order_type: o.type,
      status: o.status,
      payment_ts: o.paymentTimestamp ?? 0,
      updated_at: now,
    });
  }

  if (opts.silent) return { changes, baseline };

  for (const c of changes) {
    const key = eventKey([
      "order",
      mint,
      c.type,
      String(c.paymentTimestamp ?? 0),
      c.status,
    ]);
    deps.db.enqueueEvent({
      eventKey: key,
      baseMint: mint,
      kind: "order",
      text: deps.formatOrder(mint, c, false),
    });
  }
  return { changes, baseline };
}

export interface SocialPollResult {
  /** Mints whose DEX Screener data was present in this response. */
  seen: string[];
  /** Mints that got a baseline recorded this call (silent, no alert). */
  baselined: string[];
  /** Mints for which an order check was queued. */
  orderChecksQueued: string[];
  /** Mints for which a social-change alert was enqueued. */
  alerted: string[];
}

/**
 * Process one batch (<=30) of DEX Screener token info for already-monitored
 * launches. For each mint, ALL of the following happen in one SQLite transaction
 * so a crash can never record the new snapshot but lose the alert/job:
 *
 *   - first valid response  -> record snapshot + mark baseline done, NO social
 *     alert (the starting state is not an "update"). If that starting profile is
 *     already full, queue ONE order check (it may have paid before our first
 *     poll) — still no social alert.
 *   - later responses       -> diff websites/socials; alert on real changes.
 *   - profile appeared or its fingerprint changed -> queue an order check.
 *     (The info change is only a hint; only an order from the orders endpoint
 *     produces a paid alert.)
 *   - a change that only REMOVES things is applied after it is seen twice in a
 *     row, so one thin DEX Screener response does not read as "dev deleted it".
 *
 * An absent mint is never treated as a removal; it simply is not in `seen`.
 */
export function applySocialBatch(
  deps: TrackerDeps,
  mints: string[],
  infos: Map<string, TokenInfo>,
  now: number = Date.now(),
  opts: PollOpts = {}
): SocialPollResult {
  const result: SocialPollResult = { seen: [], baselined: [], orderChecksQueued: [], alerted: [] };

  const tx = deps.db.raw.transaction(() => {
    for (const mint of mints) {
      const info = infos.get(mint);
      if (!info || !info.present) continue;
      result.seen.push(mint);

      const launch = deps.db.getLaunchByMint(mint);
      const prev = deps.db.getSnapshot(mint);
      const fp = fingerprintOf(info);
      const firstSnapshot = prev === undefined || launch?.baseline_done !== 1;

      if (firstSnapshot || opts.silent) {
        // Starting state: record it, don't announce it.
        deps.db.upsertSnapshot(infoToSnapshotRow(mint, info, now));
        if (launch && launch.baseline_done !== 1) {
          deps.db.setBaselineDone(mint);
          result.baselined.push(mint);
        }
        if (!opts.silent && isFullInfo(info) && launch?.origin === "live") {
          deps.db.enqueueOrderCheck(mint, "baseline_info", now, ORDER_CHECK_WINDOW_MS);
          result.orderChecksQueued.push(mint);
        }
        continue;
      }

      const diff = diffSocials(prev, info);
      const prevFp = prev?.info_fingerprint ?? null;

      // Removal-only changes need a second consecutive sighting before applying.
      const onlyRemovals =
        diff !== null &&
        diff.websitesAdded.length === 0 &&
        diff.socialsAdded.length === 0 &&
        (diff.websitesRemoved.length > 0 || diff.socialsRemoved.length > 0);
      if (onlyRemovals && prev?.pending_fingerprint !== fp) {
        deps.db.upsertSnapshot({ ...prev!, pending_fingerprint: fp, updated_at: now });
        continue;
      }

      deps.db.upsertSnapshot(infoToSnapshotRow(mint, info, now));

      // Profile appeared or changed -> check orders (once; deadline-bounded).
      const hadProfile = Boolean(prev && prev.has_info === 1 && prevFp);
      const profileChanged = prevFp !== null && prevFp !== fp;
      if (info.hasInfo && (!hadProfile || profileChanged)) {
        deps.db.enqueueOrderCheck(
          mint,
          hadProfile ? "info_changed" : "info_appeared",
          now,
          ORDER_CHECK_WINDOW_MS
        );
        result.orderChecksQueued.push(mint);
      }

      if (!diff) continue;
      const key = eventKey([
        "social",
        mint,
        JSON.stringify(diff.websitesAdded),
        JSON.stringify(diff.websitesRemoved),
        JSON.stringify(diff.socialsAdded.map((s) => s.url)),
        JSON.stringify(diff.socialsRemoved.map((s) => s.url)),
      ]);
      if (
        deps.db.enqueueEvent({
          eventKey: key,
          baseMint: mint,
          kind: "social",
          text: deps.formatSocial(mint, diff, false, info),
        })
      ) {
        result.alerted.push(mint);
      }
    }
  });
  tx();
  return result;
}

/**
 * Fetch + apply one social batch. Kept as a thin wrapper so tests and callers
 * can inject the fetcher. Returns the mints present in the response.
 */
export async function pollSocials(
  deps: TrackerDeps,
  mints: string[],
  fetchInfoFn: (m: string[]) => Promise<Map<string, TokenInfo>> = fetchTokenInfo,
  opts: PollOpts = {}
): Promise<string[]> {
  if (mints.length === 0) return [];
  const infos = await fetchInfoFn(mints);
  return applySocialBatch(deps, mints, infos, Date.now(), opts).seen;
}

/**
 * Backoff for the Nth failed/empty order check, with a little jitter.
 */
export function orderRetryDelayMs(attempts: number, rand: () => number = Math.random): number {
  const base = ORDER_RETRY_BACKOFF_MS[Math.min(attempts, ORDER_RETRY_BACKOFF_MS.length - 1)]!;
  return Math.round(base * (0.85 + rand() * 0.3));
}

export type OrderCheckOutcome = "done" | "retry" | "expired";

/**
 * Run one due order check. A tokenProfile order that is `approved`, `rejected`
 * or `cancelled` ends the job; `processing`/`on-hold`/nothing yet retries until
 * the deadline. Alerts are produced by `pollOrders` (deduped by event key), so a
 * retry that re-reads the same order never alerts twice.
 */
export async function runOrderCheck(
  deps: TrackerDeps,
  mint: string,
  fns: { fetchOrders?: (m: string) => Promise<OrderEntry[]>; now?: number } = {}
): Promise<OrderCheckOutcome> {
  const now = fns.now ?? Date.now();
  const job = deps.db.getOrderCheck(mint);
  if (!job || job.status !== "pending") return "done";

  const { changes } = await pollOrders(deps, mint, fns.fetchOrders ?? fetchOrders);
  const orders = deps.db.getOrders(mint).filter((o) => o.order_type === PROFILE_ORDER_TYPE);
  const terminal = orders.some((o) => ["approved", "rejected", "cancelled"].includes(o.status));
  void changes;

  if (terminal) {
    deps.db.finishOrderCheck(mint, "done");
    return "done";
  }
  if (now >= job.deadline_at) {
    deps.db.finishOrderCheck(mint, "expired");
    return "expired";
  }
  deps.db.retryOrderCheck(mint, now + orderRetryDelayMs(job.attempts));
  return "retry";
}
