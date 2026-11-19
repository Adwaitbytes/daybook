import { describe, expect, it } from "vitest";
import { groupAddress, groupedText } from "./address";

const addr = "0x9cD2d5DFfd3D1e119d04898872bbd47C38878a6e";

describe("groupAddress", () => {
  it("splits into ten 4-character groups, five per line, never breaking a group", () => {
    const g = groupAddress(addr);
    expect(g.lines[0]).toHaveLength(5);
    expect(g.lines[1]).toHaveLength(5);
    const joined = [...g.lines[0], ...g.lines[1]].map((x) => x.text).join("");
    expect(`0x${joined}`).toBe(addr);
    for (const group of [...g.lines[0], ...g.lines[1]]) expect(group.text).toHaveLength(4);
  });

  it("marks the first and last six hex characters as strong and the middle as muted", () => {
    const g = groupAddress(addr);
    const all = [...g.lines[0], ...g.lines[1]];
    expect(all[0]?.emphasis).toBe("strong");
    expect(all[1]?.parts).toEqual([
      { text: "d5", strong: true, start: 4 },
      { text: "DF", strong: false, start: 6 },
    ]);
    expect(all[4]?.emphasis).toBe("muted");
    expect(all[8]?.parts).toEqual([
      { text: "38", strong: false, start: 32 },
      { text: "87", strong: true, start: 34 },
    ]);
    expect(all[9]?.emphasis).toBe("strong");
    const strongChars = all.flatMap((x) => x.parts.filter((p) => p.strong).map((p) => p.text)).join("");
    expect(strongChars).toBe("9cD2d5878a6e");
  });

  it("keeps the checksum case", () => {
    expect(groupedText(addr)).toBe("0x 9cD2 d5DF fd3D 1e11 9d04 8988 72bb d47C 3887 8a6e");
  });

  it("rejects anything that is not a 20-byte hex address", () => {
    expect(() => groupAddress("0x1234")).toThrow();
    expect(() => groupAddress(`${addr}00`)).toThrow();
    expect(() => groupAddress("9cD2d5DFfd3D1e119d04898872bbd47C38878a6e00")).toThrow();
  });
});
