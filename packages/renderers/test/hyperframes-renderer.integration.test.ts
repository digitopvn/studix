import { existsSync } from "node:fs";
import { resolveRenderSpec } from "@studix/video-ir";
import { afterAll, describe, expect, it } from "vitest";
import { FfmpegProbe, HyperFramesRenderer } from "../src/index.ts";
import { loadIrFixture, renderToolchain, tempDir } from "./render-test-helpers.ts";

const toolchain = renderToolchain();
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

// Skips (with the missing tool in the title) only when the host lacks Chromium or FFmpeg.
describe.skipIf(!toolchain.ok)(
  `HyperFramesRenderer real render${toolchain.ok ? "" : ` (skipped: ${toolchain.reason})`}`,
  () => {
    const renderer = new HyperFramesRenderer({ workers: 1 });
    // Preview preset at 12fps keeps the 15s golden fixture to ~180 frames at 540x960.
    const spec = resolveRenderSpec("preview", { fps: 12 });

    it("renders the brand-intro golden fixture to a verified MP4", async () => {
      const ir = loadIrFixture("brand-intro-9x16");
      const { dir, cleanup } = await tempDir("render");
      cleanups.push(cleanup);
      const progress: { progress: number; phase: string }[] = [];

      const output = await renderer.render(ir, {
        spec,
        workDir: dir,
        assetFiles: {},
        onProgress: (p) => {
          progress.push(p);
        },
      });

      expect(output.mime).toBe("video/mp4");
      expect(existsSync(output.filePath)).toBe(true);
      expect(existsSync(`${dir}/capture.raw.mp4`)).toBe(false);
      expect(output.probe).toMatchObject({ width: 540, height: 960, videoCodec: "h264", audioCodec: "aac" });
      expect(Math.abs(output.probe.durationMs - 15000)).toBeLessThanOrEqual(200);

      // An independent probe of the file agrees with what the renderer reported.
      const reprobe = await new FfmpegProbe().probe(output.filePath);
      expect(reprobe).toEqual(output.probe);

      const values = progress.map((p) => p.progress);
      expect(values.at(-1)).toBe(1);
      expect(values).toEqual([...values].sort((a, b) => a - b));
      expect(new Set(progress.map((p) => p.phase))).toContain("capture");
    });

    it("stops with CANCELLED when aborted mid-render", async () => {
      const ir = loadIrFixture("brand-intro-9x16");
      const { dir, cleanup } = await tempDir("render-abort");
      cleanups.push(cleanup);
      const controller = new AbortController();
      let abortedAt = 0;
      let lastProgress = 0;
      const pending = renderer.render(ir, {
        spec,
        workDir: dir,
        assetFiles: {},
        signal: controller.signal,
        onProgress: (p) => {
          lastProgress = p.progress;
          // Abort once frame capture is underway (phase names during capture come from the producer).
          if (!abortedAt && p.progress > 0.1) {
            abortedAt = p.progress;
            controller.abort();
          }
        },
      });
      await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
      expect(abortedAt).toBeGreaterThan(0);
      // The producer honours the signal: the run stops before finishing, not after a full capture.
      expect(lastProgress).toBeLessThan(0.9);
      expect(existsSync(`${dir}/render-preview.mp4`)).toBe(false);
    });

    it("inspects html hero cards: a clean card passes, an overflowing one is reported", async () => {
      const { dir, cleanup } = await tempDir("inspect");
      cleanups.push(cleanup);
      const ir = loadIrFixture("brand-intro-9x16");
      // No html shots: nothing is launched or written.
      expect(await renderer.inspect(ir, { spec, workDir: dir })).toEqual({ issues: [], snapshots: [] });
      expect(existsSync(`${dir}/inspect`)).toBe(false);

      const clean =
        "<style>.card { position: absolute; inset: 15% 10%; display: grid; place-items: center; background: var(--color-primary); border-radius: 24px; } h1 { margin: 0; font: 800 48px var(--font-heading); }</style>" +
        '<div class="card" data-enter="pop"><h1 data-enter="slide-up">Mỗi sáng</h1></div>';
      const overflowing =
        "<style>h1 { position: absolute; left: -40px; top: 40%; margin: 0; font-size: 90px; white-space: nowrap; }</style>" +
        '<h1 data-enter="slide-left">Quá dài để vừa khung hình</h1>';
      ir.scenes[0]!.shots = [{ id: "hero-clean", type: "html", startMs: 0, durationMs: 3000, html: clean }];
      ir.scenes[1]!.shots = [
        { id: "hero-wide", type: "html", startMs: 0, durationMs: 4000, html: overflowing },
      ];

      const { issues, snapshots } = await renderer.inspect(ir, { spec, workDir: dir });
      expect(issues.filter((i) => i.shotId === "hero-clean")).toEqual([]);
      expect(issues).toContainEqual(
        expect.objectContaining({ sceneId: "intro", shotId: "hero-wide", code: "overflow" }),
      );
      expect(snapshots.map((s) => [s.shotId, s.atMs])).toEqual([
        ["hero-clean", 730],
        ["hero-wide", 3650],
      ]);
      for (const s of snapshots) expect(existsSync(s.filePath)).toBe(true);
    });
  },
);
