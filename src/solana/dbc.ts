import { Connection, PublicKey } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
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

  constructor(public readonly connection: Connection) {
    this.client = new DynamicBondingCurveClient(connection, "confirmed");
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
