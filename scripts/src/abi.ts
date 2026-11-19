const acceptedToken = {
  type: "tuple",
  components: [
    { name: "chainId", type: "uint64" },
    { name: "token", type: "address" },
    { name: "decimals", type: "uint8" },
  ],
} as const;

/** The slice of DaybookReactive this CLI touches. Kept by hand; the Foundry suite pins the Solidity side. */
export const daybookReactiveAbi = [
  {
    type: "function",
    name: "createInvoice",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "amount", type: "uint256" },
          { name: "dueAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
          { name: "policyId", type: "uint32" },
          { name: "strictTokens", type: "bool" },
          { name: "detailsHash", type: "bytes32" },
          { name: "accepted", type: "tuple[]", components: acceptedToken.components },
        ],
      },
    ],
    outputs: [{ name: "invoiceId", type: "uint256" }],
  },
  {
    type: "function",
    name: "getInvoice",
    stateMutability: "view",
    inputs: [{ name: "invoiceId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "payAddress", type: "address" },
          { name: "dueAt", type: "uint64" },
          { name: "policyId", type: "uint32" },
          { name: "expiresAt", type: "uint64" },
          { name: "createdAt", type: "uint64" },
          { name: "status", type: "uint8" },
          { name: "overdue", type: "bool" },
          { name: "strictTokens", type: "bool" },
          { name: "openSettlements", type: "uint16" },
          { name: "amount", type: "uint256" },
          { name: "paid", type: "uint256" },
          { name: "detailsHash", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "acceptedOf",
    stateMutability: "view",
    inputs: [{ name: "invoiceId", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: acceptedToken.components }],
  },
  {
    type: "function",
    name: "FACTORY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

export const invoiceStatus = ["None", "Open", "Paid", "Settled", "Cancelled", "Expired"] as const;
