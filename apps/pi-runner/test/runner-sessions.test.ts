import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createFrameDecoder,
  FRAME_STDOUT,
} from "../../../packages/agent-runtime/src/sandbox-runner-protocol.ts";
import { createRunner } from "../src/runner-server.ts";
import { isAlive, startTestRunner, TOKEN, waitFor } from "./runner-test-client.ts";

type Client = Awaited<ReturnType<typeof startTestRunner>>;

describe("pi-runner sessions and exec", () => {
  let client: Client;
  let sessionId: string | null = null;

  beforeAll(async () => {
    client = await startTestRunner();
  });
  afterEach(async () => {
    if (sessionId) await client.close(sessionId);
    sessionId = null;
  });
  afterAll(async () => {
    await client.stop();
  });

  it("refuses a short token at creation", () => {
    expect(() => createRunner({ token: "short" })).toThrow(/at least 32/);
  });

  it("keeps /healthz open and every other route behind the bearer token", async () => {
    const health = await fetch(`${client.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect((await fetch(`${client.url}/v1/info`)).status).toBe(401);
    const wrong = await fetch(`${client.url}/v1/info`, {
      headers: { authorization: `Bearer ${"x".repeat(40)}` },
    });
    expect(wrong.status).toBe(401);
    expect((await fetch(`${client.url}/v1/sessions`, { method: "POST" })).status).toBe(401);
    const info = await fetch(`${client.url}/v1/info`, { headers: client.auth });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ protocol: 1, version: "dev", busy: false });
  });

  it("serves one session at a time and is free again after close", async () => {
    sessionId = await client.openId();
    expect((await client.open()).status).toBe(409);
    expect((await client.close(sessionId)).status).toBe(204);
    expect((await client.exec(sessionId, { command: "true" })).status).toBe(410);
    sessionId = await client.openId();
  });

  it("streams stdout and stderr, feeds stdin and reports the exit code", async () => {
    sessionId = await client.openId({ TASK_KEY: "vendor" });
    const result = await client.exec(
      sessionId,
      { command: 'cat; echo "$TASK_KEY"; echo oops >&2; exit 3' },
      "hi\n",
    );
    expect(result).toMatchObject({ status: 200, stdout: "hi\nvendor\n", stderr: "oops\n" });
    expect(result.exit).toEqual({ exitCode: 3, signal: null, timedOut: false });
    const argv = await client.exec(sessionId, {
      argv: ["printf", "%s|", "a b", "c"],
      cwd: `${client.work}/out`,
    });
    expect(argv.stdout).toBe("a b|c|");
    expect((await client.exec(sessionId, { command: "pwd", cwd: "/etc" })).status).toBe(403);
  });

  it("never hands the runner token to a command", async () => {
    sessionId = await client.openId();
    const { stdout } = await client.exec(sessionId, { command: "env" });
    expect(stdout).not.toContain(TOKEN);
    expect(stdout).not.toContain("STUDIX_RUNNER_TOKEN");
    expect(stdout).toContain(`HOME=${client.work}/.home`);
  });

  it("kills the process group on timeout", async () => {
    sessionId = await client.openId();
    const result = await client.exec(sessionId, { command: "sleep 30", timeoutSeconds: 0.3 });
    expect(result.exit).toEqual({ exitCode: null, signal: "SIGKILL", timedOut: true });
  });

  it("kills a grandchild when the worker aborts the request", async () => {
    sessionId = await client.openId();
    const abort = new AbortController();
    const res = await client.execResponse(
      sessionId,
      { command: "sleep 30 & echo $!; wait" },
      undefined,
      abort.signal,
    );
    const reader = res.body!.getReader();
    let pid = 0;
    const decode = createFrameDecoder((type, payload) => {
      if (type === FRAME_STDOUT) pid = Number(new TextDecoder().decode(payload).trim());
    });
    while (!pid) {
      const { value, done } = await reader.read();
      if (done) break;
      decode(value);
    }
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(true);
    abort.abort();
    await waitFor(() => !isAlive(pid));
  });

  it("wipes work and scratch paths between sessions", async () => {
    sessionId = await client.openId();
    expect((await client.putFile(sessionId, `${client.work}/keep.txt`, "secret")).status).toBe(200);
    await client.exec(sessionId, { argv: ["sh", "-c", 'echo x > "$1/left"', "sh", client.scratch] });
    await client.close(sessionId);
    sessionId = await client.openId();
    expect((await client.getFile(sessionId, `${client.work}/keep.txt`)).status).toBe(404);
    const listing = await client.exec(sessionId, { argv: ["ls", "-A", client.scratch] });
    expect(listing.stdout).toBe("");
    const dirs = await client.exec(sessionId, { command: "ls -A" });
    expect(dirs.stdout.split("\n").filter(Boolean).sort()).toEqual([".home", "in", "out"]);
  });
});

describe("pi-runner disk cap", () => {
  it("closes a session that writes past the cap and answers 410 with the reason", async () => {
    const client = await startTestRunner({ maxDiskMb: 0.5, diskCheckMs: 100 });
    try {
      const id = await client.openId();
      await client.exec(id, { command: "head -c 2097152 /dev/zero > out/big" });
      await waitFor(async () => (await client.exec(id, { command: "true" })).status === 410);
      const res = await client.getFile(id, `${client.work}/out/big`);
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: "session closed: disk cap" });
    } finally {
      await client.stop();
    }
  });
});
