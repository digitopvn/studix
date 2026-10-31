import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export interface ClaudePreflightOptions {
  /** A Claude executable to use instead of the one the SDK bundles for this platform. */
  pathToClaudeCodeExecutable?: string;
  /** Test seams; they default to the running process. */
  platform?: NodeJS.Platform;
  arch?: string;
  preferMusl?: boolean;
  /** Resolves `<package>/claude` the way the SDK does; undefined when the platform package is absent. */
  resolveBundled?: (candidate: string) => string | undefined;
  /** Runs `<executable> --version`; rejects when the binary cannot be launched. */
  run?: (executable: string, timeoutMs: number) => Promise<string>;
  timeoutMs?: number;
}

export type ClaudePreflightResult =
  | { ok: true; executable: string; version: string }
  | { ok: false; reason: string };

function runningOnMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = typeof process.report?.getReport === "function" ? process.report.getReport() : undefined;
  // Same rule as the SDK: without a report the host is treated as glibc.
  return (
    report !== undefined &&
    (report as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime === undefined
  );
}

/** Candidate package names in the order the SDK tries them for a platform. */
function bundledCandidates(platform: NodeJS.Platform, arch: string, preferMusl: boolean): string[] {
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const names =
    platform === "linux"
      ? preferMusl
        ? [`linux-${arch}-musl`, `linux-${arch}`]
        : [`linux-${arch}`, `linux-${arch}-musl`]
      : [`${platform}-${arch}`];
  return names.map((name) => `${SDK_PACKAGE}-${name}/${exe}`);
}

/** The platform packages are optional dependencies of the SDK, so they resolve from the SDK's own location. */
function defaultResolveBundled(candidate: string): string | undefined {
  try {
    const sdkEntry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
    return createRequire(sdkEntry).resolve(candidate);
  } catch {
    return undefined;
  }
}

function defaultRun(executable: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Nothing is inherited from the worker: the check must not see an API key and sends no request.
    execFile(
      executable,
      ["--version"],
      { timeout: timeoutMs, env: { PATH: process.env.PATH ?? "" }, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });
}

/**
 * Check that the Claude process the SDK will spawn can run here: the executable exists, is executable and
 * launches (a binary built for another libc or architecture exists but fails to start). It runs
 * `--version`, which calls no model, so it costs nothing and needs no credential.
 */
export async function preflightClaudeRuntime(
  options: ClaudePreflightOptions = {},
): Promise<ClaudePreflightResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  let executable = options.pathToClaudeCodeExecutable;
  if (executable) {
    if (!existsSync(executable)) {
      return { ok: false, reason: `The configured Claude executable does not exist: ${executable}` };
    }
  } else {
    const candidates = bundledCandidates(platform, arch, options.preferMusl ?? runningOnMusl());
    const resolve = options.resolveBundled ?? defaultResolveBundled;
    for (const candidate of candidates) {
      const found = resolve(candidate);
      if (found && existsSync(found)) {
        executable = found;
        break;
      }
    }
    if (!executable) {
      return {
        ok: false,
        reason: `No Claude binary for ${platform}-${arch} is installed (looked for ${candidates.join(", ")})`,
      };
    }
  }
  if (platform !== "win32") {
    try {
      accessSync(executable, constants.X_OK);
    } catch {
      return { ok: false, reason: `The Claude executable is not executable: ${executable}` };
    }
  }
  try {
    const version = await (options.run ?? defaultRun)(executable, options.timeoutMs ?? 15_000);
    return { ok: true, executable, version };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `The Claude executable at ${executable} failed to launch: ${detail}` };
  }
}
