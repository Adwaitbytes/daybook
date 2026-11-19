import { type Address, concat, encodeAbiParameters, getContractAddress, type Hex, keccak256 } from "viem";

// Ported from daybook/scripts/src/payAddress.ts; keep the two in step.

/** EIP-1167 clone init code around `implementation`, byte for byte what OpenZeppelin's Clones library deploys. */
export function cloneInitCode(implementation: Address): Hex {
  return concat(["0x3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, "0x5af43d82803e903d91602b57fd5bf3"]);
}

/** The factory deploys the vault implementation with its first CREATE (contract nonces start at 1). */
export function vaultImplementation(factory: Address): Address {
  return getContractAddress({ opcode: "CREATE", from: factory, nonce: 1n });
}

export function invoiceSalt(reactive: Address, invoiceId: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [reactive, invoiceId]));
}

/** The invoice's pay address, identical on every chain where the factory is deployed. */
export function payAddress(factory: Address, reactive: Address, invoiceId: bigint): Address {
  if (invoiceId <= 0n) throw new RangeError("invoiceId starts at 1");
  return getContractAddress({
    opcode: "CREATE2",
    from: factory,
    salt: invoiceSalt(reactive, invoiceId),
    bytecode: cloneInitCode(vaultImplementation(factory)),
  });
}

/** Arachnid's deterministic deployer, present on every payment chain (ref/FACTS.md section 5). */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
/** keccak256("daybook.pay-address-factory.v1"), the deploy scripts' default factory salt. */
export const FACTORY_SALT: Hex = keccak256(new TextEncoder().encode("daybook.pay-address-factory.v1"));

/** Where a PayAddressFactory owned by `owner` lands through the CREATE2 deployer. */
export function predictFactory(factoryCreationCode: Hex, owner: Address): Address {
  const init = concat([factoryCreationCode, encodeAbiParameters([{ type: "address" }], [owner])]);
  return getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: FACTORY_SALT, bytecode: init });
}
