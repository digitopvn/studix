import { spawn } from "node:child_process";
import { StudixError } from "@studix/shared";

export interface MultixRunOptions {
  cwd: string;
  /** The complete child environment; nothing is inherited from the worker. */
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface MultixRunResult {
  /** Null when the process was killed by a signal. */
  exitCode: number | null;
  stdout: string;
  /** Set when the runner itself stopped the process. */
  stoppedBy?: "timeout" | "abort";
}

/** Runs one multix command with a fixed argv. Implementations must never go through a shell. */
export type MultixRunner = (argv: readonly string[], options: MultixRunOptions) => Promise<MultixRunResult>;

/** The envelope is one line; anything this large is not one. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;
const SCRIPT_BIN = /\.(c|m)?js$/i;

/**
 * Spawn the multix CLI without a shell. A `.js` bin (the package's `dist/cli.js`) runs under the current
 * Node binary, which is also how Windows hosts call it: `.cmd` shims would need a shell.
 */
export function createSpawnMultixRunner(bin: string): MultixRunner {
  const [command, prefix] = SCRIPT_BIN.test(bin) ? [process.execPath, [bin]] : [bin, []];
  return (argv, options) =>
    new Promise<MultixRunResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new StudixError("CANCELLED", "Media generation cancelled"));
        return;
      }
      const child = spawn(command, [...prefix, ...argv], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stoppedBy: MultixRunResult["stoppedBy"];
      let killTimer: NodeJS.Timeout | undefined;
      const stop = (reason: NonNullable<MultixRunResult["stoppedBy"]>) => {
        if (stoppedBy) return;
        stoppedBy = reason;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
      timer.unref();
      const onAbort = () => stop("abort");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= MAX_STDOUT_BYTES) chunks.push(chunk);
      });
      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      child.on("error", (err: NodeJS.ErrnoException) => {
        cleanup();
        reject(
          new StudixError("UNAVAILABLE", "The multix CLI could not be started", {
            retryable: false,
            cause: err,
            suggestedAction: "Point MULTIX_BIN at the multix CLI (on Windows, its dist/cli.js).",
            details: { code: err.code },
          }),
        );
      });
      child.on("close", (code) => {
        cleanup();
        resolve({
          exitCode: code,
          stdout: Buffer.concat(chunks).toString("utf8"),
          ...(stoppedBy ? { stoppedBy } : {}),
        });
      });
    });
}

export interface MultixOutputFile {
  path: string;
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationS?: number;
}

export interface MultixEnvelopeError {
  code?: string;
  message?: string;
  retryable?: boolean;
  retryAfterS?: number;
  hint?: string;
}

/** The fields of a `multix.result/v1` envelope this adapter reads; everything else is ignored. */
export interface MultixEnvelope {
  ok: boolean;
  exitCode?: number;
  outputs: MultixOutputFile[];
  jobId?: string;
  text?: string;
  data?: unknown;
  error?: MultixEnvelopeError;
  warnings: string[];
  /** Upper bound of the pre-flight estimate, when multix could price the request. */
  estimateHighUsd?: number;
  /** What the provider charged, when the run reported it. */
  receiptUsd?: number;
  /** The run reported that it sent no request upstream, so nothing was charged. */
  noRequest?: boolean;
  historyId?: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const obj = (v: unknown): Json => (isObject(v) ? v : {});

function parseOutputs(raw: unknown): MultixOutputFile[] {
  if (!Array.isArray(raw)) return [];
  const files: MultixOutputFile[] = [];
  for (const item of raw) {
    const path = isObject(item) ? str(item.path) : undefined;
    if (!path || !isObject(item)) continue;
    const file: MultixOutputFile = { path };
    const mime = str(item.mime);
    if (mime) file.mime = mime;
    const bytes = num(item.bytes);
    if (bytes !== undefined) file.bytes = bytes;
    const width = num(item.width);
    if (width !== undefined) file.width = width;
    const height = num(item.height);
    if (height !== undefined) file.height = height;
    const duration = num(item.duration_s);
    if (duration !== undefined) file.durationS = duration;
    files.push(file);
  }
  return files;
}

function parseWarnings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w) => {
    const code = typeof w === "string" ? w : isObject(w) ? str(w.code) : undefined;
    return code ? [code] : [];
  });
}

