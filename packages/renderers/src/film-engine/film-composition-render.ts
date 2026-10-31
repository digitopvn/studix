import { createHash } from "node:crypto";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "@studix/shared";
import { StudixError } from "@studix/shared";
import type { AssetRef, Shot, VideoIR } from "@studix/video-ir";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, writeComposition } from "../hyperframes/compile-composition.ts";
import { renderWithProducer } from "../hyperframes/producer-render.ts";
import { FILM_SCENE_MIME, parseFilmScenePackage } from "./film-scene-package.ts";
import { buildFilmSceneProject, type FilmSceneMedia } from "./film-scene-project.ts";

export interface FilmCompositionRenderInput {
  ir: VideoIR;
  assetFiles: Readonly<Record<string, string>>;
  /** Scratch directory; scene projects and captures go under `<workDir>/film/`. */
  workDir: string;
  fps: number;
  quality: "draft" | "standard" | "high";
  crf: number;
  workers?: number;
  logger: Logger;
  signal?: AbortSignal;
  /** Job deadline, passed to each scene capture. */
  deadlineAt?: Date;
  /** Progress over all composition shots, 0..1. */
  onProgress?: (progress: number) => void;
}

export interface FilmCompositionRenderResult {
  /** The IR with every composition shot replaced by a muted video shot of its capture. */
  ir: VideoIR;
  assetFiles: Record<string, string>;
}

/** Whether `ir` has composition shots (the renderer then captures them before the main composition). */
export function hasCompositionShots(ir: VideoIR): boolean {
  return ir.scenes.some((scene) => scene.shots.some((shot) => shot.type === "composition"));
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );
}

/** Media of the IR a scene may reference: image and video assets with a local file and a browser type. */
function sceneMedia(ir: VideoIR, assetFiles: Readonly<Record<string, string>>): Map<string, FilmSceneMedia> {
  const media = new Map<string, FilmSceneMedia>();
  for (const asset of ir.assets) {
    const filePath = assetFiles[asset.id];
    if (!filePath) continue;
    if (asset.kind === "image" && IMAGE_EXTENSIONS[asset.mime])
      media.set(asset.id, { filePath, kind: "image", ext: IMAGE_EXTENSIONS[asset.mime]! });
    if (asset.kind === "video" && VIDEO_EXTENSIONS[asset.mime])
      media.set(asset.id, { filePath, kind: "video", ext: VIDEO_EXTENSIONS[asset.mime]! });
  }
  return media;
}

/**
 * Capture every composition shot that names a film scene with the ported film engine (each scene is its own
 * HyperFrames root composition, as the engine expects), then splice each capture into the IR as a muted video
 * shot. The rest of the render runs unchanged on the result. Captures are keyed by the content of the scene,
 * its media, params, duration, frame rate and quality, so a retry in the same work directory reuses them.
 */
export async function renderFilmCompositions(
  input: FilmCompositionRenderInput,
): Promise<FilmCompositionRenderResult> {
  const { ir, assetFiles } = input;
  const assets = new Map(ir.assets.map((a) => [a.id, a]));
  const media = sceneMedia(ir, assetFiles);
  const jobs = ir.scenes.flatMap((scene) =>
    scene.shots.flatMap((shot) => (shot.type === "composition" ? [{ scene, shot }] : [])),
  );
  const extraAssets: AssetRef[] = [];
  const files: Record<string, string> = { ...assetFiles };
  const replaced = new Map<string, Shot>();

  for (const [index, { scene, shot }] of jobs.entries()) {
    if (input.signal?.aborted) throw new StudixError("CANCELLED", "Render cancelled");
    const code = assets.get(shot.assetId);
    const codeFile = assetFiles[shot.assetId];
    if (code?.kind !== "code" || !codeFile) {
      throw new StudixError("VALIDATION", `Composition shot "${shot.id}" has no local code asset`, {
        retryable: false,
        details: { shotId: shot.id, assetId: shot.assetId },
      });
    }
    if (code.mime !== FILM_SCENE_MIME) {
      throw new StudixError("VALIDATION", `Code asset "${code.id}" has type ${code.mime}, not a film scene`, {
        retryable: false,
        details: { assetId: code.id, mime: code.mime },
      });
    }
    if (shot.entry !== undefined && shot.entry !== "main") {
      throw new StudixError("VALIDATION", `Film scene "${code.id}" has only the entry "main"`, {
        retryable: false,
        details: { assetId: code.id, entry: shot.entry },
      });
    }
    const raw = await readFile(codeFile, "utf8");
    const pkg = parseFilmScenePackage(raw, code.id);
    const project = await buildFilmSceneProject({
      assetId: code.id,
      pkg,
      durationMs: shot.durationMs,
      fps: input.fps,
      params: shot.params,
      media,
    });

    const key = sha256(
      JSON.stringify({
        code: sha256(raw),
        media: project.assetIds.map((id) => [id, assets.get(id)?.sha256]),
        params: shot.params ?? {},
        durationMs: shot.durationMs,
        fps: input.fps,
        quality: input.quality,
        crf: input.crf,
      }),
    ).slice(0, 24);
    const outDir = join(input.workDir, "film", key);
    const capture = join(outDir, "capture.mp4");
    if (!(await exists(capture))) {
      const projectDir = join(outDir, "project");
      await rm(projectDir, { recursive: true, force: true });
      await writeComposition(project, projectDir);
      const partial = join(outDir, "capture.partial.mp4");
      const { warnings } = await renderWithProducer({
        projectDir,
        outputPath: partial,
        fps: input.fps,
        quality: input.quality,
        crf: input.crf,
        workers: input.workers,
        logger: input.logger,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
        onProgress: (p) => input.onProgress?.((index + p) / jobs.length),
      });
      for (const warning of warnings)
        input.logger.warn("film scene render warning", { warning, assetId: code.id });
      await rename(partial, capture);
    }
    input.onProgress?.((index + 1) / jobs.length);

    const synthetic = `film--${scene.id}--${shot.id}`;
    const bytes = await readFile(capture);
    extraAssets.push({
      id: synthetic,
      kind: "video",
      uri: pathToFileURL(capture).href,
      sha256: sha256(bytes),
      mime: "video/mp4",
      bytes: bytes.length,
      width: project.width,
      height: project.height,
      durationMs: shot.durationMs,
      provenance: {
        source: "rendered",
        provider: "studix-film-engine",
        derivedFrom: [code.assetVersionId ?? code.id],
      },
    });
    files[synthetic] = capture;
    replaced.set(`${scene.id}/${shot.id}`, {
      id: shot.id,
      startMs: shot.startMs,
      durationMs: shot.durationMs,
      ...(shot.style ? { style: shot.style } : {}),
      ...(shot.animation ? { animation: shot.animation } : {}),
      type: "video",
      assetId: synthetic,
      muted: true,
      fit: "cover",
    });
  }

  return {
    ir: {
      ...ir,
      assets: [...ir.assets, ...extraAssets],
      scenes: ir.scenes.map((scene) => ({
        ...scene,
        shots: scene.shots.map((shot) => replaced.get(`${scene.id}/${shot.id}`) ?? shot),
      })),
    },
    assetFiles: files,
  };
}
