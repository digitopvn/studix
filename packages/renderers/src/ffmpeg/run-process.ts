import { spawn } from "node:child_process";
import { StudixError } from "@studix/shared";

export interface RunProcessOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Cap per stream so a chatty binary cannot exhaust memory; the tail is kept. */
  maxOutputBytes?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Only what media binaries need; credentials in the worker environment never reach child processes. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * Run a binary with an argv array (never a shell string). Resolves with the exit code; rejects with
 * CANCELLED on abort, TIMEOUT on deadline and UNAVAILABLE when the binary is missing.
 */
export function runProcess(
  bin: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  const max = options.maxOutputBytes ?? 1_000_000;
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new StudixError("CANCELLED", `${bin} cancelled before start`));
      return;
    }
    const child = spawn(bin, args, { env: scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const keepTail = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      return next.length > max ? next.slice(-max) : next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keepTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = keepTail(stderr, chunk);
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      child.kill("SIGTERM");
      // Escalate if the process ignores SIGTERM.
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2000).unref();
    };
    const onAbort = () => {
      kill();
      finish(() => reject(new StudixError("CANCELLED", `${bin} cancelled`)));
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new StudixError("TIMEOUT", `${bin} timed out after ${options.timeoutMs}ms`)));
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          err.code === "ENOENT"
            ? new StudixError("UNAVAILABLE", `${bin} is not installed or not on PATH`, {
                cause: err,
                retryable: false,
                suggestedAction: "Install FFmpeg (ffmpeg + ffprobe) or set FFMPEG_PATH / FFPROBE_PATH.",
              })
            : new StudixError("INTERNAL", `Failed to start ${bin}: ${err.message}`, { cause: err }),
        ),
      );
    });
    child.on("close", (code) => finish(() => resolvePromise({ exitCode: code ?? -1, stdout, stderr })));
  });
}
