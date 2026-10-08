import { describe, it, expect, beforeEach } from "vitest";
import { Db } from "../src/db.js";
import { evaluateCreator } from "../src/solana/creator-history.js";
import { DbcClient, type CreatorPools } from "../src/solana/dbc.js";
import { Connection } from "@solana/web3.js";

function fakeDbc(scan: (c: string) => Promise<CreatorPools>): DbcClient {
  return { getCreatorPools: (c: string) => scan(c) } as unknown as DbcClient;
}
const held = (n: number, complete = true): CreatorPools => ({
  pools: Array.from({ length: n }, (_, i) => ({ baseMint: `mint${i}` })),
  complete,
});

describe("evaluateCreator", () => {
  let db: Db;
  beforeEach(() => {
    db = new Db(":memory:");
  });

  it("counts the mint being evaluated even if the scan has not seen it yet", async () => {
    const r = await evaluateCreator(db, fakeDbc(async () => held(0)), "c1", 10, { currentMint: "new" });
    expect(r.eligibility).toBe("eligible");
    expect(r.launchCount).toBe(1); // not 0
  });

  it("does not double count the current mint when the scan lists it", async () => {
    const r = await evaluateCreator(db, fakeDbc(async () => held(3)), "c2", 10, { currentMint: "mint1" });
    expect(r.launchCount).toBe(3);
  });

  it("boundary: 10 distinct mints incl. current is eligible, 11 is ineligible", async () => {
    const nine = await evaluateCreator(db, fakeDbc(async () => held(9)), "c3", 10, { currentMint: "cur" });
    expect(nine.launchCount).toBe(10);
    expect(nine.eligibility).toBe("eligible");
    const ten = await evaluateCreator(db, fakeDbc(async () => held(10)), "c4", 10, { currentMint: "cur" });
    expect(ten.launchCount).toBe(11);
    expect(ten.eligibility).toBe("ineligible");
  });

  it("includes launches this bot saw the wallet create, even if the account later moved away", async () => {
    // Previously recorded from creation events; the account scan no longer lists them.
    for (let i = 0; i < 10; i++) {
      db.insertLaunch({
        pool: `old-p${i}`, base_mint: `old${i}`, creator: "serial", signature: null,
        detected_at: 1, watch_until: 0, eligible: false,
      });
    }
    const r = await evaluateCreator(db, fakeDbc(async () => held(0)), "serial", 10, { currentMint: "fresh" });
    expect(r.launchCount).toBe(11);
    expect(r.eligibility).toBe("ineligible");
  });

  it("RPC failure -> unknown, never 0 and never eligible", async () => {
    const r = await evaluateCreator(
      db,
      fakeDbc(async () => {
        throw new Error("Request deprioritized due to number of accounts requested");
      }),
      "c5",
      10,
      { currentMint: "m" }
    );
    expect(r.eligibility).toBe("unknown");
    expect(r.launchCount).toBeNull();
    expect(db.getCreator("c5")!.eligibility).toBe("unknown");
  });

  it("a truncated/incomplete scan is unknown, not eligible", async () => {
    const r = await evaluateCreator(db, fakeDbc(async () => held(2, false)), "c6", 10, { currentMint: "m" });
    expect(r.eligibility).toBe("unknown");
  });

  it("an incomplete scan that already exceeds the limit is still proven ineligible", async () => {
    const r = await evaluateCreator(db, fakeDbc(async () => held(15, false)), "c7", 10, { currentMint: "m" });
    expect(r.eligibility).toBe("ineligible");
  });

  it("ineligible is permanent: later calls do not rescan", async () => {
    let scans = 0;
    const dbc = fakeDbc(async () => (scans++, held(15)));
    await evaluateCreator(db, dbc, "c8", 10, { currentMint: "m" });
    await evaluateCreator(db, dbc, "c8", 10, { currentMint: "m", now: Date.now() + 3_600_000 });
    expect(scans).toBe(1);
  });

  it("eligible is cached only for the TTL, then re-counted", async () => {
    let scans = 0;
    const dbc = fakeDbc(async () => (scans++, held(2)));
    const t0 = Date.now();
    await evaluateCreator(db, dbc, "c9", 10, { currentMint: "m", now: t0 });
    await evaluateCreator(db, dbc, "c9", 10, { currentMint: "m", now: t0 + 60_000 });
    expect(scans).toBe(1); // inside the 5 minute TTL
    await evaluateCreator(db, dbc, "c9", 10, { currentMint: "m", now: t0 + 6 * 60_000 });
    expect(scans).toBe(2); // expired -> recount
  });

  it("a creator who launches more tokens flips from eligible to ineligible after the TTL", async () => {
    let n = 9;
    const dbc = fakeDbc(async () => held(n));
    const t0 = Date.now();
    expect((await evaluateCreator(db, dbc, "c10", 10, { currentMint: "m", now: t0 })).eligibility).toBe("eligible");
    n = 12;
    expect(
      (await evaluateCreator(db, dbc, "c10", 10, { currentMint: "m", now: t0 + 6 * 60_000 })).eligibility
    ).toBe("ineligible");
  });

  it("unknown is retried after its short TTL and can become eligible", async () => {
    let attempt = 0;
    const dbc = fakeDbc(async () => {
      if (++attempt === 1) throw new Error("429");
      return held(1);
    });
    const t0 = Date.now();
    expect((await evaluateCreator(db, dbc, "c11", 10, { currentMint: "m", now: t0 })).eligibility).toBe("unknown");
    // still inside the unknown TTL: no new scan
    expect((await evaluateCreator(db, dbc, "c11", 10, { currentMint: "m", now: t0 + 5_000 })).eligibility).toBe("unknown");
    expect(attempt).toBe(1);
    expect((await evaluateCreator(db, dbc, "c11", 10, { currentMint: "m", now: t0 + 60_000 })).eligibility).toBe("eligible");
  });

  it("concurrent launches by one creator share a single scan", async () => {
    let scans = 0;
    const dbc = fakeDbc(async () => {
      scans++;
      await new Promise((r) => setTimeout(r, 20));
      return held(1);
    });
    await Promise.all([1, 2, 3, 4, 5].map((i) => evaluateCreator(db, dbc, "burst", 10, { currentMint: `m${i}` })));
    expect(scans).toBe(1);
  });
});

