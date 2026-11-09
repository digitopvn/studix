/*
 * Environment handling of the runner: structured logs, the minimal environment every session command gets, and
 * the toolchain probe of /v1/info. The runner's own secrets never reach a child: buildChildEnv starts from an
 * allow-list, not from process.env.
 */
import { execFile } from "node:child_process";

/** One JSON line per event on stdout. Callers pass names, ids and numbers only, never env values or the token. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

const PASSTHROUGH_NAMES = new Set([
  "PATH",
  "LANG",
  "TZ",
  "PRODUCER_HEADLESS_SHELL_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
]);
const PASSTHROUGH_PREFIXES = ["HYPERFRAMES_", "PYTHON", "PIP_"];

/** Session env names: shell-safe, and never one of the runner's own settings. */
const SESSION_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const RESERVED_SESSION_NAMES = new Set(["PATH", "HOME"]);

export function isAllowedSessionEnvName(name: string): boolean {
  return (
    SESSION_ENV_NAME.test(name) && !RESERVED_SESSION_NAMES.has(name) && !name.startsWith("STUDIX_RUNNER_")
  );
}

/**
 * The environment of a session command: the image toolchain variables from the runner's environment, HOME inside
 * the session's work dir, then the session's own variables (validated at open).
 */
export function buildChildEnv(
  source: NodeJS.ProcessEnv,
  home: string,
  sessionEnv: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || name.startsWith("STUDIX_RUNNER_")) continue;
    if (PASSTHROUGH_NAMES.has(name) || PASSTHROUGH_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      env[name] = value;
    }
  }
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  env.HOME = home;
  // Temp files go under /work with the rest of the session, not to /tmp: TOSE caps a sidecar's /tmp at 1 GiB and
  // evicts the whole Pod past it. Tools that ignore TMPDIR still meet the runner's separate /tmp cap.
  env.TMPDIR = `${home.replace(/\/\.home$/, "")}/.tmp`;
  return { ...env, ...sessionEnv };
}

function firstLine(command: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout: 15_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const line = `${stdout}${stderr}`.split("\n").find((entry) => entry.trim() !== "");
      resolve(error || !line ? "missing" : line.trim().slice(0, 200));
    });
  });
}

/** Versions of the image toolchain, probed once at startup. A tool that fails to answer reports "missing". */
export async function detectToolchain(env: Record<string, string>): Promise<Record<string, string>> {
  const chrome = env.PRODUCER_HEADLESS_SHELL_PATH;
  const [node, ffmpeg, chromeVersion, hyperframes, multix, codex] = await Promise.all([
    firstLine("node", ["-v"], env),
    firstLine("ffmpeg", ["-version"], env),
    chrome ? firstLine(chrome, ["--version"], env) : Promise.resolve("missing"),
    firstLine("hyperframes", ["--version"], env),
    firstLine("multix", ["--version"], env),
    firstLine("codex", ["--version"], env),
  ]);
  return { node, ffmpeg, chrome: chromeVersion, hyperframes, multix, codex };
}
