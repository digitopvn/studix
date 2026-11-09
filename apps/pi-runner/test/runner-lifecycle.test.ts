/* Runner behaviour the worker and the kubelet depend on beyond plain exec: probes, reclaiming, aborts, streaming. */
import { describe, expect, it } from "vitest";
import { RUNNER_ROUTES } from "../../../packages/agent-runtime/src/sandbox-runner-protocol.ts";
import { startTestRunner, waitFor } from "./runner-test-client.ts";

describe("pi-runner lifecycle", () => {
  it("serves /healthz alone on the probe listener", async () => {
    const client = await startTestRunner({ health: { port: 0, host: "127.0.0.1" } });
    try {
      const probe = `http://127.0.0.1:${client.healthPort}`;
      const health = await fetch(`${probe}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      // Even with the token, the probe listener exposes no API route.
      const info = await fetch(`${probe}/v1/info`, { headers: client.auth });
      expect(info.status).toBe(404);
    } finally {
      await client.stop();
    }
  });

  it("closes a session by task id and on reset, leaving other tasks' sessions alone", async () => {
    const client = await startTestRunner();
    try {
      const first = await client.openId();
      expect((await client.post(`${RUNNER_ROUTES.sessionsByTask("other-task")}`, "DELETE")).status).toBe(204);
      expect((await client.exec(first, { command: "true" })).status).toBe(200);
      expect((await client.post(`${RUNNER_ROUTES.sessionsByTask("task-1")}`, "DELETE")).status).toBe(204);
      const gone = await client.exec(first, { command: "true" });
      expect(gone.status).toBe(410);
      expect(gone.stderr).toContain("abandoned by worker");

      const second = await client.openId();
      expect((await client.post(RUNNER_ROUTES.reset)).status).toBe(204);
      expect((await client.exec(second, { command: "true" })).status).toBe(410);
      expect((await client.open()).status).toBe(201);
      expect((await client.post(RUNNER_ROUTES.sessionsByTask("x"), "DELETE")).status).toBe(204);
      expect((await client.post(RUNNER_ROUTES.reset)).status).toBe(204);
      expect((await client.post(RUNNER_ROUTES.reset.replace("reset", "nope"))).status).toBe(404);
      expect((await fetch(`${client.url}${RUNNER_ROUTES.reset}`, { method: "POST" })).status).toBe(401);
    } finally {
      await client.stop();
    }
  });

  it("aborts an upload still streaming when the session closes, and wipes it", async () => {
    const client = await startTestRunner();
    try {
      const id = await client.openId();
      let push: ((chunk: Uint8Array) => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (chunk) => controller.enqueue(chunk);
        },
      });
      const upload = fetch(
        `${client.url}${RUNNER_ROUTES.file(id)}?path=${encodeURIComponent(`${client.work}/slow.bin`)}`,
        {
          method: "PUT",
          headers: client.auth,
          body,
          duplex: "half",
        } as RequestInit,
      ).catch((error: unknown) => error);
      push?.(new Uint8Array(1024));
      await waitFor(() => client.runner.sessions.busy);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const closing = client.close(id);
      expect((await closing).status).toBe(204);
      const result = await upload;
      // The upload never succeeded: either the socket was cut or the runner answered with an error.
      if (result instanceof Response) expect(result.status).not.toBe(200);
      const next = await client.openId();
      const listing = await client.exec(next, { command: "ls -A" });
      expect(listing.stdout.split("\n").filter(Boolean).sort()).toEqual([".home", ".tmp", "in", "out"]);
    } finally {
      await client.stop();
    }
  });

  it("sends the response headers before a silent command prints anything", async () => {
    const client = await startTestRunner();
    try {
      const id = await client.openId();
      const started = Date.now();
      const res = await client.execResponse(id, { command: "sleep 2; echo done" });
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(1_500);
      await res.arrayBuffer();
    } finally {
      await client.stop();
    }
  });

  it("accepts a huge timeout without firing it at once", async () => {
    const client = await startTestRunner();
    try {
      const id = await client.openId();
      const result = await client.exec(id, { command: "sleep 0.3; echo ok", timeoutSeconds: 1e9 });
      expect(result.exit).toEqual({ exitCode: 0, signal: null, timedOut: false });
      expect(result.stdout).toBe("ok\n");
    } finally {
      await client.stop();
    }
  });

  it("closes a session past a single path's cap and points TMPDIR into the work dir", async () => {
    const capped = await startTestRunner({ diskCheckMs: 100, maxDiskMb: 100 });
    try {
      const stopped = await startTestRunner({
        diskCheckMs: 100,
        pathCapsMb: [{ path: capped.scratch, maxMb: 0.5 }],
      });
      try {
        const id = await stopped.openId();
        const env = await stopped.exec(id, { command: 'echo "$TMPDIR"; test -d "$TMPDIR" && echo exists' });
        expect(env.stdout).toBe(`${stopped.work}/.tmp\nexists\n`);
        await stopped.exec(id, {
          argv: ["sh", "-c", 'head -c 1048576 /dev/zero > "$1/big"', "sh", capped.scratch],
        });
        await waitFor(async () => (await stopped.exec(id, { command: "true" })).status === 410);
        const gone = await stopped.exec(id, { command: "true" });
        expect(gone.stderr).toContain(`disk cap of ${capped.scratch}`);
      } finally {
        await stopped.stop();
      }
    } finally {
      await capped.stop();
    }
  });

  it("answers 410, never 404, for a session the runner does not know", async () => {
    const client = await startTestRunner();
    try {
      expect((await client.exec("unknown", { command: "true" })).status).toBe(410);
      expect((await client.getFile("unknown", `${client.work}/x`)).status).toBe(410);
    } finally {
      await client.stop();
    }
  });
});
