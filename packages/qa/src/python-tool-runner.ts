import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type ErrorCode, StudixError } from "@studix/shared";
import { z } from "zod";
import type { QaToolchain } from "./qa-toolchain.ts";

export const MEDIA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EXTRA_ENV_KEY = /^STUDIX_QA_[A-Z0-9_]+$/;
const MAX_GRANTS = 256;
const DEFAULT_MAX_STDOUT = 16 * 1024 * 1024;
const STDERR_TAIL = 16 * 1024;
/** After the tool's own deadline the worker waits this long for its JSON answer before killing the tree. */
const KILL_GRACE_MS = 5000;

export interface PythonToolRunOptions {
  toolchain: QaToolchain;
  /** Media the run may read: grant id -> path. Each must be an existing regular file. */
  media?: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Address-space cap of the tool process (POSIX). */
  memoryMb?: number;
  signal?: AbortSignal;
  /** Parent of the per-run sandbox directory; defaults to the OS temp directory. */
  sandboxRoot?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Files the tool writes are copied here before the sandbox is removed; without it they are discarded. */
  outputDir?: string;
  /** Extra non-secret settings for the tool, keys matching STUDIX_QA_*. */
  extraEnv?: Readonly<Record<string, string>>;
  maxStdoutBytes?: number;
  /** How long past `timeoutMs` to wait for the tool's own TIMEOUT answer before killing the tree. */
  killGraceMs?: number;
}

export interface PythonToolRun {
  result: unknown;
  /** Absolute paths of the files copied to `outputDir`. */
  outputs: string[];
}

