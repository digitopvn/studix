import { describe, expect, it } from "vitest";
import { createVendorKeyTester } from "../src/platform-vendor-key-tester.ts";

function fakeFetch(status: number, calls: Array<{ url: string; headers: Record<string, string> }>) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

describe("vendor key tester", () => {
  it("looks the key up at the vendor's fixed host and reads 401 as invalid", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const test = createVendorKeyTester({ fetch: fakeFetch(401, calls) });
    await expect(test("OPENROUTER_API_KEY", "sk-or-1")).resolves.toMatchObject({
      verdict: "invalid",
      httpStatus: 401,
    });
    expect(calls).toEqual([
      { url: "https://openrouter.ai/api/v1/key", headers: { authorization: "Bearer sk-or-1" } },
    ]);
  });

  it("keeps an ElevenLabs refusal unverified: a restricted key is refused too", async () => {
    const test = createVendorKeyTester({ fetch: fakeFetch(401, []) });
    await expect(test("ELEVENLABS_API_KEY", "xi-1")).resolves.toMatchObject({ verdict: "unverified" });
    const ok = createVendorKeyTester({ fetch: fakeFetch(200, []) });
    await expect(ok("ELEVENLABS_API_KEY", "xi-1")).resolves.toMatchObject({ verdict: "available" });
  });

  it("makes no call for a vendor without a free check", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const test = createVendorKeyTester({ fetch: fakeFetch(200, calls) });
    await expect(test("SUME_API_KEY", "k")).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(test.supports?.("SUME_API_KEY")).toBe(false);
    expect(test.supports?.("REPLICATE_API_TOKEN")).toBe(true);
  });

  it("checks Cloudflare tokens and Gemini keys at their free endpoints", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const test = createVendorKeyTester({ fetch: fakeFetch(200, calls) });
    await expect(test("CLOUDFLARE_API_TOKEN", "cf-1")).resolves.toMatchObject({ verdict: "available" });
    await test("GEMINI_API_KEY", "g-1");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    ]);
    expect(calls[1]?.headers).toEqual({ "x-goog-api-key": "g-1" });
  });
});
