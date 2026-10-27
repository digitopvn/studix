import { afterEach, describe, expect, it } from "vitest";
import { clearRegisteredSecrets, REDACTED, redact, redactDeep, registerSecret } from "../src/index.ts";

afterEach(() => clearRegisteredSecrets());

describe("redact", () => {
  it("scrubs well-known credential shapes", () => {
    const text = [
      "sent Bearer abcdefghijklmnop",
      "key stx_live_abcdefghijklmnopqrstuvwx",
      "or sk-or-v1-abcdefghijklmnopqrstuv",
      "db postgres://studix:hunter22@db:5432/studix",
      "url https://bucket.s3/x.mp4?X-Amz-Signature=deadbeef&X-Amz-Expires=60",
      'json {"api_key": "plain-value"}',
    ].join("\n");
    const out = redact(text);
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("stx_live_abcdefghijklmnopqrstuvwx");
    expect(out).not.toContain("hunter22");
    expect(out).not.toContain("deadbeef");
    expect(out).not.toContain("plain-value");
    expect(out).toContain("Bearer [redacted]");
    expect(out).toContain("postgres://studix:[redacted]@db:5432/studix");
    expect(out).toContain("X-Amz-Expires=60");
  });

  it("scrubs registered literal secrets", () => {
    registerSecret("my-very-own-secret");
    expect(redact("value=my-very-own-secret!")).toBe(`value=${REDACTED}!`);
  });
});

describe("redactDeep", () => {
  it("drops secret fields and headers without mutating the input", () => {
    const input = {
      apiKey: "abc12345",
      nested: { password: "x", clientSecret: "y", note: "Bearer abcdefghijkl" },
      headers: { Authorization: "Basic abcdefgh", accept: "json" },
      list: ["ok", { accessToken: "t" }],
      count: 3,
      inputTokens: 120,
    };
    const out = redactDeep(input);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.nested).toEqual({ password: REDACTED, clientSecret: REDACTED, note: "Bearer [redacted]" });
    expect(out.headers).toEqual({ Authorization: REDACTED, accept: "json" });
    expect(out.list).toEqual(["ok", { accessToken: REDACTED }]);
    expect(out.count).toBe(3);
    expect(out.inputTokens).toBe(120);
    expect(input.apiKey).toBe("abc12345");
  });

  it("handles cycles and errors", () => {
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic.self = cyclic;
    expect(redactDeep(cyclic)).toEqual({ name: "a", self: "[circular]" });
    const err = redactDeep(new Error("token=abc123"));
    expect(err).toMatchObject({ name: "Error", message: "token=[redacted]" });
  });
});
