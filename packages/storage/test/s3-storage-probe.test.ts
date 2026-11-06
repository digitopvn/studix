import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { testTenant } from "@studix/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStorageWriteCheck, S3StorageAdapter } from "../src/index.ts";

const ACCESS_DENIED = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`;

const servers: Server[] = [];
const adapters: S3StorageAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) a.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)).then(() => undefined)));
});

/** A real local HTTP endpoint standing in for the object store; `handler` decides the status per method. */
async function adapterAgainst(
  handler: (method: string) => number,
  getBody = "studix storage probe",
): Promise<{ adapter: S3StorageAdapter; methods: string[] }> {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    methods.push(req.method ?? "");
    req.resume();
    req.on("end", () => {
      const status = handler(req.method ?? "");
      res.writeHead(status, status >= 400 ? { "content-type": "application/xml" } : {});
      if (status >= 400) res.end(req.method === "HEAD" ? "" : ACCESS_DENIED);
      else res.end(req.method === "GET" ? getBody : "");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const adapter = new S3StorageAdapter({
    bucket: "test-bucket",
    region: "auto",
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIATESTONLY", secretAccessKey: "test-secret-not-real" },
  });
  adapters.push(adapter);
  return { adapter, methods };
}

describe("S3StorageAdapter.probeWrite", () => {
  it("passes when put, get, head and delete succeed", async () => {
    const { adapter, methods } = await adapterAgainst((m) => (m === "DELETE" ? 204 : 200));
    expect(await adapter.probeWrite()).toEqual({ ok: true });
    expect(methods).toEqual(["PUT", "GET", "HEAD", "DELETE"]);
  });

  it("reports a 403 on put as a definitive refusal without leaking credentials", async () => {
    const { adapter } = await adapterAgainst(() => 403);
    const result = await adapter.probeWrite();
    expect(result).toMatchObject({
      ok: false,
      step: "put",
      status: 403,
      s3Code: "AccessDenied",
      denied: true,
    });
    expect(JSON.stringify(result)).not.toContain("test-secret-not-real");
  });

  it("treats a server error as transient, not denied", async () => {
    const { adapter } = await adapterAgainst(() => 503);
    expect(await adapter.probeWrite()).toMatchObject({ ok: false, step: "put", denied: false });
  });

  it("names get when the object cannot be read back", async () => {
    const { adapter } = await adapterAgainst((m) => (m === "GET" ? 403 : 200));
    expect(await adapter.probeWrite()).toMatchObject({ ok: false, step: "get", status: 403, denied: true });
  });

  it("fails at get when the bytes read back differ from what was written", async () => {
    const { adapter } = await adapterAgainst(() => 200, "something else");
    expect(await adapter.probeWrite()).toMatchObject({ ok: false, step: "get" });
  });

  it("names the failing step when only delete is refused", async () => {
    const { adapter } = await adapterAgainst((m) => (m === "DELETE" ? 403 : 200));
    expect(await adapter.probeWrite()).toMatchObject({ ok: false, step: "delete", status: 403 });
  });
});

describe("S3StorageAdapter.put error", () => {
  it("carries the S3 code and an actionable hint on 403", async () => {
    const { adapter } = await adapterAgainst(() => 403);
    const err = await adapter
      .put(testTenant(), "renders/x/final.mp4", new Uint8Array([1, 2, 3]), { contentType: "video/mp4" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "UNAVAILABLE",
      retryable: false,
      details: { action: "put", status: 403, s3Code: "AccessDenied" },
    });
    expect((err as { suggestedAction: string }).suggestedAction).toContain("S3_ACCESS_KEY_ID");
  });
});

describe("createStorageWriteCheck", () => {
  it("caches a healthy result and re-probes a failure after the shorter ttl", async () => {
    let calls = 0;
    let healthy = false;
    let now = 0;
    const check = createStorageWriteCheck(
      {
        probeWrite: async () => {
          calls += 1;
          return healthy ? { ok: true } : { ok: false, step: "put", status: 403, denied: true };
        },
      },
      { ttlMs: 60_000, failureTtlMs: 10_000, now: () => now },
    );
    expect((await check()).ok).toBe(false);
    expect((await check()).ok).toBe(false);
    expect(calls).toBe(1);
    healthy = true;
    now = 10_001;
    expect((await check()).ok).toBe(true);
    now = 20_000;
    await check();
    expect(calls).toBe(2);
  });
});
