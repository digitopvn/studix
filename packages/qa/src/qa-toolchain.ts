import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** How to start the QA tools: `<python> <...args> <tool>`. */
export interface QaToolchain {
  python: string;
  args: readonly string[];
}

/** `-I`: isolated mode, so neither the working directory nor user site-packages can shadow a module. */
export const QA_MODULE_ARGS: readonly string[] = ["-I", "-m", "studix_qa"];

/** tools/qa/.venv, created by `uv sync` (`pnpm test:qa` locally, the Dockerfile in the image). */
export function defaultQaPython(platform: NodeJS.Platform = process.platform): string {
  const venv = fileURLToPath(new URL("../../../tools/qa/.venv/", import.meta.url));
  return platform === "win32" ? `${venv}Scripts\\python.exe` : `${venv}bin/python`;
}

/** STUDIX_QA_PYTHON overrides the interpreter (it must have the studix-qa package installed). */
export function resolveQaToolchain(env: NodeJS.ProcessEnv = process.env): QaToolchain {
  return { python: env.STUDIX_QA_PYTHON || defaultQaPython(), args: QA_MODULE_ARGS };
}

function runs(bin: string, args: string[]): boolean {
  return spawnSync(bin, args, { stdio: "ignore", windowsHide: true, timeout: 30_000 }).status === 0;
}

/**
 * Whether this host can run the QA tools for real (interpreter with studix-qa, ffmpeg, ffprobe); `reason` names
 * what is missing. Tests use it to skip, with that reason, on hosts without the toolchain.
 */
export function qaToolchainStatus(
  toolchain: QaToolchain = resolveQaToolchain(),
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; reason: string } {
  const missing: string[] = [];
  if (!existsSync(toolchain.python) || !runs(toolchain.python, [...toolchain.args, "--list"]))
    missing.push(`QA Python at ${toolchain.python} (run \`pnpm test:qa\` or set STUDIX_QA_PYTHON)`);
  if (!runs(env.FFMPEG_PATH || "ffmpeg", ["-version"])) missing.push("ffmpeg");
  if (!runs(env.FFPROBE_PATH || "ffprobe", ["-version"])) missing.push("ffprobe");
  return { ok: missing.length === 0, reason: missing.length ? `missing ${missing.join(", ")}` : "" };
}
