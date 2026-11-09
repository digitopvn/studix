/* Test harness: a runner on an ephemeral port with its roots in a temp dir, plus a tiny protocol client. */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFrameDecoder,
  encodeExecHeader,
  FRAME_EXIT,
  FRAME_STDERR,
  FRAME_STDOUT,
  RUNNER_EXEC_HEADER,
  RUNNER_ROUTES,
  type RunnerExecRequest,
  type RunnerExitStatus,
} from "../../../packages/agent-runtime/src/sandbox-runner-protocol.ts";
import { createRunner, type RunnerOptions } from "../src/runner-server.ts";

export const TOKEN = "t".repeat(40);

/** A process cap the test machine accepts: the uid's hard limit when lower than 2000 (macOS caps it at ~2666). */
function testPids(): number {
  const hard = spawnSync("sh", ["-c", "ulimit -Hu"], { encoding: "utf8" }).stdout.trim();
  const value = Number(hard);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 2000) : 2000;
}
export const PIDS = testPids();

export async function startTestRunner(overrides: Partial<RunnerOptions> = {}) {
  const base = await mkdtemp(join(tmpdir(), "pi-runner-"));
  const scratch = join(base, "scratch");
  await mkdir(scratch);
  const runner = createRunner({
    token: TOKEN,
    port: 0,
    roots: { work: join(base, "work"), skills: join(base, "skills") },
    scratchRoots: [scratch],
    // The token sits in the source env on purpose: the child env must filter it out.
    env: { ...process.env, STUDIX_RUNNER_TOKEN: TOKEN },
    ...overrides,
  });
  const { port } = await runner.start();
  const url = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${TOKEN}` };
  const work = await realpath(join(base, "work"));

  const client = {
    url,
    base,
    scratch,
    work,
    auth,
    async open(env: Record<string, string> = {}, wallTimeMs = 60_000): Promise<Response> {
      return fetch(`${url}${RUNNER_ROUTES.open}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ taskId: "task-1", env, limits: { pids: PIDS, wallTimeMs } }),
      });
    },
    async openId(env: Record<string, string> = {}): Promise<string> {
      const res = await client.open(env);
      if (res.status !== 201) throw new Error(`open failed: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { sessionId: string }).sessionId;
    },
    close(id: string): Promise<Response> {
      return fetch(`${url}${RUNNER_ROUTES.session(id)}`, { method: "DELETE", headers: auth });
    },
    execResponse(id: string, request: RunnerExecRequest, stdin?: string, signal?: AbortSignal) {
      return fetch(`${url}${RUNNER_ROUTES.exec(id)}`, {
        method: "POST",
        headers: { ...auth, [RUNNER_EXEC_HEADER]: encodeExecHeader(request) },
        body: stdin,
        signal,
      });
    },
    async exec(id: string, request: RunnerExecRequest, stdin?: string) {
      const res = await client.execResponse(id, request, stdin);
      if (res.status !== 200) return { status: res.status, stdout: "", stderr: await res.text(), exit: null };
      return { status: 200, ...decodeExec(new Uint8Array(await res.arrayBuffer())) };
    },
    putFile(id: string, path: string, body: string | Uint8Array<ArrayBuffer>) {
      return fetch(`${url}${RUNNER_ROUTES.file(id)}?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: auth,
        body,
      });
    },
    getFile(id: string, path: string) {
      return fetch(`${url}${RUNNER_ROUTES.file(id)}?path=${encodeURIComponent(path)}`, { headers: auth });
    },
    async stop() {
      await runner.stop();
      await rm(base, { recursive: true, force: true });
    },
  };
  return client;
}

export function decodeExec(bytes: Uint8Array) {
  let stdout = "";
  let stderr = "";
  let exit: RunnerExitStatus | null = null;
  const text = new TextDecoder();
  createFrameDecoder((type, payload) => {
    if (type === FRAME_STDOUT) stdout += text.decode(payload);
    else if (type === FRAME_STDERR) stderr += text.decode(payload);
    else if (type === FRAME_EXIT) exit = JSON.parse(text.decode(payload)) as RunnerExitStatus;
  })(bytes);
  return { stdout, stderr, exit: exit as RunnerExitStatus | null };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}
