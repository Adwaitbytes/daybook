import { describe, expect, it } from "vitest";
import { split } from "./split";

describe("split", () => {
  it("matches the on-chain policy 1 on a 2.00 USDC invoice", () => {
    // Policy 1 on Lasna: tax 15%, team 20% and 10%.
    expect(split(2_000_000n, 1500, [2000, 1000])).toEqual({
      tax: 300_000n,
      team: [400_000n, 200_000n],
      treasury: 1_100_000n,
    });
  });

  it("always sums to the amount plus excess, the treasury taking the dust", () => {
    const s = split(1_000_001n, 3333, [3333], 7n);
    expect(s.tax + s.team.reduce((a, b) => a + b, 0n) + s.treasury).toBe(1_000_008n);
  });

  it("rejects policies over 100%", () => {
    expect(() => split(1n, 6000, [5000])).toThrow(RangeError);
  });
});
