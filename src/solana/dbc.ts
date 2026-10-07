import { Connection, PublicKey } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export const DBC_PROGRAM_ID = DYNAMIC_BONDING_CURVE_PROGRAM_ID;

export interface PoolInfo {
  pool: string;
  baseMint: string;
  creator: string;
  isMigrated: boolean;
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

/**
 * Decode the `creator` + `baseMint` + `pool` out of an EvtInitializePool
 * program event emitted in a transaction's log messages.
 *
 * Anchor events are base64-encoded after the `Program data: ` prefix.
 * Returns every initialize-pool event found in the logs.
 */
export function decodeInitializePoolEvents(
  program: { coder: { events: { decode: (b64: string) => { name: string; data: any } | null } } },
  logs: string[]
): Array<{ pool: string; baseMint: string; creator: string }> {
  const out: Array<{ pool: string; baseMint: string; creator: string }> = [];
  for (const line of logs) {
    const b64 = extractProgramData(line);
    if (!b64) continue;
    let decoded: { name: string; data: any } | null = null;
    try {
      decoded = program.coder.events.decode(b64);
    } catch {
      decoded = null;
    }
    if (!decoded) continue;
    if (!/^EvtInitializePool/.test(decoded.name)) continue;
    const d = decoded.data;
    if (!d?.pool || !d?.baseMint || !d?.creator) continue;
    out.push({
      pool: toB58(d.pool),
      baseMint: toB58(d.baseMint),
      creator: toB58(d.creator),
    });
  }
  return out;
}

function extractProgramData(line: string): string | null {
  const m = line.match(/Program data: (.+)/);
  return m ? m[1]!.trim() : null;
}

function toB58(v: any): string {
  return v?.toBase58 ? v.toBase58() : String(v);
}
