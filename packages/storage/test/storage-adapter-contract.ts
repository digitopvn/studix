import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageAdapter } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { StudixError } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/index.ts";

const encoder = new TextEncoder();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StudixError);
  expect((err as StudixError).code).toBe(code);
}

/**
 * Behaviour every StorageAdapter must share. Runs against the in-memory adapter in unit tests and against
 * MinIO in integration tests, so the fake cannot drift from the real adapter.
 */
export function describeStorageAdapterContract(name: string, makeAdapter: () => StorageAdapter): void {
  describe(`${name} StorageAdapter contract`, () => {
    let adapter: StorageAdapter;
    let dir: string;
    const tenantA = testTenant();
    const tenantB = testTenant();

    beforeAll(async () => {
      adapter = makeAdapter();
      dir = await mkdtemp(join(tmpdir(), "studix-storage-test-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("puts, heads, gets and deletes bytes with a sha256", async () => {
      const bytes = encoder.encode("Xin chào Studix");
      const stored = await adapter.put(tenantA, "assets/a1/v1/hello.txt", bytes, {
        contentType: "text/plain; charset=utf-8",
        sha256: sha256Hex(bytes),
      });
      expect(stored).toEqual({
        key: "assets/a1/v1/hello.txt",
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
        contentType: "text/plain; charset=utf-8",
      });
      expect(await adapter.head(tenantA, "assets/a1/v1/hello.txt")).toMatchObject({
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      });
      const got = await adapter.get(tenantA, "assets/a1/v1/hello.txt");
      expect(await readAll(got.body)).toBe("Xin chào Studix");
      await adapter.delete(tenantA, "assets/a1/v1/hello.txt");
      expect(await adapter.head(tenantA, "assets/a1/v1/hello.txt")).toBeUndefined();
      await adapter.delete(tenantA, "assets/a1/v1/hello.txt");
    });

    it("streams a local file upload and downloads it back byte-identical", async () => {
      const source = join(dir, "render.bin");
      const payload = Buffer.alloc(256 * 1024, 7);
      await writeFile(source, payload);
      const stored = await adapter.put(
        tenantA,
        "renders/r1/preview.mp4",
        { filePath: source },
        { contentType: "video/mp4" },
      );
      expect(stored.sha256).toBe(sha256Hex(payload));
      expect(stored.bytes).toBe(payload.byteLength);
      const target = join(dir, "nested", "downloaded.bin");
      const downloaded = await adapter.download(tenantA, "renders/r1/preview.mp4", target);
      expect(downloaded).toEqual({ sha256: sha256Hex(payload), bytes: payload.byteLength });
      expect(Buffer.compare(await readFile(target), payload)).toBe(0);
    });

    it("accepts web stream bodies", async () => {
      const body = new Response("streamed body").body!;
      const stored = await adapter.put(tenantA, "tmp/stream.txt", body, { contentType: "text/plain" });
      expect(stored.sha256).toBe(sha256Hex(encoder.encode("streamed body")));
    });

    it("rejects an upload whose sha256 does not match and writes nothing", async () => {
      await expectCode(
        adapter.put(tenantA, "tmp/bad.txt", encoder.encode("abc"), {
          contentType: "text/plain",
          sha256: "0".repeat(64),
        }),
        "VALIDATION",
      );
      expect(await adapter.head(tenantA, "tmp/bad.txt")).toBeUndefined();
    });

    it("isolates tenants: the same relative key is a different object per workspace", async () => {
      await adapter.put(tenantA, "shared/key.txt", encoder.encode("A"), { contentType: "text/plain" });
      expect(await adapter.head(tenantB, "shared/key.txt")).toBeUndefined();
      await expectCode(adapter.get(tenantB, "shared/key.txt"), "NOT_FOUND");
    });

    it("rejects keys that try to escape the tenant prefix", async () => {
      for (const key of [
        "../other/key",
        "/abs/key",
        "a//b",
        "a/./b",
        `orgs/${tenantB.organizationId}/../x`,
      ]) {
        await expectCode(
          adapter.put(tenantA, key, encoder.encode("x"), { contentType: "text/plain" }),
          "VALIDATION",
        );
      }
      const forged = { ...tenantA, workspaceId: "ws/../../orgs/x" };
      await expectCode(adapter.head(forged, "a.txt"), "UNAUTHENTICATED");
    });

    it("signs GET URLs with a bounded TTL", async () => {
      await adapter.put(tenantA, "renders/r2/out.mp4", encoder.encode("mp4"), { contentType: "video/mp4" });
      const url = await adapter.signedUrl(tenantA, "renders/r2/out.mp4", {
        expiresInSeconds: 120,
        downloadName: "giới-thiệu.mp4",
      });
      expect(url).toContain(
        `orgs/${tenantA.organizationId}/workspaces/${tenantA.workspaceId}/renders/r2/out.mp4`,
      );
      await expectCode(
        adapter.signedUrl(tenantA, "renders/r2/out.mp4", { expiresInSeconds: 10_000_000 }),
        "VALIDATION",
      );
      await expectCode(
        adapter.signedUrl(tenantA, "renders/r2/out.mp4", { expiresInSeconds: 0 }),
        "VALIDATION",
      );
    });

    it("validates content types", async () => {
      await expectCode(
        adapter.put(tenantA, "tmp/x", encoder.encode("x"), { contentType: "not a mime" }),
        "VALIDATION",
      );
    });
  });
}
