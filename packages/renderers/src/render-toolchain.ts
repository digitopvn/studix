import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function onPath(bin: string): boolean {
  return spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;
}

/** Mirrors the producer's browser lookup: env override, then the HyperFrames and Puppeteer caches. */
function headlessShellAvailable(env: NodeJS.ProcessEnv): boolean {
  for (const name of ["HYPERFRAMES_BROWSER_PATH", "PRODUCER_HEADLESS_SHELL_PATH"]) {
    const path = env[name];
    if (path) return existsSync(path);
  }
  return [
    join(homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell"),
    join(homedir(), ".cache", "puppeteer", "chrome-headless-shell"),
  ].some((dir) => existsSync(dir) && readdirSync(dir).length > 0);
}

/**
 * Whether this host can run a real HyperFrames render (ffmpeg, ffprobe, chrome-headless-shell); `reason`
 * names what is missing. Tests use it to skip real renders, with that reason, on hosts without the toolchain.
 */
export function renderToolchain(env: NodeJS.ProcessEnv = process.env): { ok: boolean; reason: string } {
  const missing: string[] = [];
  if (!onPath(env.FFMPEG_PATH || "ffmpeg")) missing.push("ffmpeg");
  if (!onPath(env.FFPROBE_PATH || "ffprobe")) missing.push("ffprobe");
  if (!headlessShellAvailable(env))
    missing.push(
      "chrome-headless-shell (npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer)",
    );
  return { ok: missing.length === 0, reason: missing.length ? `missing ${missing.join(", ")}` : "" };
}
