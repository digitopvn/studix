import { compositionFileKey } from "@studix/core";
import { parseSceneFragmentFile, type SceneFragment } from "@studix/renderers";
import { toStudixError } from "@studix/shared";
import { VideoIR } from "@studix/video-ir";
import { type StageContext, StageFailedAfterSpend, StageSuspended, type StageUsage } from "@studix/workflow";
import { z } from "zod";
import { truncateText } from "../vietnamese-safe-text.ts";
import { BuildOutput, MG_SCENE_BUILD_LIMITS, sceneBuildAgent } from "./motion-graphic-director-agents.ts";
import {
  attemptSceneClip,
  clipPath,
  fragmentPath,
  sandboxRenderCents,
  sceneRenderTimeoutSeconds,
  storeClipAsset,
  storeFragment,
  withAuthoredClip,
} from "./motion-graphic-director-clip.ts";
import { sceneClipTiming } from "./motion-graphic-director-timing.ts";

/**
 * One builder repair of an authored scene the visual review failed: the builder gets its stored fragment back
 * with the review's issues, and the fixed fragment is checked and rendered in the sandbox. Any failure keeps
 * the clip the film already shows.
 */

/** What one authored scene repair may cost: a builder run (plus a turn of overshoot) and one sandbox render. */
export const authoredRepairCents = (s: StageContext) =>
  2 * MG_SCENE_BUILD_LIMITS.maxCostCents + sandboxRenderCents(s);
/** Wall time one authored scene repair may take: the builder's cap and the scene's render timeout. */
export const authoredRepairMs = (durationMs: number) =>
  MG_SCENE_BUILD_LIMITS.timeoutMs + sceneRenderTimeoutSeconds(durationMs) * 1000;

const DirectorMeta = z.object({ director: z.object({ compositionId: z.string().min(1) }) });

/** Path of one scene's builder task in a film-mode composition tree. */
export const taskPath = (sid: string) => `data/task-${sid}.json`;
/** Path of the film system (`FilmShell`) in a film-mode composition tree. */
export const FILM_SHELL_PATH = "data/film.json";
/** The hand-off rects of a stored direction (`data/direction.json`). */
const StoredHandoff = z.object({
  scenes: z.array(
    z.object({
      scene: z.number().int(),
      exitRect: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), r: z.number().optional() })
        .nullable()
        .optional(),
    }),
  ),
});
const FilmShellFile = z.object({
  shellVersion: z.number().int().min(1),
  markSymbol: z.string().max(20_000).optional(),
  markName: z.string().max(200).optional(),
  filmAccent: z
    .string()
    .regex(/^#[0-9a-f]{3,8}$/i)
    .optional(),
});

const spentBy = (err: unknown) =>
  err instanceof StageSuspended || err instanceof StageFailedAfterSpend ? err.usage : [];

async function readText(s: StageContext, compositionId: string, path: string): Promise<string> {
  const { body } = await s.services.storage!.get(s.ctx, compositionFileKey(compositionId, path));
  return new Response(body).text();
}

/**
 * Sends authored scene `sceneId` back to its builder once with `issues`, renders the fix and swaps it in.
 * `booked()` is the stage context with what was spent so far; spend lands on `usage` either way. Returns the
 * IR with the new clip, or why the current clip stays. Throws only when the job is aborted.
 */
export async function repairAuthoredScene(
  booked: () => StageContext,
  ir: VideoIR,
  sceneId: string,
  issues: ReadonlyArray<{ path: string; message: string }>,
  workDir: string,
  usage: StageUsage[],
): Promise<{ ir: VideoIR } | { failure: string }> {
  const s = booked();
  const scene = ir.scenes.find((sc) => sc.id === sceneId);
  const meta = DirectorMeta.safeParse(ir.metadata);
  if (!scene || !meta.success || !s.services.compositions || !s.services.storage) {
    return { failure: "the authored scene or its composition is not available on this worker" };
  }
  const { compositionId } = meta.data.director;
  let previous: SceneFragment | undefined;
  try {
    const stored = parseSceneFragmentFile(await readText(s, compositionId, fragmentPath(sceneId)));
    // Film mode keeps one task per scene and the film system; a hook-only composition has one task and no system.
    const taskText = await readText(s, compositionId, taskPath(sceneId)).catch(() =>
      readText(s, compositionId, "data/task.json"),
    );
    const task = z.record(z.string(), z.unknown()).parse(JSON.parse(taskText));
    const shell = FilmShellFile.safeParse(
      JSON.parse(await readText(s, compositionId, FILM_SHELL_PATH).catch(() => "null")),
    ).data;
    const role = z.object({ scene: z.object({ role: z.string() }) }).safeParse(task).data?.scene.role;
    // Only the hand-off rects are read back: the stored direction keeps scenes whose focal words were all
    // unspoken (empty), which the director's own schema would reject.
    const directionJson: unknown = JSON.parse(await readText(s, compositionId, "data/direction.json"));
    const direction = StoredHandoff.parse(directionJson);
    if (!stored) return { failure: "the stored fragment could not be read" };
    previous = stored.fragment;
    // The same timing the scene was built on: word timings, beats and the motif hand-off are unchanged.
    const handoff = Object.fromEntries(
      direction.scenes.flatMap((d) => {
        const id = ir.scenes[d.scene - 1]?.id;
        return id && d.exitRect ? [[id, { exit: d.exitRect }]] : [];
      }),
    );
    const timing = sceneClipTiming(ir, sceneId, handoff);
    s.activity?.touch();
    const result = await sceneBuildAgent.run({
      ...booked(),
      input: { ...task, repair: { issues: issues.slice(0, 10), output: previous } },
    });
    usage.push(...(result.usage ?? []));
    const built = BuildOutput.parse(result.output);
    s.activity?.touch();
    const clip = clipPath(sceneId);
    const attempt = await attemptSceneClip(booked, {
      ir,
      scene,
      built,
      timing,
      compositionId,
      clip,
      extra: shell ? { [`task-${sceneId}`]: task } : { timing, direction: directionJson, task },
      usageItem: `render-${sceneId}-review`,
      usage,
      ...(shell ? { shell, headline: role !== "scene" } : {}),
    });
    s.activity?.touch();
    if (!attempt.ok) {
      // The tree was rewritten for the rejected fix: put back the fragment the film still shows.
      if (attempt.kind === "render") await storeFragment(booked(), compositionId, sceneId, previous);
      return {
        failure:
          attempt.kind === "contract"
            ? `the fix breaks the contract: ${attempt.problems.slice(0, 3).join("; ")}`
            : attempt.kind === "budget"
              ? "the job budget left cannot hold the sandbox render"
              : `the sandbox check or render failed (${attempt.why})`,
      };
    }
    const before = scene.shots.find((sh) => sh.type === "video");
    const asset = await storeClipAsset(booked(), {
      ir,
      scene,
      compositionId,
      clip,
      workDir,
      assetId: `${sceneId}-authored-fix`,
      name: `${sceneId}-fix`,
    });
    const swapped = withAuthoredClip(
      ir,
      sceneId,
      asset,
      before && "assetId" in before ? before.assetId : undefined,
    );
    return { ir: VideoIR.parse({ ...ir, ...swapped }) };
  } catch (err) {
    // A render or upload that threw may have left the rejected fix in the tree: put back what the film shows.
    if (previous) await storeFragment(booked(), compositionId, sceneId, previous).catch(() => undefined);
    if (s.signal.aborted) throw err;
    usage.push(...spentBy(err));
    return {
      failure: truncateText(
        toStudixError(err instanceof StageFailedAfterSpend ? err.error : err).message,
        200,
      ),
    };
  }
}
