import { StudixError } from "@studix/shared";
import {
  createFrameDecoder,
  encodeExecHeader,
  FRAME_EXIT,
  FRAME_STDERR,
  FRAME_STDOUT,
  RUNNER_AUTH_SCHEME,
  RUNNER_EXEC_HEADER,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_ROUTES,
  type RunnerExecRequest,
  type RunnerExitStatus,
  type RunnerInfo,
} from "./sandbox-runner-protocol.ts";

/*
 * HTTP client of one studix-pi-runner sidecar (sandbox-runner-protocol.ts). Every error names the runner by its
 * 1-based position and URL, never by its token, so an operator can fix STUDIX_SANDBOX_RUNNERS or
 * STUDIX_RUNNER_<n>_TOKEN from the message alone.
 */

export interface SidecarRunnerConfig {
  /** `http://127.0.0.1:<port>`; the runner listens on the Pod's loopback only. */
  url: string;
  /** Shared secret, sent as a bearer token and never logged. */
  token: string;
}

export type FetchLike = typeof fetch;

/** Control requests (info, open, close) are short; a runner that does not answer in time is treated as down. */
export const RUNNER_CONTROL_TIMEOUT_MS = 10_000;

export interface RunnerClient {
  /** 1-based position in STUDIX_SANDBOX_RUNNERS, used in messages and logs. */
  readonly number: number;
  readonly url: string;
  /** Authenticated request; network failures become UNAVAILABLE naming this runner. */
  request(path: string, init: RequestInit & { timeoutMs?: number }): Promise<Response>;
  info(signal?: AbortSignal, timeoutMs?: number): Promise<RunnerInfo>;
}

export function runnerUnreachable(number: number, url: string, cause?: unknown): StudixError {
  return new StudixError("UNAVAILABLE", `Skill runner ${number} at ${url} cannot be reached`, {
    retryable: true,
    ...(cause !== undefined ? { cause } : {}),
    details: { runner: number },
    suggestedAction: `Check that the pi-runner sidecar at ${url} is running in the worker's Pod and that STUDIX_SANDBOX_RUNNERS lists its address.`,
  });
}

function runnerRefusedToken(number: number): StudixError {
  return new StudixError("UNAVAILABLE", `Skill runner ${number} refused the worker's token`, {
    retryable: false,
    details: { runner: number },
    suggestedAction: `Set STUDIX_RUNNER_${number}_TOKEN on the worker to the STUDIX_RUNNER_TOKEN of that runner.`,
  });
}

/** An unexpected HTTP answer; the body is a short runner message, never a secret. */
export async function runnerStatusError(number: number, what: string, res: Response): Promise<StudixError> {
  if (res.status === 401 || res.status === 403) return runnerRefusedToken(number);
  const text = (await res.text().catch(() => "")).trim().slice(0, 300);
  return new StudixError(
    "UNAVAILABLE",
    `Skill runner ${number} failed to ${what}: HTTP ${res.status}${text ? ` ${text}` : ""}`,
    { retryable: res.status >= 500, details: { runner: number, status: res.status } },
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createRunnerClient(
  number: number,
  config: SidecarRunnerConfig,
  fetchImpl: FetchLike,
): RunnerClient {
  const base = config.url.replace(/\/+$/, "");
  const client: RunnerClient = {
    number,
    url: base,
    async request(path, init) {
      const { timeoutMs, ...rest } = init;
      const signals = [rest.signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(
        (s): s is AbortSignal => Boolean(s),
      );
      const headers = new Headers(rest.headers);
      headers.set("authorization", `${RUNNER_AUTH_SCHEME} ${config.token}`);
      try {
        return await fetchImpl(`${base}${path}`, {
          ...rest,
          headers,
          ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
        });
      } catch (error) {
        // A caller's own abort stays an abort; a timeout or a refused connection means the runner is down.
        if (isAbort(error) && rest.signal?.aborted) throw error;
        throw runnerUnreachable(number, base, error);
      }
    },
    async info(signal, timeoutMs = RUNNER_CONTROL_TIMEOUT_MS) {
      const res = await client.request(RUNNER_ROUTES.info, {
        method: "GET",
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw await runnerStatusError(number, "report its version", res);
      const info = (await res.json()) as RunnerInfo;
      if (info.protocol !== RUNNER_PROTOCOL_VERSION) {
        throw new StudixError(
          "UNAVAILABLE",
          `Skill runner ${number} speaks protocol ${String(info.protocol)}, but this worker speaks ${RUNNER_PROTOCOL_VERSION}`,
          {
            retryable: false,
            details: {
              runner: number,
              runnerProtocol: info.protocol,
              workerProtocol: RUNNER_PROTOCOL_VERSION,
            },
            suggestedAction: "Deploy the worker and the studix-pi-runner image from the same release.",
          },
        );
      }
      return info;
    },
  };
  return client;
}

/** Outcome of one streamed command; `complete` is false when the stream ended without an EXIT frame. */
export interface RunnerExecOutcome {
  status: RunnerExitStatus;
  complete: boolean;
}

/**
 * Runs one command and feeds its output frames to `onFrame` until the EXIT frame. A 431 (header too large)
 * means the command itself does not fit the transport, which the caller can act on.
 */
export async function runnerExec(
  client: RunnerClient,
  sessionId: string,
  request: RunnerExecRequest,
  options: {
    stdin?: Buffer | string;
    signal: AbortSignal;
    onFrame: (type: typeof FRAME_STDOUT | typeof FRAME_STDERR, payload: Buffer) => void;
  },
): Promise<RunnerExecOutcome> {
  const body = options.stdin === undefined ? undefined : Buffer.from(options.stdin);
  const res = await client.request(RUNNER_ROUTES.exec(sessionId), {
    method: "POST",
    headers: { [RUNNER_EXEC_HEADER]: encodeExecHeader(request), "content-type": "application/octet-stream" },
    ...(body ? { body: new Uint8Array(body) } : {}),
    signal: options.signal,
  });
  if (res.status === 431) {
    await res.body?.cancel().catch(() => undefined);
    throw new StudixError("VALIDATION", "The command is too large for the skill runner", {
      retryable: false,
      suggestedAction: "Write long content to a file with the write tool, then run a short command.",
    });
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    throw new SessionGoneError();
  }
  if (!res.ok || !res.body) throw await runnerStatusError(client.number, "run a command", res);
  let status: RunnerExitStatus | undefined;
  const decode = createFrameDecoder((type, payload) => {
    if (type === FRAME_EXIT) {
      status = JSON.parse(Buffer.from(payload).toString("utf8")) as RunnerExitStatus;
    } else if (type === FRAME_STDOUT || type === FRAME_STDERR) {
      options.onFrame(type, Buffer.from(payload));
    }
  });
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      decode(value);
    }
  } catch (error) {
    if (options.signal.aborted)
      return { status: { exitCode: null, signal: "SIGKILL", timedOut: false }, complete: false };
    throw runnerUnreachable(client.number, client.url, error);
  }
  return status
    ? { status, complete: true }
    : { status: { exitCode: null, signal: null, timedOut: false }, complete: false };
}

/** The runner no longer knows the session (it closed it at its own wall time, or restarted). */
export class SessionGoneError extends Error {
  constructor() {
    super("The skill runner session is gone");
    this.name = "SessionGoneError";
  }
}
