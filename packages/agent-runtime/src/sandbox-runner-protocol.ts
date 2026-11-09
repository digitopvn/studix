/*
 * The wire contract between the worker's sidecar sandbox driver (sandbox-sidecar.ts) and the studix-pi-runner
 * process (apps/pi-runner). Both sides import this file, so it must stay dependency-free: the runner image copies
 * it by path and runs it with Node's type stripping. See docs/decisions/0025-sidecar-skill-runner.md.
 *
 * One runner container serves ONE session at a time. Opening a session on a busy runner is refused (409); the
 * worker holds a pool of runners and waits for a free one. Between sessions the runner kills every process it
 * started and wipes every writable path, so nothing of one job reaches the next.
 */

/** Bumped on any incompatible change; the worker refuses a runner that reports another value. */
export const RUNNER_PROTOCOL_VERSION = 1;

/** Bearer token header value prefix. Every route except GET /healthz needs `Authorization: Bearer <token>`. */
export const RUNNER_AUTH_SCHEME = "Bearer";

/** Default TCP port; the runner API listens on 127.0.0.1 only (pod-local). */
export const RUNNER_DEFAULT_PORT = 7071;

/**
 * Kubernetes probes call the Pod IP, never loopback, so GET /healthz is ALSO served on 0.0.0.0 at
 * API port + this offset (7171 for 7071). That listener serves /healthz and nothing else; the sidecar's declared
 * `port` (the probe target) is this one.
 */
export const RUNNER_HEALTH_PORT_OFFSET = 100;

/** Environment of the runner container. */
export const RUNNER_ENV = {
  /** Shared secret with the worker. Required; the runner refuses to start without one of >= 32 chars. */
  token: "STUDIX_RUNNER_TOKEN",
  port: "STUDIX_RUNNER_PORT",
  /**
   * Cap on the bytes a session may keep under its writable paths; the session is killed past it. Default 1536:
   * TOSE evicts the whole Pod when a sidecar passes its 2 GiB ephemeral-storage limit, so stay well below it.
   */
  maxDiskMb: "STUDIX_RUNNER_MAX_DISK_MB",
  /** Cap on one uploaded or downloaded file. */
  maxFileMb: "STUDIX_RUNNER_MAX_FILE_MB",
} as const;

/** Routes. `:id` is the session id returned by open. */
export const RUNNER_ROUTES = {
  /** Unauthenticated liveness/readiness for the TOSE probe: `{ ok: true }` only, nothing else. */
  health: "/healthz",
  /** Authenticated: RunnerInfo. */
  info: "/v1/info",
  /** POST RunnerOpenRequest -> 201 RunnerOpenResponse; 409 when busy. */
  open: "/v1/sessions",
  /** DELETE: kills the session's processes and wipes its paths. Idempotent. */
  session: (id: string) => `/v1/sessions/${encodeURIComponent(id)}`,
  /**
   * DELETE `?taskId=<id>`: closes the current session only when it was opened for that task (204 either way).
   * The worker calls it when an open request failed or was cancelled after the runner may have accepted it.
   */
  sessionsByTask: (taskId: string) => `/v1/sessions?taskId=${encodeURIComponent(taskId)}`,
  /**
   * POST: closes whatever session is open (204). Each runner belongs to exactly one worker (its Pod's), so a worker
   * calls this at startup: any session still open was orphaned by the previous worker process.
   */
  reset: "/v1/reset",
  /**
   * POST: runs one command. Request header RUNNER_EXEC_HEADER carries base64url(JSON RunnerExecRequest); the
   * request body is the command's stdin (empty for none). The response streams frames (encodeFrame) until one
   * EXIT frame. Aborting the HTTP request kills the command's process group.
   */
  exec: (id: string) => `/v1/sessions/${encodeURIComponent(id)}/exec`,
  /**
   * PUT `?path=<abs>`: body is the file (parents created). GET `?path=<abs>`: streams the file (symlinks resolve
   * inside the runner; the resolved path must stay under an allowed root). 404 when missing, 413 past the cap.
   */
  file: (id: string) => `/v1/sessions/${encodeURIComponent(id)}/file`,
} as const;

export const RUNNER_EXEC_HEADER = "x-studix-exec";

export interface RunnerLimits {
  /** Process cap applied with `ulimit -u` to the session's commands. */
  pids: number;
  /** The runner closes the session when this passes, whatever is running. */
  wallTimeMs: number;
}

export interface RunnerOpenRequest {
  /** Worker task id; logged and echoed, never used as a path. */
  taskId: string;
  /** The task's own media vendor keys; added to every command's environment of this session only. */
  env: Record<string, string>;
  limits: RunnerLimits;
}

export interface RunnerOpenResponse {
  sessionId: string;
}

export interface RunnerExecRequest {
  /** Exactly one of command (run as `sh -c command`) or argv (run directly). */
  command?: string;
  argv?: string[];
  cwd?: string;
  timeoutSeconds?: number;
}

export interface RunnerExitStatus {
  /** null when the command was killed (timeout, cancel, session close). */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface RunnerInfo {
  protocol: number;
  /** Image build identifier (git sha or tag) baked at build time; "dev" locally. */
  version: string;
  busy: boolean;
  /** Versions of the toolchain on the image, for preflight display (node, ffmpeg, chrome, hyperframes, multix, codex). */
  toolchain: Record<string, string>;
  /** Process start time, ISO 8601. */
  startedAt: string;
}

/** Frames of the exec response stream: [type:u8][length:u32be][payload]. */
export const FRAME_STDOUT = 1;
export const FRAME_STDERR = 2;
/** Payload: JSON RunnerExitStatus. Always the last frame. */
export const FRAME_EXIT = 3;
/**
 * Empty payload, sent about every 15 s while a command runs, so a silent command (a long render) never trips the
 * worker's HTTP body timeout. The runner also flushes the response headers before the first output. Ignore it.
 */
export const FRAME_KEEPALIVE = 4;
export const RUNNER_KEEPALIVE_MS = 15_000;

/**
 * Status 410 on any session route: the runner itself closed that session (wall time, disk cap, reset). The body is
 * `{ "error": "session closed: <reason>" }`. The worker treats it like the docker driver's stopped sandbox.
 */
export const RUNNER_SESSION_GONE_STATUS = 410;
const FRAME_HEADER_BYTES = 5;

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, payload.byteLength);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/** Incremental decoder of the frame stream; push chunks, receive whole frames. */
export function createFrameDecoder(onFrame: (type: number, payload: Uint8Array) => void) {
  let buffered = new Uint8Array(0);
  return (chunk: Uint8Array) => {
    const merged = new Uint8Array(buffered.byteLength + chunk.byteLength);
    merged.set(buffered, 0);
    merged.set(chunk, buffered.byteLength);
    let offset = 0;
    while (merged.byteLength - offset >= FRAME_HEADER_BYTES) {
      const view = new DataView(merged.buffer, merged.byteOffset + offset);
      const length = view.getUint32(1);
      if (merged.byteLength - offset - FRAME_HEADER_BYTES < length) break;
      const type = view.getUint8(0);
      onFrame(type, merged.subarray(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + length));
      offset += FRAME_HEADER_BYTES + length;
    }
    buffered = merged.slice(offset);
  };
}

export function encodeExecHeader(request: RunnerExecRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

export function decodeExecHeader(value: string): RunnerExecRequest {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as RunnerExecRequest;
}

/** Paths a session may read and write, fixed so prompts and skills keep using /work and /skills. */
export const RUNNER_ALLOWED_ROOTS = ["/work", "/skills"] as const;