/** What Sume itself says it captured for a job, in cents. */
const SUME_CAPTURED_CENTS = "data.job.usage_summary.captured_usd_cents";
const SUME_USAGE_PREFIX = "data.job.usage_summary.";

/**
 * Sume can mark a job completed before it has captured the reserved charge, so `captured` may still read 0.
 * What it will keep is `reserved - refunded - released`; the receipt is never below that. Callers only read
 * a receipt after a successful run that produced outputs, so a failed job's reservation is never billed.
 */
function sumeKeptCents(metrics: Json): number | undefined {
  const reserved = num(metrics[`${SUME_USAGE_PREFIX}reserved_usd_cents`]);
  if (reserved === undefined) return undefined;
  const refunded = num(metrics[`${SUME_USAGE_PREFIX}refunded_usd_cents`]) ?? 0;
  const released = num(metrics[`${SUME_USAGE_PREFIX}released_usd_cents`]) ?? 0;
  return Math.max(0, reserved - refunded - released);
}

/**
 * A charge the provider reported; a run that sent no request reports none. Sume's own captured amount
 * wins over multix's `cost_usd`, which has been seen to grow with every status poll of the same job.
 */
function parseReceipt(envelope: Json): number | undefined {
  const metrics = obj(obj(envelope.usage).metrics);
  const captured = num(metrics[SUME_CAPTURED_CENTS]);
  if (captured !== undefined) {
    const kept = sumeKeptCents(metrics) ?? 0;
    return Math.max(captured, kept) / 100;
  }
  const cost = obj(envelope.cost);
  if (cost.actual_source !== "no_request") {
    const actual = num(cost.actual_usd) ?? num(obj(cost.provider_reported).cost_usd);
    if (actual !== undefined) return actual;
  }
  return num(obj(envelope.usage).cost_usd);
}

/**
 * `sume status --download` and `atlas status --download` leave `outputs` empty and list what they saved
 * only in `text`: a "Saved N file(s) from job <id>:" (Sume) or "Prediction <id>: saved N file(s)" (Atlas)
 * line, followed by one indented path per line. Callers still confine these paths to the directory they
 * asked multix to write into.
 */
function savedFiles(text: unknown): MultixOutputFile[] {
  if (typeof text !== "string") return [];
  const lines = text.split(/\r?\n/);
  const head = lines.findIndex((line) => /\bsaved \d+ file\(s\)/i.test(line));
  if (head === -1) return [];
  const files: MultixOutputFile[] = [];
  for (const line of lines.slice(head + 1)) {
    if (!/^\s+\S/.test(line)) break;
    const path = line.trim();
    if (!path.includes("\0")) files.push({ path });
  }
  return files;
}

/** Parse the single-line JSON envelope multix prints on stdout with --json. */
export function parseMultixEnvelope(stdout: string): MultixEnvelope | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith("{"));
  if (!line) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(raw) || raw.schema !== "multix.result/v1" || typeof raw.ok !== "boolean") return undefined;
  const error = isObject(raw.error) ? raw.error : undefined;
  const estimate = obj(raw.estimate);
  const outputs = parseOutputs(raw.outputs);
  const envelope: MultixEnvelope = {
    ok: raw.ok,
    outputs: outputs.length > 0 ? outputs : savedFiles(raw.text),
    warnings: parseWarnings(raw.warnings),
  };
  const exitCode = typeof raw.exit_code === "number" ? raw.exit_code : undefined;
  if (exitCode !== undefined) envelope.exitCode = exitCode;
  const jobId = str(obj(raw.job).id);
  if (jobId) envelope.jobId = jobId;
  const text = str(raw.text);
  if (text) envelope.text = text;
  if (raw.data !== undefined) envelope.data = raw.data;
  if (error) {
    envelope.error = {
      ...(str(error.code) ? { code: str(error.code) } : {}),
      ...(str(error.message) ? { message: str(error.message) } : {}),
      ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
      ...(num(error.retry_after_s) !== undefined ? { retryAfterS: num(error.retry_after_s) } : {}),
      ...(str(error.hint) ? { hint: str(error.hint) } : {}),
    };
  }
  const high = estimate.status === "estimated" ? num(estimate.high_usd) : undefined;
  if (high !== undefined) envelope.estimateHighUsd = high;
  const receipt = parseReceipt(raw);
  if (receipt !== undefined) envelope.receiptUsd = receipt;
  if (obj(raw.cost).actual_source === "no_request") envelope.noRequest = true;
  const historyId = str(raw.history_id);
  if (historyId) envelope.historyId = historyId;
  return envelope;
}

