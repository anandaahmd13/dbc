import { Connection, PublicKey } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import bs58 from "bs58";

export const DBC_PROGRAM_ID = DYNAMIC_BONDING_CURVE_PROGRAM_ID;

export interface PoolInfo {
  pool: string;
  baseMint: string;
  creator: string;
  isMigrated: boolean;
}

/** Pools a creator account currently holds, plus whether the scan is provably complete. */
export interface CreatorPools {
  pools: Array<{ baseMint: string; pool?: string }>;
  /** false when any page failed, a cursor repeated, or the page cap was hit. */
  complete: boolean;
}

/** Minimal JSON-RPC transport; injectable so pagination can be tested offline. */
export type RpcCall = (method: string, params: unknown[]) => Promise<any>;

// Field layout verified from the SDK IDL and on mainnet: in both VirtualPool and
// TransferHookPool the PoolState starts right after the 8-byte discriminator, and
// `creator` (32 bytes) is followed 32 bytes later by `base_mint`.
const CREATOR_OFFSET = 104;
const SLICE_LENGTH = 64;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;

export interface InitPoolEvent {
  pool: string;
  baseMint: string;
  creator: string;
}

/**
 * Thin wrapper over the Meteora DBC SDK state service.
 * Account shape confirmed on mainnet: `account.poolState.{creator,baseMint,isMigrated}`.
 */
export class DbcClient {
  readonly client: DynamicBondingCurveClient;

  private readonly rpc: RpcCall;

  constructor(public readonly connection: Connection, rpc?: RpcCall) {
    this.client = new DynamicBondingCurveClient(connection, "confirmed");
    this.rpc = rpc ?? ((method, params) => httpRpc(connection.rpcEndpoint, method, params));
  }

  /** The DBC Anchor program, used for event/account decoding. */
  get program() {
    return this.client.state.getProgram();
  }

  /** Resolve a DBC pool by its base mint, or null if the mint is not a DBC token. */
  async getPoolByBaseMint(baseMint: string | PublicKey): Promise<PoolInfo | null> {
    const pa = await this.client.state.getPoolByBaseMint(baseMint);
    if (!pa) return null;
    return toPoolInfo(pa.publicKey, pa.account);
  }

  /** Fetch a single pool by pool address. */
  async getPool(pool: string | PublicKey): Promise<PoolInfo | null> {
    const key = typeof pool === "string" ? new PublicKey(pool) : pool;
    const account = await this.client.state.getPool(key);
    if (!account) return null;
    return toPoolInfo(key, account);
  }

  /**
   * All DBC pools created by a wallet. The RPC must support the underlying
   * getProgramAccounts scan; callers treat a throw as "history unknown".
   */
  async getPoolsByCreator(creator: string | PublicKey): Promise<PoolInfo[]> {
    const list = await this.client.state.getPoolsByCreator(creator);
    return list.map((pa) => toPoolInfo(pa.publicKey, pa.account));
  }

  /**
   * Pools currently held by `creator`, via Helius `getProgramAccountsV2` with
   * cursor pagination (the plain `getProgramAccounts` is rejected for a program
   * this large). Falls back to the SDK scan when V2 is unavailable.
   *
   * This is a snapshot of CURRENT holdings. A pool transferred away is no longer
   * listed, so a clean result is not proof of every launch the wallet ever made:
   * callers combine it with launches recorded from creation events.
   */
  async getCreatorPools(creator: string): Promise<CreatorPools> {
    const found = new Map<string, { baseMint: string; pool?: string }>();
    let complete = true;
    try {
      for (const account of ["VirtualPool", "TransferHookPool"]) {
        const disc = accountDiscriminator(account);
        const part = await this.pagedCreatorScan(creator, disc);
        for (const p of part.pools) found.set(p.baseMint, p);
        complete &&= part.complete;
      }
      return { pools: [...found.values()], complete };
    } catch (err) {
      if (!isMethodUnavailable(err)) throw err;
      // V2 is a Helius extension; on other RPCs use the SDK (may be rejected for
      // size, in which case this throws and the caller records "unknown").
      const list = await this.getPoolsByCreator(creator);
      return { pools: list.map((p) => ({ baseMint: p.baseMint, pool: p.pool })), complete: true };
    }
  }

  private async pagedCreatorScan(creator: string, disc: number[]): Promise<CreatorPools> {
    const out: Array<{ baseMint: string; pool?: string }> = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const opts: Record<string, unknown> = {
        encoding: "base64",
        limit: PAGE_LIMIT,
        filters: [
          { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(disc)) } },
          { memcmp: { offset: CREATOR_OFFSET, bytes: creator } },
        ],
        dataSlice: { offset: CREATOR_OFFSET, length: SLICE_LENGTH },
      };
      if (cursor) opts.paginationKey = cursor;
      const res = await this.rpc("getProgramAccountsV2", [DBC_PROGRAM_ID.toBase58(), opts]);
      const result = res?.result ?? res;
      const accounts: any[] = result?.accounts ?? [];
      for (const a of accounts) {
        const raw = Buffer.from(a.account.data[0], "base64");
        if (raw.length < SLICE_LENGTH) continue;
        out.push({
          baseMint: new PublicKey(raw.subarray(32, 64)).toBase58(),
          pool: a.pubkey,
        });
      }
      const next: string | null = result?.paginationKey ?? null;
      // A filtered page may be short; only a null key ends the scan.
      if (!next) return { pools: out, complete: true };
      if (seenCursors.has(next)) return { pools: out, complete: false }; // stuck cursor
      seenCursors.add(next);
      cursor = next;
    }
    return { pools: out, complete: false }; // page cap: refuse to claim completeness
  }

  /**
   * Fetch a transaction and decode any initialize-pool events it contains,
   * checking both inner instructions (DBC emit_cpi! events) and log messages.
   */
  async decodeLaunchesFromTx(signature: string): Promise<InitPoolEvent[]> {
    const tx = await this.connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 2,
      commitment: "confirmed",
    });
    if (!tx) return [];

    const programId = DBC_PROGRAM_ID.toBase58();
    const msg: any = tx.transaction.message;
    const staticKeys: string[] = (msg.staticAccountKeys ?? msg.accountKeys ?? []).map((k: any) =>
      k.toBase58 ? k.toBase58() : String(k)
    );
    const loaded = tx.meta?.loadedAddresses;
    const accountKeys = [
      ...staticKeys,
      ...((loaded?.writable ?? []).map((k: any) => (k.toBase58 ? k.toBase58() : String(k)))),
      ...((loaded?.readonly ?? []).map((k: any) => (k.toBase58 ? k.toBase58() : String(k)))),
    ];

    const fromInner = decodeInitializePoolFromInner(
      this.program as any,
      (tx.meta?.innerInstructions as any) ?? [],
      accountKeys,
      programId
    );
    if (fromInner.length) return fromInner;

    // Fallback: legacy Program-data log events.
    return decodeInitializePoolEvents(this.program as any, tx.meta?.logMessages ?? []);
  }
}

