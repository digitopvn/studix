import { describe, expect, it } from "vitest";
import { idTimestamp, isId, newId } from "../src/index.ts";

describe("newId", () => {
  it("produces prefixed, validated ids", () => {
    const id = newId("prj");
    expect(id).toMatch(/^prj_[0-9a-z]{26}$/);
    expect(isId(id)).toBe(true);
    expect(isId(id, "prj")).toBe(true);
    expect(isId(id, "job")).toBe(false);
    expect(isId("prj_UPPER")).toBe(false);
  });

  it("is strictly increasing, including within one millisecond", () => {
    const ids = Array.from({ length: 500 }, () => newId("job", 1_700_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts by time and encodes the timestamp", () => {
    const earlier = newId("a", 1_000);
    const later = newId("a", Date.now() + 10_000);
    expect(earlier < later).toBe(true);
    expect(idTimestamp(newId("a", 1_800_000_000_123))).toBe(1_800_000_000_123);
  });

  it("rejects invalid prefixes", () => {
    expect(() => newId("Bad")).toThrow(TypeError);
    expect(() => newId("")).toThrow(TypeError);
  });
});
