# Daybook

Invoices that mark themselves paid. A client pays in USDC on any supported chain to one address that is the same on every chain; a reactive contract on Reactive Network matches the payment, keeps the ledger, and has the till on that chain sweep the funds, set tax aside, pay the team split, send the rest to the treasury and issue a receipt.

Status: contracts, local Omni harness and tests are done; nothing is deployed yet. See `docs/ARCHITECTURE.md` for how the loop works and `docs/DECISIONS.md` for why.

```
make test        # Foundry suite (unit, scenario, fuzz, invariant) and the CLI's type check and tests
```

Dependencies: Foundry 1.8.4, forge-std v1.17.0, reactive-lib-omni v0.1.0, OpenZeppelin Contracts v5.7.0, viem 2.58.1, TypeScript 5.9.3, Node 24 or later.

MIT licensed.
