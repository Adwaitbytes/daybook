import { type Address, type Hex, concat, encodeAbiParameters, getContractAddress, keccak256 } from "viem";

/** EIP-1167 clone init code around `implementation`, byte for byte what OpenZeppelin's Clones library deploys. */
export function cloneInitCode(implementation: Address): Hex {
  return concat([
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73",
    implementation,
    "0x5af43d82803e903d91602b57fd5bf3",
  ]);
}

/** The factory deploys the vault implementation with its first CREATE (contract nonces start at 1). */
export function vaultImplementation(factory: Address): Address {
  return getContractAddress({ opcode: "CREATE", from: factory, nonce: 1n });
}

/** keccak256(abi.encode(reactive, invoiceId)): namespaced so a redeployed reactive contract never reuses an address. */
export function invoiceSalt(reactive: Address, invoiceId: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [reactive, invoiceId]));
}

/** The invoice's pay address, identical on every chain where the factory is deployed. Needs no RPC. */
export function payAddress(factory: Address, reactive: Address, invoiceId: bigint): Address {
  if (invoiceId <= 0n) throw new RangeError("invoiceId starts at 1");
  return getContractAddress({
    opcode: "CREATE2",
    from: factory,
    salt: invoiceSalt(reactive, invoiceId),
    bytecode: cloneInitCode(vaultImplementation(factory)),
  });
}