const Envelope = z.union([
  z.object({ ok: z.literal(true), tool: z.string(), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    tool: z.string(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);

const TOOL_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "VALIDATION",
  "NOT_FOUND",
  "UNAVAILABLE",
  "TIMEOUT",
  "INTERNAL",
]);

/** Resolve and check every grant; the tool receives real paths of regular files only. */
export async function resolveGrants(
  media: Readonly<Record<string, string>> = {},
): Promise<Record<string, string>> {
  const entries = Object.entries(media);
  if (entries.length > MAX_GRANTS) throw new StudixError("VALIDATION", `at most ${MAX_GRANTS} media grants`);
  const out: Record<string, string> = {};
  for (const [id, path] of entries) {
    if (!MEDIA_ID.test(id)) throw new StudixError("VALIDATION", `media id "${id}" must match ${MEDIA_ID}`);
    if (typeof path !== "string" || !isAbsolute(path))
      throw new StudixError("VALIDATION", `media "${id}" must be an absolute path`);
    let real: string;
    try {
      real = await realpath(path);
    } catch (err) {
      throw new StudixError("NOT_FOUND", `media "${id}" does not exist`, {
        cause: err,
        retryable: false,
        details: { media: id },
      });
    }
    if (!(await stat(real)).isFile())
      throw new StudixError("VALIDATION", `media "${id}" is not a regular file`, { details: { media: id } });
    out[id] = real;
  }
  return out;
}

/**
 * Only what Python and the media binaries need. Nothing of the worker's environment (database URL, storage and
 * provider keys) reaches the tool; HOME and the temp variables point into the sandbox.
 */
function sandboxEnv(work: string, out: string, options: PythonToolRunOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (!EXTRA_ENV_KEY.test(key))
      throw new StudixError("VALIDATION", `extra env "${key}" must match STUDIX_QA_*`);
    env[key] = value;
  }
  Object.assign(env, {
    HOME: work,
    USERPROFILE: work,
    TMPDIR: work,
    TEMP: work,
    TMP: work,
    STUDIX_QA_OUT: out,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    // glibc reserves address space per thread arena; two arenas keep the memory cap meaningful.
    MALLOC_ARENA_MAX: "2",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
  });
  if (options.ffmpegPath) env.FFMPEG_PATH = options.ffmpegPath;
  if (options.ffprobePath) env.FFPROBE_PATH = options.ffprobePath;
  return env;
}

/** Kill the tool and everything it started (ffmpeg children included). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // the tool leads its own process group (detached)
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

interface RawRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function spawnTool(
  options: PythonToolRunOptions,
  tool: string,
  request: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RawRun> {
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new StudixError("CANCELLED", `QA tool ${tool} cancelled before start`));
      return;
    }
    const child = spawn(options.toolchain.python, [...options.toolchain.args, tool], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let failure: StudixError | undefined;
    let settled = false;

    const stop = (err: StudixError) => {
      if (failure) return;
      failure = err;
      killTree(child.pid);
    };
    const timer = setTimeout(
      () => stop(new StudixError("TIMEOUT", `QA tool ${tool} timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs + (options.killGraceMs ?? KILL_GRACE_MS),
    );
    const onAbort = () => stop(new StudixError("CANCELLED", `QA tool ${tool} cancelled`));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        stop(new StudixError("INTERNAL", `QA tool ${tool} printed more than ${maxStdout} bytes`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    // A tool that exits before reading its request closes stdin early; the exit code reports that.
    child.stdin.on("error", () => {});
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          err.code === "ENOENT"
            ? new StudixError("UNAVAILABLE", `QA Python interpreter not found: ${options.toolchain.python}`, {
                cause: err,
                retryable: false,
                suggestedAction:
                  "Run `pnpm test:qa` (creates tools/qa/.venv) or set STUDIX_QA_PYTHON to the image's QA interpreter.",
              })
            : new StudixError("INTERNAL", `failed to start QA tool ${tool}: ${err.message}`, { cause: err }),
        ),
      );
    });
    // "close" fires after the process exited and its pipes drained, so the sandbox is no longer in use.
    child.on("close", (code) =>
      finish(() => {
        if (failure) reject(failure);
        else resolvePromise({ exitCode: code, stdout: Buffer.concat(stdout).toString("utf8"), stderr });
      }),
    );
    child.stdin.end(request);
  });
}

function toStudixError(tool: string, error: { code: string; message: string; details?: unknown }) {
  const code = TOOL_ERROR_CODES.has(error.code as ErrorCode) ? (error.code as ErrorCode) : "INTERNAL";
  return new StudixError(code, `QA tool ${tool}: ${error.message}`, {
    retryable: code === "TIMEOUT" ? true : code === "INTERNAL" ? undefined : false,
    details: { tool, ...(error.details && typeof error.details === "object" ? error.details : {}) },
  });
}

/**
 * Run one Python QA tool in its own sandbox: a fresh 0700 directory (cwd, HOME and temp inside it), a scrubbed
 * environment, read access only to the granted media, a deadline enforced by the tool and, past a grace period,
 * by killing the whole process tree. The sandbox is removed whatever happens.
 */
export async function runPythonTool(
  tool: string,
  input: unknown,
  options: PythonToolRunOptions,
): Promise<PythonToolRun> {
  if (!/^[a-z][a-z0-9-]*$/.test(tool)) throw new StudixError("VALIDATION", `invalid QA tool name "${tool}"`);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new StudixError("VALIDATION", "timeoutMs must be > 0");
  const grants = await resolveGrants(options.media);
  const root = options.sandboxRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const sandbox = await mkdtemp(join(root, "studix-qa-"));
  try {
    const work = join(sandbox, "work");
    const out = join(sandbox, "out");
    await mkdir(work, { mode: 0o700 });
    await mkdir(out, { mode: 0o700 });
    const request = JSON.stringify({
      input,
      media: grants,
      timeoutS: options.timeoutMs / 1000,
      memoryMb: options.memoryMb,
    });
    const raw = await spawnTool(options, tool, request, work, sandboxEnv(work, out, options));
    let envelope: z.infer<typeof Envelope>;
    try {
      envelope = Envelope.parse(JSON.parse(raw.stdout));
    } catch (err) {
      throw new StudixError("INTERNAL", `QA tool ${tool} did not answer in JSON (exit ${raw.exitCode})`, {
        cause: err,
        details: { tool, stderr: raw.stderr.slice(-2000) },
      });
    }
    if (!envelope.ok) throw toStudixError(tool, envelope.error);
    if (raw.exitCode !== 0)
      throw new StudixError("INTERNAL", `QA tool ${tool} reported success but exited ${raw.exitCode}`, {
        details: { tool, stderr: raw.stderr.slice(-2000) },
      });
    const outputs: string[] = [];
    if (options.outputDir) {
      const files = (await readdir(out, { withFileTypes: true })).filter((f) => f.isFile());
      if (files.length) await mkdir(options.outputDir, { recursive: true });
      for (const f of files) {
        const dest = join(options.outputDir, f.name);
        await copyFile(join(out, f.name), dest);
        outputs.push(dest);
      }
    }
    return { result: envelope.result, outputs };
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 });
  }
}
