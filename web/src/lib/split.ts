/** The till's split, mirrored from DaybookLib.split: each share floors, the treasury takes the rest and the dust. */
export const BPS = 10_000n;

export type Split = { tax: bigint; team: bigint[]; treasury: bigint };

export function split(amount: bigint, taxBps: number, teamBps: readonly number[], excess = 0n): Split {
  if (amount < 0n || excess < 0n) throw new RangeError("amounts are unsigned");
  const total = teamBps.reduce((a, b) => a + b, taxBps);
  if (total > 10_000) throw new RangeError("tax plus team is over 100%");
  const tax = (amount * BigInt(taxBps)) / BPS;
  const team = teamBps.map((b) => (amount * BigInt(b)) / BPS);
  const spent = team.reduce((a, b) => a + b, tax);
  return { tax, team, treasury: amount - spent + excess };
}
