import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageContext } from "@studix/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createQaStages,
  defaultHardChecks,
  type QaGateRunOptions,
  qaToolchainStatus,
  resolveQaToolchain,
  runHardGate,
} from "../src/index.ts";

/**
 * The real tools (tools/qa through the sandbox runner) on media made from lavfi sources: no provider, no network.
 * Skipped with a reason on hosts without the QA venv or ffmpeg; CI sets STUDIX_QA_REQUIRE_TOOLCHAIN=1 so a
 * missing toolchain fails instead.
 */
const status = qaToolchainStatus();
const required = process.env.STUDIX_QA_REQUIRE_TOOLCHAIN === "1";

it.runIf(required)("QA toolchain is installed", () => {
  expect(status.ok, status.reason).toBe(true);
});

function ffmpeg(args: string[]): void {
  const result = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-y", ...args]);
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr?.toString()}`);
}

/** 3 s of 320x180 H.264 at 24 fps with a mono PCM 997 Hz tone (0.282 is about -14 LUFS). */
function avFile(path: string, audio: string, options: { audioOffsetS?: number; videoFilter?: string } = {}) {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=24:d=3",
    ...(options.audioOffsetS ? ["-itsoffset", String(options.audioOffsetS)] : []),
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='${audio}':s=48000:d=3`,
    "-map",
    "0:v",
    "-map",
    "1:a",
    ...(options.videoFilter ? ["-vf", options.videoFilter] : []),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "pcm_s16le",
    path,
  ]);
  return path;
}

describe.skipIf(!status.ok)(`QA hard gate on real media${status.ok ? "" : ` (skipped: ${status.reason})`}`, () => {
  let dir: string;
  const files: Record<string, string> = {};
  const run: QaGateRunOptions = { toolchain: resolveQaToolchain() };
  const checks = defaultHardChecks({ durationS: 3, fps: 24 });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "studix-qa-e2e-"));
    run.sandboxRoot = join(dir, "sandboxes");
    files.good = avFile(join(dir, "good.mkv"), "0.282*sin(2*PI*997*t)");
    // A 0.9 sample once a second on the -14 LUFS tone: loudness on target, true peak about -0.9 dBTP.
    files.hot = avFile(join(dir, "hot.mkv"), "0.282*sin(2*PI*997*t)+0.9*eq(mod(n\\,48000)\\,0)");
    files.quiet = avFile(join(dir, "quiet.mkv"), "0.141*sin(2*PI*997*t)");
    files.late = avFile(join(dir, "late.mkv"), "0.282*sin(2*PI*997*t)", { audioOffsetS: 0.25 });
    files.black = avFile(join(dir, "black.mkv"), "0.282*sin(2*PI*997*t)", {
      videoFilter: "drawbox=c=black:t=fill:enable='lt(t,1)'",
    });
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const failed = async (file: string) => (await runHardGate(file, checks, run)).failures.map((f) => f.id);

  it("passes a file inside every limit", async () => {
    const report = await runHardGate(files.good!, checks, run);
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.measurements.loudness?.integratedLufs).toBeCloseTo(-14, 0);
  });

  it("blocks a true peak over -1.5 dBTP", async () => {
    expect(await failed(files.hot!)).toEqual(["true-peak"]);
  });

  it("blocks loudness off -14 LUFS +/-1", async () => {
    expect(await failed(files.quiet!)).toEqual(["loudness"]);
  });

  it("blocks a muxed audio offset and a leading black", async () => {
    expect(await failed(files.late!)).toContain("av-sync");
    expect(await failed(files.black!)).toEqual(["leading-black"]);
  });

  it("the check stage fails on a hard-gate failure and records evidence without blocking", async () => {
    const reports = [
      { agent: "A", render: { file: "good.mkv", verdict: "FAIL", score: 4 } },
      { agent: "B", render: { file: "good.mkv", verdict: "PASS", score: 8 } },
    ];
    const stageFor = (file: string) =>
      createQaStages({
        file: () => file,
        checks: () => checks,
        evidence: () => ({ prescan: { audio: true }, judgeReports: { reports } }),
        run,
      })[0]!;
    const stage = { signal: new AbortController().signal } as unknown as StageContext;

    await expect(stageFor(files.hot!).run(stage)).rejects.toMatchObject({ code: "VALIDATION", retryable: false });

    const { output } = await stageFor(files.good!).run(stage);
    const evidence = output.evidence as { blocking: boolean; items: { source: string; findings: string[] }[] };
    expect((output.hard as { pass: boolean }).pass).toBe(true);
    expect(evidence.blocking).toBe(false);
    expect(evidence.items.map((i) => i.source)).toEqual(["prescan.audio", "judge-reports"]);
    expect(evidence.items[1]!.findings.some((f) => f.includes("verdict FAIL"))).toBe(true);
  });
});
