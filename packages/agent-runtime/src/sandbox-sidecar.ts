import { setTimeout as sleep } from "node:timers/promises";
import { type Logger, StudixError } from "@studix/shared";
import type { SandboxDriver, SandboxOpenRequest } from "./sandbox-docker.ts";
import {
  RUNNER_ROUTES,
  type RunnerInfo,
  type RunnerOpenRequest,
  type RunnerOpenResponse,
} from "./sandbox-runner-protocol.ts";
import {
  createRunnerClient,
  type FetchLike,
  RUNNER_CONTROL_TIMEOUT_MS,
  type RunnerClient,
  runnerStatusError,
  type SidecarRunnerConfig,
} from "./sandbox-sidecar-client.ts";
import { uploadSkills } from "./sandbox-sidecar-files.ts";
import { createSidecarSession } from "./sandbox-sidecar-session.ts";

/*
 * The sidecar skill sandbox (docs/decisions/0025-sidecar-skill-runner.md): where the worker has no Docker
 * daemon (Kubernetes), each task runs on one of a few pi-runner containers in the worker's own Pod, reached
 * over loopback HTTP. A runner serves one session at a time, so `open` takes the first free one and waits,
 * with backoff, while all are busy.
 */

export type { FetchLike, SidecarRunnerConfig } from "./sandbox-sidecar-client.ts";

export interface SidecarSandboxOptions {
  runners: readonly SidecarRunnerConfig[];
  /** Test seam; default the global fetch. */
  fetch?: FetchLike;
  /** How long `open` waits for a free runner; default the task's wall time. */
  acquireTimeoutMs?: number;
  /** Session open/close lines (runner number, duration, reason); never env or tokens. */
  logger?: Logger;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;

function cancelled(): StudixError {
  return new StudixError("CANCELLED", "The task was cancelled while waiting for a skill runner", {
    retryable: false,
  });
}

function allBusy(count: number, unreachable: number): StudixError {
  const down = unreachable > 0 ? ` (${unreachable} cannot be reached)` : "";
  return new StudixError("UNAVAILABLE", `All ${count} skill runners are busy${down}`, {
    retryable: true,
    details: { runners: count, unreachable },
    suggestedAction: "Retry the job shortly; each runner serves one task at a time.",
  });
}

export function createSidecarSandboxDriver(options: SidecarSandboxOptions): SandboxDriver {
  if (options.runners.length === 0) {
    throw new StudixError("VALIDATION", "The sidecar sandbox needs at least one runner", {
      retryable: false,
    });
  }
  const fetchImpl = options.fetch ?? fetch;
  const clients = options.runners.map((r, i) => createRunnerClient(i + 1, r, fetchImpl));
  /** Runners whose protocol was checked; reset when one cannot be reached (it may come back as another build). */
  const verified = new Set<number>();
  /**
   * First contact with each runner closes whatever session it still holds: the runners belong to this Pod's
   * worker alone, so such a session was left by a previous worker process (a crash, a redeploy) and would
   * otherwise keep the runner busy until its wall time. Once per runner per process, shared by concurrent opens
   * so one open never resets a session another just got.
   */
  const reclaimed = new Map<number, Promise<void>>();
  let next = 0;

  function reclaim(client: RunnerClient, signal: AbortSignal): Promise<void> {
    let pending = reclaimed.get(client.number);
    if (!pending) {
      pending = (async () => {
        const res = await client.request(RUNNER_ROUTES.reset, {
          method: "POST",
          signal,
          timeoutMs: RUNNER_CONTROL_TIMEOUT_MS,
        });
        if (res.status !== 204 && res.status !== 200)
          throw await runnerStatusError(client.number, "reset", res);
        await res.body?.cancel().catch(() => undefined);
        options.logger?.info("skill runner reclaimed", { runner: client.number });
      })();
      reclaimed.set(client.number, pending);
      // A failed reset is retried by the next open.
      pending.catch(() => reclaimed.delete(client.number));
    }
    return pending;
  }

  /** Best effort: the runner may have accepted an open whose answer never arrived; free it for that task. */
  function abandon(client: RunnerClient, taskId: string): void {
    void client
      .request(RUNNER_ROUTES.sessionsByTask(taskId), {
        method: "DELETE",
        timeoutMs: RUNNER_CONTROL_TIMEOUT_MS,
      })
      .then((res) => res.body?.cancel())
      .catch(() => undefined);
  }

  /** One attempt on one runner: a session id, "busy", or a thrown error. */
  async function tryOpen(client: RunnerClient, body: RunnerOpenRequest, signal: AbortSignal) {
    if (!verified.has(client.number)) {
      await client.info(signal);
      verified.add(client.number);
    }
    await reclaim(client, signal);
    let res: Response;
    try {
      res = await client.request(RUNNER_ROUTES.open, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
        timeoutMs: RUNNER_CONTROL_TIMEOUT_MS,
      });
    } catch (error) {
      abandon(client, body.taskId);
      throw error;
    }
    if (res.status === 409) {
      await res.body?.cancel().catch(() => undefined);
      return "busy" as const;
    }
    if (res.status !== 201 && res.status !== 200)
      throw await runnerStatusError(client.number, "open a session", res);
    const { sessionId } = (await res.json().catch(() => ({}))) as Partial<RunnerOpenResponse>;
    if (typeof sessionId !== "string" || !sessionId) {
      abandon(client, body.taskId);
      throw new StudixError("UNAVAILABLE", `Skill runner ${client.number} returned no session id`, {
        retryable: true,
      });
    }
    return sessionId;
  }

