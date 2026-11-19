/**
 * Splits an address into 4-character groups on two lines so a person can check it against their wallet.
 * The first and last six hex characters are marked so they can be emphasized: people compare the ends.
 */
export type AddressPart = { text: string; strong: boolean; start: number };
export type AddressGroup = {
  text: string;
  start: number;
  emphasis: "strong" | "muted" | "mixed";
  parts: AddressPart[];
};

export type GroupedAddress = { prefix: "0x"; lines: [AddressGroup[], AddressGroup[]]; plain: string };

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

export function groupAddress(address: string): GroupedAddress {
  if (!HEX40.test(address)) throw new Error(`not an address: ${address}`);
  const body = address.slice(2);
  const groups: AddressGroup[] = [];
  for (let i = 0; i < body.length; i += 4) {
    const parts: AddressPart[] = [];
    for (let j = i; j < Math.min(i + 4, body.length); j++) {
      const strong = j < 6 || j >= body.length - 6;
      const last = parts[parts.length - 1];
      const ch = body[j] ?? "";
      if (last !== undefined && last.strong === strong) last.text += ch;
      else parts.push({ text: ch, strong, start: j });
    }
    const allStrong = parts.every((p) => p.strong);
    const noneStrong = parts.every((p) => !p.strong);
    groups.push({
      text: body.slice(i, i + 4),
      start: i,
      emphasis: allStrong ? "strong" : noneStrong ? "muted" : "mixed",
      parts,
    });
  }
  // Ten groups: split five and five, so the break never leaves an orphan.
  return { prefix: "0x", lines: [groups.slice(0, 5), groups.slice(5)], plain: address };
}

/** The grouped address as one string, for screen readers and copy fallbacks: "0x 1a2b 3c4d …". */
export function groupedText(address: string): string {
  const g = groupAddress(address);
  return `0x ${[...g.lines[0], ...g.lines[1]].map((x) => x.text).join(" ")}`;
}
