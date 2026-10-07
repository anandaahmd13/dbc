import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/scheduler.js";

describe("RateLimiter", () => {
  it("allows up to rpm tokens immediately then throttles", () => {
    let t = 0;
    const rl = new RateLimiter(60, () => t); // 60/min = 1/sec
    // burst of 60 available
    for (let i = 0; i < 60; i++) {
      expect(rl.msUntilToken()).toBe(0);
      // emulate acquire by decrementing via private path: use msUntilToken + manual
      (rl as any).tokens -= 1;
    }
    // now empty: next token needs ~1000ms
    const wait = rl.msUntilToken();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1000);

    // advance time 1s -> one token back
    t += 1000;
    expect(rl.msUntilToken()).toBe(0);
  });
});
