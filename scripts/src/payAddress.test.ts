import assert from "node:assert/strict";
import { test } from "node:test";
import { payAddress, vaultImplementation } from "./payAddress.ts";

// Vector from a local two-chain dry run of the deploy scripts (anvil, chain ids 5318007 and 84532): the reactive
// contract's payAddressOf(1) and the payment-chain factory's payAddress(salt) both returned the address below.
const factory = "0xcd8B4366d57968e186a9BE0041d96fb51294CCed";
const reactive = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

test("matches the on-chain computation", () => {
  assert.equal(payAddress(factory, reactive, 1n), "0x21fad6bcBF1Cb76f20a406534879624884017736");
});

test("differs per invoice and per reactive contract", () => {
  assert.notEqual(payAddress(factory, reactive, 1n), payAddress(factory, reactive, 2n));
  assert.notEqual(
    payAddress(factory, reactive, 1n),
    payAddress(factory, "0x0000000000000000000000000000000000000001", 1n),
  );
});

test("rejects invoice id zero", () => {
  assert.throws(() => payAddress(factory, reactive, 0n), RangeError);
});

test("implementation is the factory's first CREATE", () => {
  assert.match(vaultImplementation(factory), /^0x[0-9a-fA-F]{40}$/);
});
