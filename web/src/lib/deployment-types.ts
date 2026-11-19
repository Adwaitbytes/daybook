/** One network's Daybook deployment as published in contracts/deployments or docs/DEPLOYMENTS.md. */
export type DeploymentRecord = {
  /** DaybookReactive on that Reactive network. Factory and tills are read from it on chain. */
  reactive: `0x${string}`;
  /** Block the reactive contract was deployed in, when the record has it. */
  deployBlock: string | null;
  /** File the address came from. */
  source: string;
};
