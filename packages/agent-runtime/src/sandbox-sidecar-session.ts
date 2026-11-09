import { type Logger, StudixError } from "@studix/shared";
import type { SandboxSession } from "./sandbox-docker.ts";
import { FRAME_STDERR, RUNNER_ROUTES, type RunnerExecRequest } from "./sandbox-runner-protocol.ts";
import {
  RUNNER_CONTROL_TIMEOUT_MS,
  type RunnerClient,
  runnerExec,
  SessionGoneError,
} from "./sandbox-sidecar-client.ts";
import { getRunnerFile, putRunnerFile, syncSkillsFromRunner } from "./sandbox-sidecar-files.ts";

/*
 * One open session on a pi-runner sidecar, with the same behaviour as a docker sandbox session: merged output
 * for `exec`, stdout and a stderr-bearing Error for `run`, TIMEOUT "The sandbox was stopped" after close. Close
 * runs on demand, on the task's abort and at the session's wall time, and aborts every command in flight.
 */

export type SidecarCloseReason = "closed" | "aborted" | "wall-time" | "runner-lost";

/** Grace past a command's own timeout before the worker gives up on the runner's EXIT frame. */
const EXEC_TIMEOUT_GRACE_MS = 15_000;
/** setTimeout's ceiling; a larger delay fires at once (AbortSignal.timeout throws past 2^32). */
const MAX_TIMER_MS = 2_147_483_647;

function stopped(): StudixError {
  return new StudixError("TIMEOUT", "The sandbox was stopped", {
    retryable: false,
    details: { cap: "time" },
  });
}

export function createSidecarSession(input: {
  client: RunnerClient;
  sessionId: string;
  taskId: string;
  wallTimeMs: number;
  signal: AbortSignal;
  logger?: Logger;
}): SandboxSession {
  const { client, sessionId } = input;
  const opened = Date.now();
  const life = new AbortController();
  let closed = false;

  const close = async (reason: SidecarCloseReason = "closed") => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
    life.abort();
    await client
      .request(RUNNER_ROUTES.session(sessionId), { method: "DELETE", timeoutMs: RUNNER_CONTROL_TIMEOUT_MS })
      .then((res) => res.body?.cancel())
      .catch((error: unknown) =>
        input.logger?.warn("skill runner session close failed", {
          runner: client.number,
          error: String(error),
        }),
      );
    input.logger?.info("skill runner session closed", {
      runner: client.number,
      taskId: input.taskId,
      durationMs: Date.now() - opened,
      reason,
    });
  };
  const onAbort = () => void close("aborted");
  input.signal.addEventListener("abort", onAbort, { once: true });
  // The wall-time cap holds even when nothing checks it; the runner enforces its own copy too.
  const timer = setTimeout(() => void close("wall-time"), input.wallTimeMs);
  timer.unref?.();

  const assertOpen = () => {
    if (closed) throw stopped();
  };

  /** A file transfer; the runner having closed the session (410) or the session closing reads as stopped. */
  async function whileOpen<T>(transfer: () => Promise<T>): Promise<T> {
    try {
      return await transfer();
    } catch (error) {
      if (error instanceof SessionGoneError) {
        await close("runner-lost");
        throw stopped();
      }
      if (closed) throw stopped();
      throw error;
    }
  }

  /** One command, cancelled by the caller's signal, the session closing, or a missing EXIT past its timeout. */
  async function execute(
    request: RunnerExecRequest,
    opts: { stdin?: Buffer | string; signal?: AbortSignal; onData: (chunk: Buffer, stderr: boolean) => void },
  ) {
    assertOpen();
    const signals = [life.signal, opts.signal].filter((s): s is AbortSignal => Boolean(s));
    if (request.timeoutSeconds) {
      // Past the session's wall time the session closes anyway; clamping also keeps the timer in range.
      const ms =
        Math.min(Math.max(1, request.timeoutSeconds) * 1000, input.wallTimeMs) + EXEC_TIMEOUT_GRACE_MS;
      signals.push(AbortSignal.timeout(Math.min(ms, MAX_TIMER_MS)));
    }
    const signal = AbortSignal.any(signals);
    try {
      const outcome = await runnerExec(client, sessionId, request, {
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        signal,
        onFrame: (type, payload) => opts.onData(payload, type === FRAME_STDERR),
      });
      if (!outcome.complete && !signal.aborted) {
        // The runner dropped the stream without an exit status: treat the session as lost.
        await close("runner-lost");
      }
      return outcome.status.exitCode;
    } catch (error) {
      if (error instanceof SessionGoneError) {
        await close("runner-lost");
        throw stopped();
      }
      // Killed by the caller, the timeout, or close: like a docker exec killed with SIGKILL.
      if (signal.aborted) return null;
      throw error;
    }
  }

  const session: SandboxSession = {
    id: `sidecar-${client.number}/${sessionId}`,
    async exec(command, opts = {}) {
      const exitCode = await execute(
        {
          command,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.timeoutSeconds ? { timeoutSeconds: opts.timeoutSeconds } : {}),
        },
        {
          ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          // docker exec merges both streams into onData; so does this.
          onData: (chunk) => opts.onData?.(chunk),
        },
      );
      return { exitCode };
    },
    async run(argv, opts = {}) {
      const out: Buffer[] = [];
      let err = "";
      const code = await execute(
        { argv: [...argv] },
        {
          ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          onData: (chunk, stderr) => {
            if (!stderr) out.push(chunk);
            else if (err.length < 4000) err += chunk.toString("utf8");
          },
        },
      );
      if (code !== 0) {
        if (closed) throw stopped();
        throw new Error(err.trim().slice(0, 500) || `exit code ${code}`);
      }
      return Buffer.concat(out);
    },
    async copyOut(containerPath, hostPath) {
      assertOpen();
      await whileOpen(() => getRunnerFile(client, sessionId, containerPath, hostPath, life.signal));
    },
    async copyIn(hostPath, containerPath) {
      assertOpen();
      await whileOpen(() => putRunnerFile(client, sessionId, hostPath, containerPath, life.signal));
    },
    async syncSkillsOut(hostDir) {
      assertOpen();
      const result = await syncSkillsFromRunner(session, hostDir);
      if (!result.synced) {
        input.logger?.warn("skill edits not kept", {
          runner: client.number,
          taskId: input.taskId,
          reason: result.reason,
        });
      }
    },
    close: () => close("closed"),
  };
  return session;
}
