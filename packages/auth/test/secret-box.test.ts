import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretBox, parseSecretKey } from "../src/secret-box.ts";

describe("secret box", () => {
  const key = randomBytes(32);

  it("round-trips and never contains the plaintext", () => {
    const box = createSecretBox(key);
    const sealed = box.seal("sk-ant-api03-plaintext", "ws1/pcon1");
    expect(sealed.startsWith(`v1.${box.keyId}.`)).toBe(true);
    expect(sealed).not.toContain("plaintext");
    expect(box.open(sealed, "ws1/pcon1")).toBe("sk-ant-api03-plaintext");
  });

  it("refuses a ciphertext moved to another record or tampered with", () => {
    const box = createSecretBox(key);
    const sealed = box.seal("secret-value", "ws1/pcon1");
    expect(() => box.open(sealed, "ws2/pcon1")).toThrow(expect.objectContaining({ code: "INTERNAL" }));
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}A`;
    expect(() => box.open(tampered, "ws1/pcon1")).toThrow(expect.objectContaining({ code: "INTERNAL" }));
  });

  it("opens secrets sealed with a previous key after rotation, and nothing else", () => {
    const old = createSecretBox(key);
    const sealed = old.seal("secret-value", "aad");
    const rotated = createSecretBox(randomBytes(32), [key]);
    expect(rotated.open(sealed, "aad")).toBe("secret-value");
    expect(() => createSecretBox(randomBytes(32)).open(sealed, "aad")).toThrow(
      expect.objectContaining({ code: "INTERNAL" }),
    );
  });

  it("accepts only 32-byte keys", () => {
    expect(parseSecretKey(key.toString("base64"))).toHaveLength(32);
    expect(() => parseSecretKey("c2hvcnQ=")).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });
});
