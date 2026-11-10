import { describe, expect, it } from "vitest";
import { storableJson, storableText } from "../src/json-safe.ts";

const R = String.fromCharCode(0xfffd);

describe("storable text", () => {
  it("replaces NUL and unpaired surrogates and keeps whole emoji", () => {
    expect(storableText("a\u0000b")).toBe(`a${R}b`);
    expect(storableText("cut \uD83D")).toBe(`cut ${R}`);
    expect(storableText("\uDE00 tail")).toBe(`${R} tail`);
    expect(storableText("ok 😀 tiếng Việt")).toBe("ok 😀 tiếng Việt");
  });

  it("cleans nested values and keys, and keeps dates", () => {
    const at = new Date(0);
    expect(storableJson({ "k\u0000": ["x\uD83D", { at, n: 1, ok: true, none: null }] })).toEqual({
      [`k${R}`]: [`x${R}`, { at, n: 1, ok: true, none: null }],
    });
    expect(storableJson({ at }).at).toBe(at);
  });
});
