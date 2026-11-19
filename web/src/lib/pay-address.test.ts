import { describe, expect, it } from "vitest";
import { payAddress, vaultImplementation } from "./pay-address";

describe("payAddress", () => {
  it("matches the scripts' local vector", () => {
    expect(
      payAddress("0xcd8B4366d57968e186a9BE0041d96fb51294CCed", "0x5FbDB2315678afecb367f032d93F642f64180aa3", 1n),
    ).toBe("0x21fad6bcBF1Cb76f20a406534879624884017736");
  });

  it("matches invoice 2 of the Lasna deployment read with cast on 19 Nov 2026", () => {
    // DaybookReactive 0x182B…78d3 on Lasna: FACTORY() and getInvoice(2).payAddress.
    expect(
      payAddress("0xA7984241CC7596B0ED7C3b71409Bda7cf6E0D33c", "0x182BA62E240433B54136712d8840Ccc354bb78d3", 2n),
    ).toBe("0x9cD2d5DFfd3D1e119d04898872bbd47C38878a6e");
  });

  it("rejects id zero", () => {
    expect(() =>
      payAddress(
        vaultImplementation("0xcd8B4366d57968e186a9BE0041d96fb51294CCed"),
        "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        0n,
      ),
    ).toThrow(RangeError);
  });
});
