import { type Address, getAddress } from "viem";

/**
 * EIP-681 payment request for an ERC-20 transfer:
 *   ethereum:<token>@<chainId>/transfer?address=<to>&uint256=<raw amount>
 * Wallets that read EIP-681 prefill token, chain, recipient and the exact raw amount.
 */
export function erc20TransferUri(p: { chainId: number; token: Address; to: Address; amountRaw: bigint }): string {
  if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0) throw new RangeError("chainId must be a positive integer");
  if (p.amountRaw <= 0n) throw new RangeError("amount must be positive");
  const token = getAddress(p.token);
  const to = getAddress(p.to);
  return `ethereum:${token}@${p.chainId}/transfer?address=${to}&uint256=${p.amountRaw.toString()}`;
}
