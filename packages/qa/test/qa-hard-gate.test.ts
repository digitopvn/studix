import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgeCatalog } from "@studix/skills";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHardQaGate, hardChecksFor, qaToolchainStatus, resolveQaToolchain } from "../src/index.ts";

const packChecks = knowledgeCatalog.hardChecks();
const ids = (checks: { id: string }[]) => checks.map((c) => c.id);

describe("hardChecksFor", () => {
  it("adds the bound hard checks of the declared packs to the default gate", () => {
    const { checks, unbound } = hardChecksFor(
      { durationMs: 20_000, fps: 30, requireAudio: true, knowledge: ["production-failure-modes"] },
      packChecks,
    );
    expect(ids(checks)).toEqual(
      expect.arrayContaining([
        "loudness",
        "duration",
        "production-failure-modes.delivery-true-peak",
        "production-failure-modes.leading-black",
      ]),
    );
    expect(checks.find((c) => c.id === "duration")).toMatchObject({ metric: "probe.durationS" });
    // Checks no tool measures yet come back named, never silently dropped.
    expect(unbound.length).toBeGreaterThan(0);
    expect(unbound.every((u) => u.message.length > 0)).toBe(true);
  });

  it("uses only the defaults for a stage that declares no packs", () => {
    const { checks, unbound } = hardChecksFor({ durationMs: 6_000, fps: 30, requireAudio: true }, packChecks);
    expect(checks.some((c) => c.id.startsWith("production-failure-modes."))).toBe(false);
    expect(unbound).toEqual([]);
  });

  it("leaves the sound checks out of a silent render", () => {
    const { checks } = hardChecksFor(
      { durationMs: 6_000, fps: 30, requireAudio: false, knowledge: ["production-failure-modes"] },
      packChecks,
    );
    expect(checks.some((c) => c.metric.startsWith("loudness.") || c.metric.startsWith("sync."))).toBe(false);
    expect(ids(checks)).toContain("production-failure-modes.leading-black");
  });
});

const status = qaToolchainStatus();

describe.skipIf(!status.ok)(
  `hard QA gate on real media${status.ok ? "" : ` (skipped: ${status.reason})`}`,
  () => {
    let dir: string;
    let file: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "studix-qa-gate-"));
      file = join(dir, "silent.mkv");
      const made = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=30:d=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        file,
      ]);
      if (made.status !== 0) throw new Error(`ffmpeg failed: ${made.stderr?.toString()}`);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const gate = () =>
      createHardQaGate({
        run: { toolchain: resolveQaToolchain(), sandboxRoot: join(dir, "sandboxes") },
        hardChecks: () => knowledgeCatalog.hardChecks(),
      });

    it("passes a silent render that matches its expectation", async () => {
      const report = await gate().assertPasses(
        file,
        { durationMs: 2_000, fps: 30, requireAudio: false, knowledge: ["production-failure-modes"] },
        new AbortController().signal,
      );
      expect(report).toMatchObject({ pass: true });
    });

    it("blocks a render that should carry sound, or is the wrong length", async () => {
      const signal = new AbortController().signal;
      await expect(
        gate().assertPasses(file, { durationMs: 2_000, fps: 30, requireAudio: true }, signal),
      ).rejects.toMatchObject({ code: "VALIDATION", retryable: false });
      await expect(
        gate().assertPasses(file, { durationMs: 5_000, fps: 30, requireAudio: false }, signal),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });
  },
);
