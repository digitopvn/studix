import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@studix/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createSidecarSandboxDriver, type SandboxSession } from "../src/index.ts";
import {
  decodeExecHeader,
  encodeFrame,
  FRAME_EXIT,
  FRAME_STDERR,
  FRAME_STDOUT,
  RUNNER_EXEC_HEADER,
  RUNNER_PROTOCOL_VERSION,
} from "../src/sandbox-runner-protocol.ts";
import { syncSkillsFromRunner } from "../src/sandbox-sidecar-files.ts";

const TOKEN = "t".repeat(40);
const limits = { cpus: 1, memoryMb: 512, pids: 64, wallTimeMs: 60_000 };

/** A minimal pi-runner: one session at a time, files in memory, `command` run by the local sh. */
async function fakeRunner(
  options: {
    /** Held by another task of this worker: a reset does not free it. */
    busy?: boolean;
    /** Left by a previous worker process: a reset frees it. */
    orphan?: boolean;
    protocol?: number;
    /** Answer exec and file calls with 410, as when the runner closed the session itself. */
    gone?: boolean;
    /** Never answer the open request (the worker gives up on it). */
    hangOpen?: boolean;
  } = {},
) {
  const files = new Map<string, Buffer>();
  const seen = {
    auth: [] as string[],
    deletes: 0,
    resets: 0,
    abandoned: [] as string[],
    opens: [] as unknown[],
    argv: [] as string[][],
  };
  let session: string | undefined = options.busy ? "other" : options.orphan ? "orphan" : undefined;
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };
  const server: Server = createServer(async (req, res) => {
    seen.auth.push(String(req.headers.authorization));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/v1/info") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({
          protocol: options.protocol ?? RUNNER_PROTOCOL_VERSION,
          version: "test",
          busy: !!session,
          toolchain: {},
          startedAt: "",
        }),
      );
    }
    if (url.pathname === "/v1/reset" && req.method === "POST") {
      seen.resets++;
      if (session === "orphan" || session === "s1") session = undefined;
      return void res.writeHead(204).end();
    }
    if (url.pathname === "/v1/sessions" && req.method === "DELETE") {
      seen.abandoned.push(url.searchParams.get("taskId") ?? "");
      return void res.writeHead(204).end();
    }
    if (url.pathname === "/v1/sessions" && req.method === "POST") {
      seen.opens.push(JSON.parse((await body(req)).toString("utf8")));
      if (options.hangOpen) return;
      if (session) return void res.writeHead(409).end();
      session = "s1";
      res.writeHead(201, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ sessionId: session }));
    }
    if (url.pathname === "/v1/sessions/s1" && req.method === "DELETE") {
      seen.deletes++;
      session = undefined;
      return void res.writeHead(204).end();
    }
    if (options.gone && url.pathname.startsWith("/v1/sessions/s1/")) {
      await body(req);
      res.writeHead(410, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "session closed: disk cap" }));
    }
    if (url.pathname === "/v1/sessions/s1/file") {
      const path = url.searchParams.get("path") ?? "";
      if (req.method === "PUT") {
        files.set(path, await body(req));
        return void res.writeHead(204).end();
      }
      const file = files.get(path);
      if (!file) return void res.writeHead(404).end();
      return void res.writeHead(200).end(file);
    }
    if (url.pathname === "/v1/sessions/s1/exec") {
      const exec = decodeExecHeader(String(req.headers[RUNNER_EXEC_HEADER]));
      const stdin = await body(req);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const exit = (code: number) =>
        res.end(
          encodeFrame(
            FRAME_EXIT,
            Buffer.from(JSON.stringify({ exitCode: code, signal: null, timedOut: false })),
          ),
        );
      if (exec.argv) {
        seen.argv.push(exec.argv);
        if (exec.argv[0] === "fail") {
          res.write(encodeFrame(FRAME_STDERR, Buffer.from("bad thing\n")));
          return void exit(2);
        }
        if (exec.argv[0] === "echo")
          res.write(encodeFrame(FRAME_STDOUT, Buffer.from(exec.argv.slice(1).join(" "))));
        return void exit(0);
      }
      const child = spawn("sh", ["-c", exec.command ?? ""]);
      child.stdout.on("data", (c: Buffer) => res.write(encodeFrame(FRAME_STDOUT, c)));
      child.stderr.on("data", (c: Buffer) => res.write(encodeFrame(FRAME_STDERR, c)));
      child.on("close", (code) => exit(code ?? 1));
      child.stdin.end(stdin);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, files, seen };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