/** Warnings multix's agent protocol says mean the output must not be trusted. */
export const UNTRUSTED_OUTPUT_WARNINGS: ReadonlySet<string> = new Set([
  "EMPTY_OUTPUT",
  "CONTENT_MISMATCH",
  "UNREADABLE_MEDIA",
]);

/** STATUS_STACK_BUFFER_OVERRUN: how Node reports a native abort on Windows. */
const WINDOWS_NATIVE_ABORT = 0xc0000409;

/**
 * Whether a run succeeded. The envelope is the protocol's result, but the process exit code must agree,
 * with one exception: Node 24 on Windows can abort at exit (libuv `UV_HANDLE_CLOSING` assertion) after
 * multix already printed a complete success envelope. That one crash code is accepted when the envelope
 * itself reports exit code 0.
 */
export function multixRunSucceeded(
  run: MultixRunResult,
  envelope: MultixEnvelope | undefined,
): envelope is MultixEnvelope {
  if (run.stoppedBy || !envelope?.ok) return false;
  if (run.exitCode === 0) return true;
  return run.exitCode === WINDOWS_NATIVE_ABORT && envelope.exitCode === 0;
}

const MAX_MESSAGE = 300;

/** Map a failed run to a typed error, following the exit codes of `multix guide`. */
export function multixRunError(
  command: string,
  run: MultixRunResult,
  envelope: MultixEnvelope | undefined,
  details: Record<string, unknown> = {},
): StudixError {
  if (run.stoppedBy === "abort") return new StudixError("CANCELLED", `multix ${command} was cancelled`);
  const upstream = envelope?.error;
  const info = {
    ...details,
    command,
    exitCode: run.exitCode,
    ...(upstream?.code ? { upstreamCode: upstream.code } : {}),
    ...(upstream?.hint ? { hint: upstream.hint.slice(0, MAX_MESSAGE) } : {}),
  };
  const message = upstream?.message ? `: ${upstream.message.slice(0, MAX_MESSAGE)}` : "";
  if (run.stoppedBy === "timeout") {
    return new StudixError("TIMEOUT", `multix ${command} did not finish in time`, { details: info });
  }
  if (!envelope) {
    return new StudixError("PROVIDER_ERROR", `multix ${command} exited ${run.exitCode} without a result`, {
      details: info,
    });
  }
  switch (run.exitCode ?? envelope.exitCode) {
    case 2:
      return new StudixError("VALIDATION", `multix rejected the request${message}`, { details: info });
    case 3:
      return new StudixError("UNAVAILABLE", `multix is missing a key or setting${message}`, {
        retryable: false,
        details: info,
        suggestedAction: "Provide the provider's API key to the worker, then retry.",
      });
    case 4:
      return new StudixError("PROVIDER_ERROR", `The provider failed temporarily${message}`, {
        retryable: true,
        details: { ...info, ...(upstream?.retryAfterS ? { retryAfterS: upstream.retryAfterS } : {}) },
      });
    case 5:
      return new StudixError("PROVIDER_ERROR", `The provider rejected the request${message}`, {
        retryable: false,
        details: info,
      });
    case 6:
      return new StudixError("TIMEOUT", `The provider job is still running${message}`, { details: info });
    case 129:
    case 130:
    case 143:
      return new StudixError("CANCELLED", `multix ${command} was stopped${message}`, { details: info });
    default:
      return new StudixError("PROVIDER_ERROR", `multix ${command} failed${message}`, {
        retryable: upstream?.retryable ?? false,
        details: info,
      });
  }
}
