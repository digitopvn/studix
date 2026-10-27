import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { unwrapValidation, type VideoIR, validateVideoIR } from "@studix/video-ir";

const require = createRequire(import.meta.url);

/** A golden fixture from @studix/video-ir, validated. */
export function loadIrFixture(name: string): VideoIR {
  const path = require.resolve(`@studix/video-ir/fixtures/${name}.json`);
  return unwrapValidation(validateVideoIR(JSON.parse(readFileSync(path, "utf8"))), `fixture ${name}`);
}

/** Smallest valid PNG (1x1, opaque). */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

export async function tempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `studix-${prefix}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writePng(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, PNG_1X1);
  return path;
}

function onPath(bin: string): boolean {
  return spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;
}

/** Mirrors the producer's browser lookup: env override, then the HyperFrames and Puppeteer caches. */
function headlessShellAvailable(): boolean {
  for (const name of ["HYPERFRAMES_BROWSER_PATH", "PRODUCER_HEADLESS_SHELL_PATH"]) {
    const path = process.env[name];
    if (path) return existsSync(path);
  }
  return [
    join(homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell"),
    join(homedir(), ".cache", "puppeteer", "chrome-headless-shell"),
  ].some((dir) => existsSync(dir) && readdirSync(dir).length > 0);
}

/** Whether this machine can run a real render; `reason` explains what is missing. */
export function renderToolchain(): { ok: boolean; reason: string } {
  const missing: string[] = [];
  if (!onPath(process.env.FFMPEG_PATH ?? "ffmpeg")) missing.push("ffmpeg");
  if (!onPath(process.env.FFPROBE_PATH ?? "ffprobe")) missing.push("ffprobe");
  if (!headlessShellAvailable())
    missing.push(
      "chrome-headless-shell (npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer)",
    );
  return { ok: missing.length === 0, reason: missing.length ? `missing ${missing.join(", ")}` : "" };
}
