/** What the demo-pay route answers. Every failure has a code the page has a designed state for. */
export type DemoPayResult =
  | { ok: true; invoiceId: string; created: boolean; payTx: `0x${string}`; chainId: number; amount: string }
  | {
      ok: false;
      code:
        | "not-configured"
        | "not-deployed"
        | "rate-limited"
        | "no-demo-invoice"
        | "relayer-empty"
        | "rpc-error"
        | "failed";
      message: string;
      retryAfterSeconds?: number;
    };
