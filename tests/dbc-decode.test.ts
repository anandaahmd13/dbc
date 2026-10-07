import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection } from "@solana/web3.js";
import { DbcClient, decodeInitializePoolFromInner } from "../src/solana/dbc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/init-pool-tx.json"), "utf8")
) as {
  accountKeys: string[];
  inner: Array<{ index: number; instructions: Array<{ data: string; programIdIndex: number }> }>;
  programId: string;
};

// Real mainnet InitializeVirtualPoolWithSplToken tx:
// 35D8es6Z9NK7zQVAUtMZeq79fBCD7N6Tvfz5sKvH3JgT12A6Q7rExi6avPcmNSJkNwKJW2nC9eRn3K5PVYv54RmN
describe("decodeInitializePoolFromInner (emit_cpi! events)", () => {
  // getProgram() only needs the coder, not a live connection.
  const dbc = new DbcClient(new Connection("https://api.mainnet-beta.solana.com"));

  it("decodes pool/baseMint/creator from inner instructions", () => {
    const events = decodeInitializePoolFromInner(
      dbc.program as any,
      fixture.inner,
      fixture.accountKeys,
      fixture.programId
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      pool: "DyQccRkbMVSVoGe4QfoHLBQ5CeWXp5SeV36goYmEcouE",
      baseMint: "BVNHWPCii8veEyVTcufjLF6buYadUNVfMqUMcCiut1Aj",
      creator: "Hqf6ooojUnyRMuzdU96h6jYQR13J1NCrrSc5QSqdHnCz",
    });
  });

  it("returns [] when the program id doesn't match", () => {
    const events = decodeInitializePoolFromInner(
      dbc.program as any,
      fixture.inner,
      fixture.accountKeys,
      "11111111111111111111111111111111"
    );
    expect(events).toHaveLength(0);
  });
});
