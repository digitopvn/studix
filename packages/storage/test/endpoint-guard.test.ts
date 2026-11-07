import { describe, expect, it } from "vitest";
import { assertSafeStorageEndpoint, blockedAddressReason } from "../src/index.ts";

const strict = { allowLocal: false };
const local = { allowLocal: true };
const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses;

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return (err as { details?: { reason?: string } } | undefined)?.details?.reason;
}

describe("storage endpoint guard", () => {
  it("accepts a public R2 endpoint", async () => {
    const checked = await assertSafeStorageEndpoint(
      "https://acct.r2.cloudflarestorage.com/",
      "cloudflare-r2",
      strict,
      resolvesTo("104.18.0.1"),
    );
    expect(checked.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
  });

  it("requires https unless local endpoints are allowed", async () => {
    expect(
      await reasonOf(
        assertSafeStorageEndpoint(
          "http://s3.example.com",
          "s3-compatible",
          strict,
          resolvesTo("93.184.216.34"),
        ),
      ),
    ).toBe("scheme");
    await expect(
      assertSafeStorageEndpoint("http://localhost:9000", "s3-compatible", local, resolvesTo("127.0.0.1")),
    ).resolves.toBeTruthy();
  });

  it.each([
    ["private IP literal", "https://10.0.0.5"],
    ["metadata IP literal", "https://169.254.169.254"],
    ["IPv6 loopback", "https://[::1]"],
    ["mapped IPv4", "https://[::ffff:10.0.0.1]"],
  ])("refuses a %s", async (_label, url) => {
    expect(await reasonOf(assertSafeStorageEndpoint(url, "s3-compatible", strict, resolvesTo()))).toBe("ip");
  });

  it("refuses a hostname that resolves to a private or metadata address (rebinding style)", async () => {
    for (const address of [
      "10.1.2.3",
      "169.254.169.254",
      "127.0.0.1",
      "::ffff:192.168.1.1",
      "fd00:ec2::254",
    ]) {
      expect(
        await reasonOf(
          assertSafeStorageEndpoint(
            "https://evil.example.com",
            "s3-compatible",
            strict,
            resolvesTo("93.184.216.34", address),
          ),
        ),
      ).toBe("resolves_private");
    }
  });

  it("refuses internal names, credentials, paths and non-R2 hosts for R2", async () => {
    const r = resolvesTo("93.184.216.34");
    expect(await reasonOf(assertSafeStorageEndpoint("https://localhost", "s3-compatible", strict, r))).toBe(
      "internal_host",
    );
    expect(
      await reasonOf(assertSafeStorageEndpoint("https://s3.corp.internal", "s3-compatible", strict, r)),
    ).toBe("internal_host");
    expect(
      await reasonOf(assertSafeStorageEndpoint("https://u:p@s3.example.com", "s3-compatible", strict, r)),
    ).toBe("userinfo");
    expect(
      await reasonOf(assertSafeStorageEndpoint("https://s3.example.com/x?y", "s3-compatible", strict, r)),
    ).toBe("path");
    expect(
      await reasonOf(
        assertSafeStorageEndpoint("https://r2.cloudflarestorage.com.evil.com", "cloudflare-r2", strict, r),
      ),
    ).toBe("r2_host");
  });

  it("keeps metadata addresses blocked even when local endpoints are allowed", () => {
    expect(blockedAddressReason("169.254.169.254", local)).toBeDefined();
    expect(blockedAddressReason("100.100.100.200", local)).toBeDefined();
    expect(blockedAddressReason("127.0.0.1", local)).toBeUndefined();
    expect(blockedAddressReason("127.0.0.1", strict)).toBeDefined();
  });
});
