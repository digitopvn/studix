import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/client";

/** Standard tool envelope as seen by an MCP client. */
export interface Envelope {
  status: "ok" | "error";
  data: Record<string, unknown> | null;
  next: { tool: string; arguments?: Record<string, unknown> }[];
  error?: { code: string; message: string; suggestedAction?: string; retryable: boolean };
  traceId: string;
}

export interface JobData {
  id: string;
  status: string;
  stage?: string;
  attempts: number;
  error?: { code: string; message: string; suggestedAction?: string };
  stages: { name: string; status: string; attempt: number }[];
  approval?: { id: string; action: string; status: string };
  result?: Record<string, unknown>;
  video?: { url: string; renderId: string };
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as unknown as Envelope;
}

/** Poll studix_get_job until `done(job)` holds; fails with the last job state after `timeoutMs`. */
export async function pollJob(
  client: Client,
  jobId: string,
  done: (job: JobData) => boolean,
  timeoutMs: number,
  onTimeout: () => string = () => "",
): Promise<JobData> {
  const deadline = Date.now() + timeoutMs;
  let last: JobData | undefined;
  while (Date.now() < deadline) {
    const env = await callTool(client, "studix_get_job", { jobId });
    if (env.status !== "ok") throw new Error(`studix_get_job failed: ${JSON.stringify(env.error)}`);
    last = env.data as unknown as JobData;
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`job ${jobId} did not reach the expected state: ${JSON.stringify(last)}\n${onTimeout()}`);
}

const WORKER_DIR = fileURLToPath(new URL("../../worker/", import.meta.url));

/** Variables forwarded from the test environment to the worker; never the developer's full env or .env. */
const FORWARDED = [
  "PATH",
  "HOME",
  "TMPDIR",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "FFMPEG_PATH",
  "FFPROBE_PATH",
  "HYPERFRAMES_BROWSER_PATH",
  "PRODUCER_HEADLESS_SHELL_PATH",
];

export interface WorkerHandle {
  child: ChildProcess;
  /** Recent stderr/stdout lines, for failure messages. */
  logs(): string;
  /** SIGKILL the worker and every descendant (Chromium included), as a crashed pod would lose them. */
  crash(): void;
  /** SIGTERM and wait for a graceful drain; force-kills the tree after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
}

function descendants(root: number): number[] {
  const table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of table.trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number) as [number, number];
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

function killTree(root: number): void {
  for (const pid of [...descendants(root), root]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Start `apps/worker` as a real child process (`node --import tsx src/main.ts`). */
export function startWorker(env: Record<string, string>): WorkerHandle {
  const forwarded = Object.fromEntries(
    FORWARDED.flatMap((k) => (process.env[k] ? [[k, process.env[k] as string]] : [])),
  );
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: WORKER_DIR,
    env: { ...forwarded, NODE_ENV: "test", LOG_LEVEL: "warn", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    child,
    logs: () => lines.slice(-40).join("\n"),
    crash: () => {
      if (child.pid && child.exitCode === null) killTree(child.pid);
    },
    async stop(graceMs = 10_000) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const tree = descendants(child.pid);
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.pid && killTree(child.pid), graceMs);
      await exited;
      clearTimeout(timer);
      for (const pid of tree) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Exited with the worker.
        }
      }
    },
  };
}
