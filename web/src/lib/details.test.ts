import { describe, expect, it } from "vitest";
import { detailsHashOf } from "./details";

describe("detailsHashOf", () => {
  it("is stable for the same details and changes with any field", () => {
    const a = { clientName: "Demo client", notes: null, pdfSha256: null };
    expect(detailsHashOf(a)).toBe(detailsHashOf({ ...a }));
    expect(detailsHashOf(a)).not.toBe(detailsHashOf({ ...a, notes: "" }));
    expect(detailsHashOf(a)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