function recordingLogger(lines: string[]): Logger {
  const logger: Logger = {
    debug: (m, f) => lines.push(m + JSON.stringify(f ?? {})),
    info: (m, f) => lines.push(m + JSON.stringify(f ?? {})),
    warn: (m, f) => lines.push(m + JSON.stringify(f ?? {})),
    error: (m, f) => lines.push(m + JSON.stringify(f ?? {})),
    child: () => logger,
  };
  return logger;
}

const open = (
  urls: string[],
  extra: { signal?: AbortSignal; acquireTimeoutMs?: number; logs?: string[]; skillsDir?: string } = {},
) =>
  createSidecarSandboxDriver({
    runners: urls.map((url) => ({ url, token: TOKEN })),
    ...(extra.acquireTimeoutMs ? { acquireTimeoutMs: extra.acquireTimeoutMs } : {}),
    ...(extra.logs ? { logger: recordingLogger(extra.logs) } : {}),
  }).open({
    taskId: "task-1",
    env: { ELEVENLABS_API_KEY: "secret-key" },
    limits,
    signal: extra.signal ?? new AbortController().signal,
    ...(extra.skillsDir ? { skillsDir: extra.skillsDir } : {}),
  });

describe("sidecar sandbox driver", () => {
  it("opens on the first free runner, skipping a busy one, with a bearer token it never logs", async () => {
    const busy = await fakeRunner({ busy: true });
    const free = await fakeRunner();
    const logs: string[] = [];
    const session = await open([busy.url, free.url], { logs });
    expect(session.id).toBe("sidecar-2/s1");
    expect(free.seen.auth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    expect(free.seen.opens[0]).toEqual({
      taskId: "task-1",
      env: { ELEVENLABS_API_KEY: "secret-key" },
      limits: { pids: 64, wallTimeMs: 60_000 },
    });
    await session.close();
    expect(logs.some((l) => l.includes("closed") && l.includes('"runner":2'))).toBe(true);
    expect(logs.join("\n")).not.toMatch(new RegExp(`${TOKEN}|secret-key`));
  });

  it("waits while every runner is busy, then fails UNAVAILABLE retryable", async () => {
    const a = await fakeRunner({ busy: true });
    const b = await fakeRunner({ busy: true });
    const started = Date.now();
    await expect(open([a.url, b.url], { acquireTimeoutMs: 600 })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      message: expect.stringContaining("All 2 skill runners are busy"),
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await expect(open([a.url], { signal: abort.signal })).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("reclaims a session a previous worker left on its runner, once per runner", async () => {
    const runner = await fakeRunner({ orphan: true });
    const driver = createSidecarSandboxDriver({ runners: [{ url: runner.url, token: TOKEN }] });
    const request = { taskId: "task-1", env: {}, limits, signal: new AbortController().signal };
    const first = await driver.open(request);
    await first.close();
    const second = await driver.open(request);
    expect(runner.seen.resets).toBe(1);
    await second.close();
  });

  it("frees the runner for the task when the worker gives up on an open", async () => {
    const runner = await fakeRunner({ hangOpen: true });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    await expect(open([runner.url], { signal: abort.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    await new Promise((r) => setTimeout(r, 100));
    expect(runner.seen.abandoned).toEqual(["task-1"]);
  });

  it("treats a session the runner closed itself (410) as a stopped sandbox", async () => {
    const runner = await fakeRunner({ gone: true });
    const dir = await mkdtemp(join(tmpdir(), "sidecar-gone-"));
    await writeFile(join(dir, "in.bin"), "x");
    const stoppedError = { code: "TIMEOUT", message: "The sandbox was stopped" };
    const s1 = await open([runner.url]);
    await expect(s1.exec("true")).rejects.toMatchObject(stoppedError);
    const s2 = await open([runner.url]);
    await expect(s2.copyIn(join(dir, "in.bin"), "/work/in/a")).rejects.toMatchObject(stoppedError);
    const s3 = await open([runner.url]);
    await expect(s3.copyOut("/work/in/a", join(dir, "o"))).rejects.toMatchObject(stoppedError);
    await s3.close();
  });

  it("names the runner URL, never its token, when it cannot be reached", async () => {
    const error = await open(["http://127.0.0.1:1"]).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    const text = JSON.stringify(error) + String((error as { suggestedAction?: string }).suggestedAction);
    expect(text).toContain("http://127.0.0.1:1");
    expect(text).toContain("STUDIX_SANDBOX_RUNNERS");
    expect(text).not.toContain(TOKEN);
  });

  it("refuses a runner on another protocol version", async () => {
    const old = await fakeRunner({ protocol: 99 });
    await expect(open([old.url])).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: false,
      message: expect.stringMatching(/protocol 99.*speaks 1/),
    });
  });

  it("streams merged output, passes stdin and returns the exit code; run rejects on non-zero", async () => {
    const runner = await fakeRunner();
    const session = await open([runner.url]);
    const chunks: string[] = [];
    const { exitCode } = await session.exec("cat; echo oops >&2; exit 3", {
      stdin: "hello",
      onData: (c) => chunks.push(c.toString("utf8")),
    });
    expect(exitCode).toBe(3);
    expect(chunks.join("")).toContain("hello");
    expect(chunks.join("")).toContain("oops");
    expect((await session.run(["echo", "out"])).toString("utf8")).toBe("out");
    await expect(session.run(["fail"])).rejects.toThrow("bad thing");
    await session.close();
  });

  it("copies files in and out, and reports a missing file like docker", async () => {
    const runner = await fakeRunner();
    const session = await open([runner.url]);
    const dir = await mkdtemp(join(tmpdir(), "sidecar-test-"));
    await writeFile(join(dir, "in.bin"), "payload");
    await session.copyIn(join(dir, "in.bin"), "/work/in/a.bin");
    await session.copyOut("/work/in/a.bin", join(dir, "out.bin"));
    expect(await readFile(join(dir, "out.bin"), "utf8")).toBe("payload");
    await expect(session.copyOut("/work/none", join(dir, "x"))).rejects.toMatchObject({ code: "VALIDATION" });
    await session.close();
  });

  it("closes once, and every call after close throws TIMEOUT", async () => {
    const runner = await fakeRunner();
    const session = await open([runner.url]);
    await session.close();
    await session.close();
    expect(runner.seen.deletes).toBe(1);
    await expect(session.exec("true")).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "The sandbox was stopped",
    });
    await expect(session.run(["true"])).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("copies the task's skills to /skills, keeping the executable bit", async () => {
    const runner = await fakeRunner();
    const skills = await mkdtemp(join(tmpdir(), "sidecar-skills-"));
    await mkdir(join(skills, "demo", "scripts"), { recursive: true });
    await writeFile(join(skills, "demo", "SKILL.md"), "# demo");
    await writeFile(join(skills, "demo", "scripts", "run.sh"), "echo", { mode: 0o755 });
    const session = await open([runner.url], { skillsDir: skills });
    expect([...runner.files.keys()].sort()).toEqual(["/skills/demo/SKILL.md", "/skills/demo/scripts/run.sh"]);
    expect(runner.seen.argv).toContainEqual(["touch", "/work/.studix-skills-stamp"]);
    await session.close();
  });
});

describe("skill sync from a runner", () => {
  it("downloads changed and new files, deletes removed ones, and keeps modes", async () => {
    const host = await mkdtemp(join(tmpdir(), "sidecar-sync-"));
    await mkdir(join(host, "demo"), { recursive: true });
    await writeFile(join(host, "demo", "SKILL.md"), "old");
    await writeFile(join(host, "demo", "gone.txt"), "x");
    await writeFile(join(host, "demo", "same.txt"), "same");
    const remote: Record<string, string> = {
      "demo/SKILL.md": "new",
      "demo/same.txt": "same",
      "demo/tool.sh": "echo",
    };
    const session = {
      async run(argv: readonly string[]) {
        if (argv.includes("-newer")) return Buffer.from("demo/SKILL.md\n");
        return Buffer.from("3 644 demo/SKILL.md\n4 644 demo/same.txt\n4 755 demo/tool.sh\n");
      },
      async copyOut(path: string, hostPath: string) {
        await writeFile(hostPath, remote[path.replace("/skills/", "")] ?? "");
      },
    } as unknown as SandboxSession;
    expect(await syncSkillsFromRunner(session, host)).toEqual({ synced: true });
    expect(await readFile(join(host, "demo", "SKILL.md"), "utf8")).toBe("new");
    await expect(stat(join(host, "demo", "gone.txt"))).rejects.toThrow();
    expect((await stat(join(host, "demo", "tool.sh"))).mode & 0o111).not.toBe(0);
  });
});
