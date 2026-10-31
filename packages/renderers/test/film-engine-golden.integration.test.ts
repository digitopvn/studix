import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@studix/shared";
import { resolveRenderSpec, unwrapValidation, validateVideoIR } from "@studix/video-ir";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FILM_SCENE_MIME,
  filmPlateScene,
  HyperFramesRenderer,
  renderFilmCompositions,
} from "../src/index.ts";
import { filmSceneIr, writeFilmSceneAssets } from "./film-scene-fixture.ts";
import { renderToolchain, tempDir } from "./render-test-helpers.ts";

/**
 * Golden render of the ported film engine on software WebGL (SwiftShader through ANGLE, no GPU): the same scene
 * captured twice must give identical frames, and its per-frame mean luma must match the committed golden.
 * Set UPDATE_FILM_GOLDEN=1 to rewrite the golden after an intended engine change.
 */
const toolchain = renderToolchain();
const GOLDEN = join(import.meta.dirname, "__golden__", "film-scene-luma.json");
const LUMA_TOLERANCE = 4;
const log = createLogger({ component: "film-golden" }, { level: "warn" });

function ffmpeg(args: string[]): string {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.toString()}`);
  return `${result.stdout.toString()}\n${result.stderr.toString()}`;
}

/** One md5 per decoded frame. */
function frameHashes(file: string): string[] {
  return ffmpeg(["-v", "error", "-i", file, "-f", "framemd5", "-"])
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").pop()!.trim());
}

/** Mean luma (0..255) of every frame. */
function frameLuma(file: string): number[] {
  const out = ffmpeg([
    "-v",
    "info",
    "-i",
    file,
    "-vf",
    "signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f",
    "null",
    "-",
  ]);
  return [...out.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map(
    (m) => Math.round(Number(m[1]) * 10) / 10,
  );
}

describe.skipIf(!toolchain.ok)(`film engine golden render ${toolchain.reason}`, () => {
  let dir = "";
  let cleanup: () => Promise<void> = async () => undefined;
  let fixture: Awaited<ReturnType<typeof writeFilmSceneAssets>>;
  const previousGpuMode = process.env.PRODUCER_BROWSER_GPU_MODE;

  beforeAll(async () => {
    // The capture must not depend on a GPU: pin the producer's software WebGL path.
    process.env.PRODUCER_BROWSER_GPU_MODE = "software";
    ({ dir, cleanup } = await tempDir("film-golden"));
    fixture = await writeFilmSceneAssets(dir);
  });
  afterAll(async () => {
    if (previousGpuMode === undefined) delete process.env.PRODUCER_BROWSER_GPU_MODE;
    else process.env.PRODUCER_BROWSER_GPU_MODE = previousGpuMode;
    await cleanup();
  });

  const capture = async (workDir: string): Promise<string> => {
    const ir = filmSceneIr(fixture.assets);
    const result = await renderFilmCompositions({
      ir,
      assetFiles: fixture.assetFiles,
      workDir,
      fps: 12,
      quality: "draft",
      crf: 18,
      logger: log,
    });
    const shot = result.ir.scenes[0]!.shots[0]!;
    expect(shot.type).toBe("video");
    return result.assetFiles[shot.type === "video" ? shot.assetId : ""]!;
  };

  it("captures the scene deterministically and matches the luma golden", async () => {
    const first = await capture(join(dir, "a"));
    const second = await capture(join(dir, "b"));
    const hashes = frameHashes(first);
    expect(hashes).toHaveLength(30);
    expect(frameHashes(second)).toEqual(hashes);

    const luma = frameLuma(first);
    expect(luma).toHaveLength(30);
    // Fades from and to black; the set, the cel and the caption are visible in between.
    expect(luma[0]!).toBeLessThan(luma[6]!);
    expect(Math.min(...luma.slice(4, 26))).toBeGreaterThan(30);
    // The camera flies through the set: the gl shot's frames are not a still.
    expect(new Set(hashes.slice(3, 14)).size).toBeGreaterThan(8);

    if (process.env.UPDATE_FILM_GOLDEN === "1")
      writeFileSync(GOLDEN, `${JSON.stringify({ fps: 12, luma }, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { luma: number[] };
    expect(golden.luma).toHaveLength(luma.length);
    for (const [i, value] of luma.entries()) {
      expect(Math.abs(value - golden.luma[i]!), `frame ${i}`).toBeLessThanOrEqual(LUMA_TOLERANCE);
    }
  });

  it("captures a plate scene (a still with a camera push and weather) deterministically and in motion", async () => {
    const pkg = filmPlateScene({
      imageAssetId: "cel-a",
      durationMs: 2000,
      fps: 12,
      width: 320,
      height: 180,
      push: 1.12,
      focus: [0.3, 0.4],
      weather: "petal",
    });
    const file = join(dir, "plate.json");
    writeFileSync(file, JSON.stringify(pkg));
    const cel = fixture.assets.find((a) => a.id === "cel-a")!;
    const ir = unwrapValidation(
      validateVideoIR({
        schemaVersion: 1,
        title: "Plate scene",
        language: "vi",
        format: { aspectRatio: "16:9", width: 320, height: 180, fps: 12, durationMs: 2000 },
        assets: [
          cel,
          {
            id: "plate",
            kind: "code",
            storageKey: "test/plate.json",
            sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
            mime: FILM_SCENE_MIME,
            assetVersionId: "asv_plate_1",
            provenance: { source: "generated" },
          },
        ],
        scenes: [
          {
            id: "scene-1",
            role: "body",
            durationMs: 2000,
            shots: [
              { id: "plate-shot", type: "composition", startMs: 0, durationMs: 2000, assetId: "plate" },
            ],
          },
        ],
        timeline: { entries: [{ sceneId: "scene-1", startMs: 0 }] },
      }),
      "plate IR",
    );
    const assetFiles = { "cel-a": fixture.assetFiles["cel-a"]!, plate: file };
    const capturePlate = async (workDir: string) => {
      const result = await renderFilmCompositions({
        ir,
        assetFiles,
        workDir,
        fps: 12,
        quality: "draft",
        crf: 18,
        logger: log,
      });
      const shot = result.ir.scenes[0]!.shots[0]!;
      expect(shot.type).toBe("video");
      return result.assetFiles[shot.type === "video" ? shot.assetId : ""]!;
    };
    const hashes = frameHashes(await capturePlate(join(dir, "plate-a")));
    expect(hashes).toHaveLength(24);
    expect(frameHashes(await capturePlate(join(dir, "plate-b")))).toEqual(hashes);
    // The push and the drifting petals move every frame.
    expect(new Set(hashes).size).toBeGreaterThan(20);
  });

  it("renders an IR whose shot is a film scene through the HyperFrames renderer", async () => {
    const ir = filmSceneIr(fixture.assets, { push: 1.08 });
    const out = await new HyperFramesRenderer({ logger: log }).render(ir, {
      spec: resolveRenderSpec("preview", { fps: 12 }),
      workDir: join(dir, "render"),
      assetFiles: fixture.assetFiles,
    });
    expect(out.probe.durationMs).toBeGreaterThanOrEqual(2400);
    expect(out.probe.durationMs).toBeLessThanOrEqual(2600);
    expect(out.probe.fps).toBe(12);
    expect(Math.max(...frameLuma(out.filePath))).toBeGreaterThan(40);
  });
});
