import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA, UNICHAIN_SEPOLIA } from "./chains";
import { toTokenUnits } from "./format";
import { erc20TransferUri } from "./qr-payload";

const to = "0x9cd2d5dffd3d1e119d04898872bbd47c38878a6e";

describe("erc20TransferUri", () => {
  it("builds an EIP-681 USDC transfer for Base Sepolia with checksummed addresses and raw units", () => {
    expect(erc20TransferUri({ chainId: BASE_SEPOLIA.id, token: BASE_SEPOLIA.usdc, to, amountRaw: 2_000_000n })).toBe(
      "ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532/transfer?address=0x9cD2d5DFfd3D1e119d04898872bbd47C38878a6e&uint256=2000000",
    );
  });

  it("uses the selected chain's id and token", () => {
    const uri = erc20TransferUri({ chainId: UNICHAIN_SEPOLIA.id, token: UNICHAIN_SEPOLIA.usdc, to, amountRaw: 1n });
    expect(uri.startsWith(`ethereum:${UNICHAIN_SEPOLIA.usdc}@1301/transfer?`)).toBe(true);
  });

  it("never uses scientific notation for large amounts", () => {
    const uri = erc20TransferUri({ chainId: 84532, token: BASE_SEPOLIA.usdc, to, amountRaw: 10n ** 24n });
    expect(uri.endsWith("uint256=1000000000000000000000000")).toBe(true);
  });

  it("rejects a zero amount and a bad chain id", () => {
    expect(() => erc20TransferUri({ chainId: 84532, token: BASE_SEPOLIA.usdc, to, amountRaw: 0n })).toThrow(RangeError);
    expect(() => erc20TransferUri({ chainId: 0, token: BASE_SEPOLIA.usdc, to, amountRaw: 1n })).toThrow(RangeError);
  });
});

describe("toTokenUnits", () => {
  it("scales 6-decimal invoice units to the token's decimals", () => {
    expect(toTokenUnits(1_500_000n, 6)).toBe(1_500_000n);
    expect(toTokenUnits(1_500_000n, 18)).toBe(1_500_000_000_000_000_000n);
  });
});
