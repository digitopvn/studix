import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSpeechProbe, qaToolchainStatus, resolveQaToolchain } from "../src/index.ts";

/**
 * The speech probe over the real `speech` tool. On the default image (no `vad` extra) it must reject, never
 * report a file as clean; where the extra is installed it measures real audio. Skipped with a reason on hosts
 * without the QA venv or ffmpeg.
 */
const toolchain = resolveQaToolchain();
const status = qaToolchainStatus(toolchain);
const hasVad =
  status.ok &&
  spawnSync(toolchain.python, ["-I", "-c", "import silero_vad"], { stdio: "ignore" }).status === 0;

let dir = "";
let noise = "";

beforeAll(() => {
  if (!status.ok) return;
  dir = mkdtempSync(join(tmpdir(), "studix-speech-"));
  noise = join(dir, "wind.wav");
  const made = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=d=2:c=pink:r=24000:a=0.3",
    noise,
  ]);
  if (made.status !== 0) throw new Error(`ffmpeg failed: ${made.stderr?.toString()}`);
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(status.ok)("speech probe", () => {
  const probe = createSpeechProbe({ toolchain, timeoutMs: 120_000, sandboxRoot: tmpdir() });

  it.skipIf(hasVad)("rejects with UNAVAILABLE on an image without the vad extra", async () => {
    await expect(probe.measure(noise, new AbortController().signal)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it.runIf(hasVad)("finds no speech in clean noise", async () => {
    const result = await probe.measure(noise, new AbortController().signal);
    expect(result.speechMs).toBe(0);
    expect(result.durationMs).toBeGreaterThan(1900);
  });
});
