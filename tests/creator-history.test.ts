import { describe, it, expect } from "vitest";
import { Db } from "../src/db.js";
import { evaluateCreator } from "../src/solana/creator-history.js";
import type { DbcClient } from "../src/solana/dbc.js";

function fakeDbc(poolsByCreator: (c: string) => Promise<{ baseMint: string }[]>): DbcClient {
  return { getPoolsByCreator: (c: string) => poolsByCreator(c) } as unknown as DbcClient;
}

const pools = (n: number, dupLast = false) => {
  const arr = Array.from({ length: n }, (_, i) => ({ baseMint: `mint${i}` }));
  if (dupLast && arr.length) arr.push({ baseMint: `mint${n - 1}` }); // duplicate shouldn't inflate count
  return arr;
};

describe("evaluateCreator", () => {
  it("0 launches -> eligible", async () => {
    const db = new Db(":memory:");
    const r = await evaluateCreator(db, fakeDbc(async () => pools(0)), "c", 10);
    expect(r.eligibility).toBe("eligible");
    expect(r.launchCount).toBe(0);
    db.close();
  });

  it("exactly 10 -> eligible (inclusive)", async () => {
    const db = new Db(":memory:");
    const r = await evaluateCreator(db, fakeDbc(async () => pools(10)), "c", 10);
    expect(r.eligibility).toBe("eligible");
    expect(r.launchCount).toBe(10);
    db.close();
  });

  it("11 -> ineligible", async () => {
    const db = new Db(":memory:");
    const r = await evaluateCreator(db, fakeDbc(async () => pools(11)), "c", 10);
    expect(r.eligibility).toBe("ineligible");
    expect(r.launchCount).toBe(11);
    db.close();
  });

  it("duplicate base mints counted once", async () => {
    const db = new Db(":memory:");
    const r = await evaluateCreator(db, fakeDbc(async () => pools(10, true)), "c", 10);
    expect(r.launchCount).toBe(10);
    expect(r.eligibility).toBe("eligible");
    db.close();
  });

  it("RPC failure -> unknown, never 0/eligible", async () => {
    const db = new Db(":memory:");
    const r = await evaluateCreator(
      db,
      fakeDbc(async () => {
        throw new Error("getProgramAccounts disabled");
      }),
      "c",
      10
    );
    expect(r.eligibility).toBe("unknown");
    expect(r.launchCount).toBeNull();
    expect(db.getCreator("c")?.eligibility).toBe("unknown");
    db.close();
  });

  it("uses cache on second call without forceRefresh", async () => {
    const db = new Db(":memory:");
    let calls = 0;
    const dbc = fakeDbc(async () => {
      calls++;
      return pools(2);
    });
    await evaluateCreator(db, dbc, "c", 10);
    await evaluateCreator(db, dbc, "c", 10);
    expect(calls).toBe(1);
    db.close();
  });

  it("unknown is re-evaluated (not cached as final)", async () => {
    const db = new Db(":memory:");
    let attempt = 0;
    const dbc = fakeDbc(async () => {
      attempt++;
      if (attempt === 1) throw new Error("temporary");
      return pools(1);
    });
    const r1 = await evaluateCreator(db, dbc, "c", 10);
    expect(r1.eligibility).toBe("unknown");
    const r2 = await evaluateCreator(db, dbc, "c", 10);
    expect(r2.eligibility).toBe("eligible");
    db.close();
  });
});
