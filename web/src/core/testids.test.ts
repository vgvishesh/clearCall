import { describe, expect, it } from "vitest";
import { TID } from "./testids.ts";

describe("testids", () => {
  it("are unique", () => {
    const values = Object.values(TID);
    expect(new Set(values).size).toBe(values.length);
  });
});