function toPoolInfo(poolKey: PublicKey, account: any): PoolInfo {
  const ps = account?.poolState ?? account;
  const creator: PublicKey = ps.creator;
  const baseMint: PublicKey = ps.baseMint;
  return {
    pool: poolKey.toBase58(),
    baseMint: baseMint.toBase58(),
    creator: creator.toBase58(),
    isMigrated: Boolean(ps.isMigrated),
  };
}

type EventCoder = {
  coder: { events: { decode: (b64: string) => { name: string; data: any } | null } };
};

// Anchor self-CPI (`emit_cpi!`) events are carried as an inner instruction whose
// data is: 8-byte CPI sentinel + 8-byte event discriminator + borsh payload.
// The event coder expects base64 of (event disc + payload), so we drop the first
// 8 bytes. The sentinel in hex:
const CPI_EVENT_SENTINEL = "e445a52e51cb9a1d";

/** Match the initialize-pool event regardless of casing (evtInitializePool...). */
function isInitPool(name: string): boolean {
  return /^evtinitializepool/i.test(name);
}

function tryEvent(program: EventCoder, b64: string): { name: string; data: any } | null {
  try {
    return program.coder.events.decode(b64);
  } catch {
    return null;
  }
}

function pushIfInit(program: EventCoder, b64: string, out: InitPoolEvent[]): void {
  const decoded = tryEvent(program, b64);
  if (!decoded || !isInitPool(decoded.name)) return;
  const d = decoded.data;
  if (!d?.pool || !d?.baseMint || !d?.creator) return;
  out.push({ pool: toB58(d.pool), baseMint: toB58(d.baseMint), creator: toB58(d.creator) });
}

/**
 * Decode initialize-pool events from a transaction's log messages. DBC uses
 * `emit_cpi!` so most launches carry nothing here, but older `Program data:`
 * style events are still handled for safety.
 */
export function decodeInitializePoolEvents(program: EventCoder, logs: string[]): InitPoolEvent[] {
  const out: InitPoolEvent[] = [];
  for (const line of logs) {
    const b64 = extractProgramData(line);
    if (b64) pushIfInit(program, b64, out);
  }
  return out;
}

/**
 * Decode initialize-pool events from a transaction's inner instructions (the
 * real location for DBC `emit_cpi!` events). `innerInstructions` come from
 * `getTransaction(...).meta.innerInstructions`; each instruction's `data` is
 * base58-encoded.
 */
export function decodeInitializePoolFromInner(
  program: EventCoder,
  innerInstructions: Array<{ instructions: Array<{ data: string; programIdIndex: number }> }>,
  accountKeys: string[],
  programId: string
): InitPoolEvent[] {
  const out: InitPoolEvent[] = [];
  for (const inner of innerInstructions ?? []) {
    for (const ix of inner.instructions ?? []) {
      if (accountKeys[ix.programIdIndex] !== programId) continue;
      const raw = decodeBase58(ix.data);
      if (raw.length < 16) continue;
      if (raw.subarray(0, 8).toString("hex") !== CPI_EVENT_SENTINEL) continue;
      const b64 = raw.subarray(8).toString("base64");
      pushIfInit(program, b64, out);
    }
  }
  return out;
}

function extractProgramData(line: string): string | null {
  const m = line.match(/Program data: (.+)/);
  return m ? m[1]!.trim() : null;
}

function decodeBase58(s: string): Buffer {
  const dec = (bs58 as any).default ?? bs58;
  return Buffer.from(dec.decode(s));
}

function toB58(v: any): string {
  return v?.toBase58 ? v.toBase58() : String(v);
}

/** True for "this RPC doesn't have getProgramAccountsV2" (not a transient failure). */
function isMethodUnavailable(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /method not found|-32601|not supported|unknown method/i.test(m);
}

async function httpRpc(endpoint: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    const e = body?.error;
    throw new Error(`RPC ${method} failed: ${e ? `${e.code} ${e.message}` : `HTTP ${res.status}`}`);
  }
  return body;
}

/** Anchor account discriminator from the SDK's bundled IDL (e.g. "VirtualPool"). */
export function accountDiscriminator(name: string): number[] {
  const acc = (DynamicBondingCurveIdl as any).accounts.find((a: any) => a.name === name);
  if (!acc?.discriminator) throw new Error(`DBC IDL has no account named ${name}`);
  return acc.discriminator as number[];
}
