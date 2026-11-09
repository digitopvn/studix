/*
 * POST /v1/sessions/:id/exec: one command in its own process group, stdin from the request body, stdout and
 * stderr streamed back as frames, then one EXIT frame. A timeout or a client abort SIGKILLs the whole group,
 * grandchildren included. Like `docker exec`, the command sees only the session environment.
 */
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeExecHeader,
  encodeFrame,
  FRAME_EXIT,
  FRAME_KEEPALIVE,
  FRAME_STDERR,
  FRAME_STDOUT,
  RUNNER_EXEC_HEADER,
  RUNNER_KEEPALIVE_MS,
  type RunnerExitStatus,
} from "../../../packages/agent-runtime/src/sandbox-runner-protocol.ts";
import { checkPath } from "./runner-files.ts";
import { HttpError, sendJson } from "./runner-http.ts";
import type { Session, SessionManager } from "./runner-session.ts";
import { killGroup } from "./runner-sweep.ts";

/** How long the EXIT frame waits for a background process that still holds stdout/stderr open. */
const STDIO_GRACE_MS = 2_000;
/** Floor of the per-uid process cap; see runExec. */
const MIN_NPROC = 4096;
/** setTimeout's ceiling (about 24.8 days); a larger delay would fire at once. The session wall time ends sooner. */
const MAX_TIMER_MS = 2_147_483_647;

interface ExecPlan {
  argv: string[];
  cwd: string;
  timeoutMs: number | null;
}

export function parseExec(
  header: string | string[] | undefined,
  roots: readonly string[],
  work: string,
): ExecPlan {
  if (typeof header !== "string" || header === "")
    throw new HttpError(400, `${RUNNER_EXEC_HEADER} header missing`);
  let request: ReturnType<typeof decodeExecHeader>;
  try {
    request = decodeExecHeader(header);
  } catch {
    throw new HttpError(400, `${RUNNER_EXEC_HEADER} header is not base64url JSON`);
  }
  if (typeof request !== "object" || request === null)
    throw new HttpError(400, "exec request must be an object");
  const { command, argv, cwd, timeoutSeconds } = request;
  const hasCommand = typeof command === "string" && command !== "";
  const hasArgv =
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.every((part) => typeof part === "string" && !part.includes("\0"));
  if (hasCommand === hasArgv || (hasCommand && command.includes("\0"))) {
    throw new HttpError(400, "exec needs exactly one of a non-empty command or argv");
  }
  if (timeoutSeconds !== undefined && !(typeof timeoutSeconds === "number" && timeoutSeconds > 0)) {
    throw new HttpError(400, "timeoutSeconds must be a positive number");
  }
  return {
    argv: hasCommand ? ["sh", "-c", command] : (argv as string[]),
    cwd: cwd === undefined ? work : checkPath(cwd, roots),
    timeoutMs: timeoutSeconds === undefined ? null : Math.min(MAX_TIMER_MS, Math.ceil(timeoutSeconds * 1000)),
  };
}

export function runExec(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  sessions: SessionManager,
  plan: ExecPlan,
): void {
  // `ulimit -u` is bash's process cap; dash (the image's /bin/sh) calls it -p. Refuse to run uncapped.
  // RLIMIT_NPROC counts every process of this uid on the whole node (containers share the host user
  // namespace), not only this container's, so a tight cap fails forks at random on a busy node. It is a
  // fork-bomb backstop with a floor, not the task's process budget; the Pod's cgroup is the real bound.
  const pids = Math.max(MIN_NPROC, Math.floor(session.limits.pids));
  // Never above the hard limit, which an unprivileged process cannot raise.
  const wrapper =
    `n=${pids}; h=$(ulimit -Hu 2>/dev/null || ulimit -Hp); ` +
    `if [ "$h" != unlimited ] && [ "$h" -lt "$n" ]; then n=$h; fi; ` +
    `ulimit -u "$n" 2>/dev/null || ulimit -p "$n" || exit 126; exec "$@"`;
  const child = spawn("sh", ["-c", wrapper, "sh", ...plan.argv], {
    cwd: plan.cwd,
    env: session.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) {
    child.once("error", (error: NodeJS.ErrnoException) => {
      sendJson(res, 400, { error: `cannot start command: ${error.code ?? error.message}` });
    });
    req.resume();
    return;
  }
  sessions.track(session, child);
  res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
  // Headers now and a keepalive frame on every quiet interval: a command silent for minutes (a render) must not
  // look like a dead connection to the worker's HTTP client.
  res.flushHeaders();

  let finished = false;
  let timedOut = false;
  const timers: NodeJS.Timeout[] = [];
  const keepalive = setInterval(() => {
    if (!finished && !res.destroyed) res.write(encodeFrame(FRAME_KEEPALIVE, new Uint8Array(0)));
  }, RUNNER_KEEPALIVE_MS);

  const forward = (type: number) => (chunk: Buffer) => {
    if (finished || res.destroyed) return;
    if (!res.write(encodeFrame(type, chunk))) {
      child.stdout.pause();
      child.stderr.pause();
      res.once("drain", () => {
        child.stdout.resume();
        child.stderr.resume();
      });
    }
  };
  child.stdout.on("data", forward(FRAME_STDOUT));
  child.stderr.on("data", forward(FRAME_STDERR));
  child.stdin.on("error", () => {
    // The command exited without reading all of its stdin; that is its choice, not a runner error.
  });
  req.pipe(child.stdin);

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true;
    clearInterval(keepalive);
    for (const timer of timers) clearTimeout(timer);
    child.stdout.destroy();
    child.stderr.destroy();
    if (res.destroyed) return;
    const status: RunnerExitStatus = { exitCode: signal ? null : code, signal, timedOut };
    res.end(encodeFrame(FRAME_EXIT, Buffer.from(JSON.stringify(status), "utf8")));
  };
  child.once("exit", (code, signal) => {
    timers.push(setTimeout(() => finish(code, signal), STDIO_GRACE_MS));
  });
  child.once("close", (code, signal) => finish(code, signal));

  if (plan.timeoutMs !== null) {
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killGroup(pid);
      }, plan.timeoutMs),
    );
  }
  // The worker aborted the request (or its connection dropped): the command must not outlive it.
  res.once("close", () => {
    if (!finished) killGroup(pid);
  });
}
