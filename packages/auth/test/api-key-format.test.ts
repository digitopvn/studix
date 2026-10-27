import { describe, expect, it } from "vitest";
import {
  generateApiKey,
  hashApiKey,
  hashesEqual,
  isApiKeyFormat,
  parseBearerToken,
} from "../src/api-key-format.ts";

describe("api key format", () => {
  it("generates stx_<env>_<43 base64url chars> with a sha256 hash and a short prefix", () => {
    const { key, hash, prefix } = generateApiKey("dev");
    expect(key).toMatch(/^stx_dev_[A-Za-z0-9_-]{43}$/);
    expect(isApiKeyFormat(key)).toBe(true);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBe("stx_dev_".length + 6);
  });

  it("never repeats keys", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey("live").key));
    expect(keys.size).toBe(200);
  });

  it("rejects invalid env tags", () => {
    expect(() => generateApiKey("PROD")).toThrow(RangeError);
    expect(() => generateApiKey("a")).toThrow(RangeError);
  });

  it("recognizes only well-formed keys", () => {
    expect(isApiKeyFormat("stx_dev_short")).toBe(false);
    expect(isApiKeyFormat(`sk_dev_${"a".repeat(43)}`)).toBe(false);
    expect(isApiKeyFormat(`stx_dev_${"a".repeat(43)}x`)).toBe(false);
  });

  it("parses bearer headers", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer  abc ")).toBe("abc");
    expect(parseBearerToken(["Bearer first", "Bearer second"])).toBe("first");
    expect(parseBearerToken("Basic abc")).toBeUndefined();
    expect(parseBearerToken("Bearer")).toBeUndefined();
    expect(parseBearerToken("Bearer a b")).toBeUndefined();
    expect(parseBearerToken(undefined)).toBeUndefined();
  });

  it("compares digests in constant time and only for equal lengths", () => {
    const a = hashApiKey("a");
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, hashApiKey("b"))).toBe(false);
    expect(hashesEqual(a, a.slice(0, 10))).toBe(false);
    expect(hashesEqual("", "")).toBe(false);
  });
});
