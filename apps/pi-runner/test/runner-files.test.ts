import { chmod } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRunner } from "./runner-test-client.ts";

type Client = Awaited<ReturnType<typeof startTestRunner>>;

describe("pi-runner file routes", () => {
  let client: Client;
  let id: string;

  beforeAll(async () => {
    client = await startTestRunner({ maxFileMb: 1 / 1024 });
    id = await client.openId();
  });
  afterAll(async () => {
    await client.close(id);
    await client.stop();
  });

  it("round-trips a file into a new directory", async () => {
    const path = `${client.work}/in/deep/a.txt`;
    expect((await client.putFile(id, path, "hello")).status).toBe(200);
    const res = await client.getFile(id, path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("5");
    expect(await res.text()).toBe("hello");
    expect((await client.getFile(id, `${client.work}/in/missing`)).status).toBe(404);
  });

  it.skipIf(process.getuid?.() === 0)(
    "answers an unreadable file with an error status, not a cut-off 200",
    async () => {
      const path = `${client.work}/locked.txt`;
      expect((await client.putFile(id, path, "secret")).status).toBe(200);
      await chmod(path, 0o000);
      expect((await client.getFile(id, path)).status).toBe(403);
      await chmod(path, 0o600);
    },
  );

  it("refuses paths outside the roots, unnormalized paths and symlink escapes", async () => {
    expect((await client.getFile(id, "/etc/hosts")).status).toBe(403);
    expect((await client.putFile(id, `${client.base}/outside.txt`, "x")).status).toBe(403);
    expect((await client.getFile(id, `${client.work}/../outside.txt`)).status).toBe(400);
    expect((await client.getFile(id, "relative.txt")).status).toBe(400);
    await client.exec(id, { command: "ln -s /etc/hosts link && ln -s /etc linkdir" });
    expect((await client.getFile(id, `${client.work}/link`)).status).toBe(403);
    expect((await client.putFile(id, `${client.work}/linkdir/evil`, "x")).status).toBe(403);
  });

  it("rejects a file past the size cap, declared or streamed", async () => {
    const big = new Uint8Array(4096);
    expect((await client.putFile(id, `${client.work}/big.bin`, big)).status).toBe(413);
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const res = await fetch(
      `${client.url}/v1/sessions/${id}/file?path=${encodeURIComponent(`${client.work}/s.bin`)}`,
      {
        method: "PUT",
        headers: client.auth,
        body: streamed,
        duplex: "half",
      } as RequestInit,
    );
    expect(res.status).toBe(413);
    const listing = await client.exec(id, { command: "ls -A" });
    expect(listing.stdout).not.toMatch(/big\.bin|s\.bin/);
  });
});
