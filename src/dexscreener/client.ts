import { log } from "../logger.js";

const BASE = "https://api.dexscreener.com";

export interface OrderEntry {
  type: string; // tokenProfile | communityTakeover | tokenAd | trendingBarAd
  status: string; // processing | cancelled | on-hold | approved | rejected
  paymentTimestamp?: number;
}

export interface TokenSocial {
  type: string;
  url: string;
}

export interface TokenInfo {
  /** true if DEX Screener returned pair data at all. */
  present: boolean;
  /** true if an info/profile block (websites/socials) was present. */
  hasInfo: boolean;
  websites: string[];
  socials: TokenSocial[];
}

export class DexScreenerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "DexScreenerError";
  }
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429 || res.status >= 500) {
    const ra = res.headers.get("retry-after");
    const retryAfterMs = ra ? Number(ra) * 1000 : undefined;
    throw new DexScreenerError(`HTTP ${res.status} for ${path}`, res.status, retryAfterMs);
  }
  if (!res.ok) {
    throw new DexScreenerError(`HTTP ${res.status} for ${path}`, res.status);
  }
  return res.json();
}

/**
 * Paid orders for a token. Docs: GET /orders/v1/{chainId}/{tokenAddress},
 * 60 req/min. Returns [] for a token with no orders.
 */
export async function fetchOrders(mint: string, chain = "solana"): Promise<OrderEntry[]> {
  const data = await get(`/orders/v1/${chain}/${encodeURIComponent(mint)}`);
  return parseOrders(data);
}

/**
 * The live endpoint returns `{ orders: [...], boosts: [...] }`; older docs show
 * a bare array. Accept both. Anything else yields no orders.
 */
export function parseOrders(data: unknown): OrderEntry[] {
  const list: unknown = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? (data as Record<string, unknown>).orders
      : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .map((d) => ({
      type: String(d.type ?? ""),
      status: String(d.status ?? ""),
      paymentTimestamp:
        typeof d.paymentTimestamp === "number" ? d.paymentTimestamp : undefined,
    }));
}

/**
 * Websites + socials for up to 30 mints in one call.
 * Docs: GET /tokens/v1/{chainId}/{addresses} (comma-separated), 300 req/min.
 *
 * Returns a map mint -> TokenInfo. A mint missing from the response is returned
 * with present=false (not treated as "socials removed").
 */
export async function fetchTokenInfo(
  mints: string[],
  chain = "solana"
): Promise<Map<string, TokenInfo>> {
  const out = new Map<string, TokenInfo>();
  for (const m of mints) out.set(m, { present: false, hasInfo: false, websites: [], socials: [] });
  if (mints.length === 0) return out;
  if (mints.length > 30) throw new Error("fetchTokenInfo: max 30 mints per call");

  const joined = mints.map((m) => encodeURIComponent(m)).join(",");
  const data = await get(`/tokens/v1/${chain}/${joined}`);
  const pairs = Array.isArray(data) ? data : [];

  // A mint can appear on several pairs; merge deterministically.
  for (const pair of pairs) {
    const p = pair as Record<string, any>;
    const baseAddr: string | undefined = p?.baseToken?.address;
    if (!baseAddr || !out.has(baseAddr)) continue;
    const info = p?.info as Record<string, any> | undefined;
    const cur = out.get(baseAddr)!;
    cur.present = true;
    if (info) {
      cur.hasInfo = true;
      for (const w of info.websites ?? []) {
        const url = typeof w === "string" ? w : w?.url;
        if (url) cur.websites.push(String(url));
      }
      for (const s of info.socials ?? []) {
        if (s?.url) cur.socials.push({ type: String(s.type ?? "link"), url: String(s.url) });
      }
    }
  }

  // Normalize: dedup + sort so pair ordering never produces false diffs.
  for (const [, info] of out) {
    info.websites = [...new Set(info.websites)].sort();
    info.socials = dedupSortSocials(info.socials);
  }
  void log;
  return out;
}

export function dedupSortSocials(socials: TokenSocial[]): TokenSocial[] {
  const map = new Map<string, TokenSocial>();
  for (const s of socials) map.set(`${s.type}|${s.url}`, s);
  return [...map.values()].sort((a, b) =>
    `${a.type}|${a.url}`.localeCompare(`${b.type}|${b.url}`)
  );
}
