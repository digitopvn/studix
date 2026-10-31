import { describe, expect, it } from "vitest";
import { anthropicKeyHint, createAnthropicKeyTester } from "../src/anthropic-key-tester.ts";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-1234";

function fakeFetch(status: number | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (status instanceof Error) throw status;
    return new Response("{}", { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("anthropic key tester", () => {
  it("calls the zero-token models endpoint with the key only in x-api-key", async () => {
    const { fetch, calls } = fakeFetch(200);
    const result = await createAnthropicKeyTester({ fetch, baseUrl: "https://api.example.test/" }).test(KEY);
    expect(result).toMatchObject({ ok: true, verdict: "available", httpStatus: 200 });
    expect(calls[0]!.url).toBe("https://api.example.test/v1/models?limit=1");
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
  });

  it.each([
    [401, "invalid", "UNAUTHENTICATED"],
    [403, "invalid", "FORBIDDEN"],
    [429, "unverified", "RATE_LIMITED"],
    [529, "unverified", "UNAVAILABLE"],
  ] as const)("maps HTTP %i to %s / %s without echoing the key", async (status, verdict, code) => {
    const result = await createAnthropicKeyTester({ fetch: fakeFetch(status).fetch }).test(KEY);
    expect(result).toMatchObject({ ok: false, verdict, httpStatus: status, error: { code } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("reports a network failure as unverified", async () => {
    const result = await createAnthropicKeyTester({ fetch: fakeFetch(new Error(`boom ${KEY}`)).fetch }).test(
      KEY,
    );
    expect(result).toMatchObject({ ok: false, verdict: "unverified", error: { code: "UNAVAILABLE" } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("hints with the last four characters only", () => {
    expect(anthropicKeyHint(KEY)).toBe("sk-ant-…1234");
  });
});
