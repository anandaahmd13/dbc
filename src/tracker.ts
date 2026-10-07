import type { Db, SnapshotRow, OrderRow } from "./db.js";
import type { OrderEntry, TokenInfo, TokenSocial } from "./dexscreener/client.js";
import { fetchOrders, fetchTokenInfo } from "./dexscreener/client.js";
import { createHash } from "node:crypto";

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

export function infoToSnapshotRow(mint: string, info: TokenInfo, now: number): SnapshotRow {
  return {
    base_mint: mint,
    websites_json: JSON.stringify([...new Set(info.websites)].sort()),
    socials_json: JSON.stringify(info.socials),
    has_info: info.hasInfo ? 1 : 0,
    updated_at: now,
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

/**
 * Poll a single mint's orders and persist/diff. Pure of network concerns except
 * the two injected fetchers (so tests can stub). Enqueues alerts atomically.
 */
export async function pollOrders(
  deps: TrackerDeps,
  mint: string,
  fetchOrdersFn: (m: string) => Promise<OrderEntry[]> = fetchOrders
): Promise<{ changes: OrderChange[]; baseline: boolean }> {
  const fresh = await fetchOrdersFn(mint);
  const stored = deps.db.getOrders(mint);
  const baseline = stored.length === 0;
  const changes = diffOrders(stored, fresh);
  const now = Date.now();

  for (const o of fresh) {
    if (o.type !== PROFILE_ORDER_TYPE) continue;
    deps.db.upsertOrder({
      base_mint: mint,
      order_type: o.type,
      status: o.status,
      payment_ts: o.paymentTimestamp ?? null,
      updated_at: now,
    });
  }

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
      text: deps.formatOrder(mint, c, baseline),
    });
  }
  return { changes, baseline };
}

/**
 * Poll social info for a batch of mints (<=30), diff + enqueue.
 */
export async function pollSocials(
  deps: TrackerDeps,
  mints: string[],
  fetchInfoFn: (m: string[]) => Promise<Map<string, TokenInfo>> = fetchTokenInfo
): Promise<void> {
  if (mints.length === 0) return;
  const infos = await fetchInfoFn(mints);
  const now = Date.now();

  for (const mint of mints) {
    const info = infos.get(mint);
    if (!info || !info.present) continue; // absent response != removal

    const prev = deps.db.getSnapshot(mint);
    const baseline = prev === undefined;
    const diff = diffSocials(prev, info);
    deps.db.upsertSnapshot(infoToSnapshotRow(mint, info, now));

    if (!diff) continue;
    if (baseline && !info.hasInfo) continue; // nothing to announce on an empty baseline

    const key = eventKey([
      "social",
      mint,
      baseline ? "baseline" : "change",
      JSON.stringify(diff.websitesAdded),
      JSON.stringify(diff.websitesRemoved),
      JSON.stringify(diff.socialsAdded.map((s) => s.url)),
      JSON.stringify(diff.socialsRemoved.map((s) => s.url)),
    ]);
    deps.db.enqueueEvent({
      eventKey: key,
      baseMint: mint,
      kind: "social",
      text: deps.formatSocial(mint, diff, baseline, info),
    });
  }
}