describe("DbcClient.getCreatorPools (getProgramAccountsV2 pagination)", () => {
  const conn = new Connection("https://api.mainnet-beta.solana.com");
  // A pool account slice: 32 bytes creator + 32 bytes base mint.
  const slice = (mintByte: number) => {
    const buf = Buffer.alloc(64, 0);
    buf.fill(mintByte, 32, 64);
    return [buf.toString("base64"), "base64"];
  };
  const page = (mints: number[], key: string | null) => ({
    result: { accounts: mints.map((m) => ({ pubkey: `pool${m}`, account: { data: slice(m) } })), paginationKey: key },
  });

  it("follows paginationKey through short pages until it is null", async () => {
    const calls: any[] = [];
    const pages: Record<string, any> = { "": page([1], "k1"), k1: page([], "k2"), k2: page([2], null) };
    const dbc = new DbcClient(conn, async (_m, params: any[]) => {
      calls.push(params[1]);
      return pages[params[1].paginationKey ?? ""] ?? page([], null);
    });
    const r = await dbc.getCreatorPools("Hqf6ooojUnyRMuzdU96h6jYQR13J1NCrrSc5QSqdHnCz");
    // Both account variants are scanned (VirtualPool + TransferHookPool).
    expect(r.complete).toBe(true);
    expect(new Set(r.pools.map((p) => p.pool))).toEqual(new Set(["pool1", "pool2"]));
    expect(calls.some((c) => c.paginationKey === "k1")).toBe(true); // empty page did not stop it
    expect(calls[0].dataSlice).toEqual({ offset: 104, length: 64 });
    expect(calls[0].filters[1].memcmp).toMatchObject({ offset: 104 });
  });

  it("a repeating cursor is reported incomplete instead of looping or claiming success", async () => {
    const dbc = new DbcClient(conn, async () => page([1], "same"));
    const r = await dbc.getCreatorPools("Hqf6ooojUnyRMuzdU96h6jYQR13J1NCrrSc5QSqdHnCz");
    expect(r.complete).toBe(false);
  });

  it("a page that errors mid-scan throws (caller records unknown)", async () => {
    let n = 0;
    const dbc = new DbcClient(conn, async () => {
      if (n++ === 1) throw new Error("RPC getProgramAccountsV2 failed: 429 Too many requests");
      return page([1], "k1");
    });
    await expect(dbc.getCreatorPools("Hqf6ooojUnyRMuzdU96h6jYQR13J1NCrrSc5QSqdHnCz")).rejects.toThrow(/429/);
  });
});
