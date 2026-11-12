import { existsSync } from "node:fs";
import { resolveRenderSpec } from "@studix/video-ir";
import { afterAll, describe, expect, it } from "vitest";
import { FfmpegProbe, HyperFramesRenderer } from "../src/index.ts";
import { cardIr, writeCard } from "./html-card-fixture.ts";
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

    it("renders an HTML hero card between a scene's depth planes", async () => {
      const { dir, cleanup } = await tempDir("render-card");
      cleanups.push(cleanup);
      const file = await writeCard(dir);
      const ir = cardIr(file);
      // The hero scene moves a camera and draws depth planes in front of and behind the card.
      ir.scenes = ir.scenes.map((scene, i) => ({
        ...scene,
        camera: i === 0 ? "static" : "push-in",
        depth: { background: ["glow", "grain"], foreground: ["corners"] },
        motif: { shape: "ring", color: "accent" },
      }));
      const output = await renderer.render(ir, { spec, workDir: dir, assetFiles: { "hero-card": file } });
      expect(output.probe).toMatchObject({ width: 270, height: 480, videoCodec: "h264" });
      expect(Math.abs(output.probe.durationMs - 4000)).toBeLessThanOrEqual(200);
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
  },
);