  async function acquire(request: SandboxOpenRequest, body: RunnerOpenRequest) {
    const deadline = Date.now() + (options.acquireTimeoutMs ?? request.limits.wallTimeMs);
    let delay = FIRST_RETRY_MS;
    for (;;) {
      let busy = 0;
      let lastDown: StudixError | undefined;
      const start = next++ % clients.length;
      for (let k = 0; k < clients.length; k++) {
        const client = clients[(start + k) % clients.length] as RunnerClient;
        try {
          const result = await tryOpen(client, body, request.signal);
          if (result === "busy") busy++;
          else return { client, sessionId: result };
        } catch (error) {
          if (request.signal.aborted) throw cancelled();
          // A runner that is down (or still starting) is skipped; any other answer is a real failure.
          if (!(error instanceof StudixError && error.code === "UNAVAILABLE" && error.retryable)) throw error;
          verified.delete(client.number);
          lastDown = error;
        }
      }
      if (busy === 0 && lastDown) throw lastDown;
      const unreachable = clients.length - busy;
      if (request.signal.aborted) throw cancelled();
      if (Date.now() + delay > deadline) throw allBusy(clients.length, unreachable);
      await sleep(delay, undefined, { signal: request.signal }).catch(() => undefined);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }

  return {
    id: "sidecar",
    async open(request) {
      for (const name of Object.keys(request.env)) {
        if (!ENV_NAME.test(name)) {
          throw new StudixError("VALIDATION", `Sandbox env name ${name.slice(0, 40)} is not allowed`, {
            retryable: false,
          });
        }
      }
      const body: RunnerOpenRequest = {
        taskId: request.taskId,
        env: { ...request.env },
        limits: { pids: request.limits.pids, wallTimeMs: request.limits.wallTimeMs },
      };
      const { client, sessionId } = await acquire(request, body);
      options.logger?.info("skill runner session opened", { runner: client.number, taskId: request.taskId });
      const session = createSidecarSession({
        client,
        sessionId,
        taskId: request.taskId,
        wallTimeMs: request.limits.wallTimeMs,
        signal: request.signal,
        ...(options.logger ? { logger: options.logger } : {}),
      });
      try {
        if (request.signal.aborted) {
          throw new StudixError("CANCELLED", "The task was cancelled while its skill runner was starting", {
            retryable: false,
          });
        }
        if (request.skillsDir) await uploadSkills(session, request.skillsDir);
        return session;
      } catch (error) {
        await session.close().catch(() => undefined);
        throw error;
      }
    },
  };
}

export interface SidecarRunnerHealth {
  runner: number;
  url: string;
  ok: boolean;
  version?: string;
  busy?: boolean;
  toolchain?: Record<string, string>;
  /** Short reason when not ok (unreachable, token refused, protocol mismatch). */
  error?: string;
}

/** Asks every runner for /v1/info once; never throws. */
export async function probeSidecarRunners(
  runners: readonly SidecarRunnerConfig[],
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<SidecarRunnerHealth[]> {
  const fetchImpl = options.fetch ?? fetch;
  return Promise.all(
    runners.map(async (r, i): Promise<SidecarRunnerHealth> => {
      const client = createRunnerClient(i + 1, r, fetchImpl);
      try {
        const info: RunnerInfo = await client.info(undefined, options.timeoutMs ?? 3_000);
        return {
          runner: i + 1,
          url: client.url,
          ok: true,
          version: info.version,
          busy: info.busy,
          toolchain: info.toolchain,
        };
      } catch (error) {
        return {
          runner: i + 1,
          url: client.url,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}
