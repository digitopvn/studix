import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CompositionManifest,
  compositionContentType,
  compositionFileKey,
  compositionManifestKey,
  loadCompositionManifest,
  mergeManifest,
  saveCompositionManifest,
} from "@studix/core";
import {
  buildDirectorProject,
  checkSceneFragment,
  type DirectorProject,
  frameClippingProblems,
  frameScale,
  resolvePalette,
  type SceneFragment,
  sceneFragmentFile,
} from "@studix/renderers";
import type { AssetRef, Scene, VideoIR } from "@studix/video-ir";
import type { StageContext, StageUsage } from "@studix/workflow";
import type { sceneClipTiming } from "./motion-graphic-director-timing.ts";

/** Smallest headline of an authored scene, at a 1080 px short frame edge: the hook reads in a feed. */
export const HEADLINE_AT_1080 = 72;

/**
 * One authored scene clip, shared by the director stage (first build) and the visual review (a repair):
 * check the fragment, store the composition tree, render the clip in the skill sandbox, book its minutes,
 * and turn the rendered clip into the scene's picture.
 */

/** Most wall time of the sandbox check and render of one authored scene clip. */
export const RENDER_TIMEOUT_SECONDS = 600;
/**
 * Wall time for one scene's check and render: a minute of start-up plus 40 s per second of clip, so a scene
 * that hangs the renderer fails fast and its repair turn still fits the job deadline.
 */
export const sceneRenderTimeoutSeconds = (durationMs: number) =>
  Math.min(RENDER_TIMEOUT_SECONDS, Math.ceil(60 + (40 * Math.max(0, durationMs)) / 1000));

/** The most one sandbox check and render may cost. */
export const sandboxRenderCents = (s: StageContext) =>
  Math.ceil(RENDER_TIMEOUT_SECONDS / 60) * (s.services.compositions?.centsPerMinute ?? 0);

export type ClipTiming = ReturnType<typeof sceneClipTiming>;

/**
 * The film system a composition was assembled with, stored as `data/film.json` so a later repair of one scene
 * renders it on the same shell, mark and accent as the film.
 */
export interface FilmShell {
  shellVersion: number;
  /** The `<symbol id="sx-mark">` markup; for a logo it points at a file already in the tree. */
  markSymbol?: string;
  markName?: string;
  /** The film's one accent hue (hex). */
  filmAccent?: string;
}

/** Headline floor of the frame, in px. */
export const headlinePxOf = (ir: VideoIR) =>
  Math.round(HEADLINE_AT_1080 * frameScale({ width: ir.format.width, height: ir.format.height }));

/** The shell theme of a graphic: its palette and fonts, and the film's one accent when it has one. */
export const directorTheme = (ir: VideoIR, filmAccent?: string) => ({
  palette: resolvePalette(ir.brand),
  ...(ir.brand ? { fonts: ir.brand.fonts } : {}),
  ...(filmAccent ? { filmAccent } : {}),
});

/** Writes files into the composition tree (created on first use) and saves its manifest. */
export async function storeTree(
  s: StageContext,
  id: string,
  files: ReadonlyArray<{ path: string; body: Uint8Array }>,
): Promise<void> {
  const storage = s.services.storage!;
  const existing = await storage.head(s.ctx, compositionManifestKey(id));
  const manifest: CompositionManifest = existing
    ? await loadCompositionManifest(storage, s.ctx, id)
    : { id, title: "Motion graphic: authored scenes", files: [], updatedAt: new Date().toISOString() };
  const written = [];
  for (const f of files) {
    const contentType = compositionContentType(f.path);
    const put = await storage.put(s.ctx, compositionFileKey(id, f.path), f.body, { contentType });
    written.push({ path: f.path, bytes: f.body.byteLength, sha256: put.sha256, contentType });
  }
  await saveCompositionManifest(storage, s.ctx, mergeManifest(manifest, written));
}

/** The project's files, its fragment as stored for later edits, and the data files (`data/<name>.json`). */
async function treeFiles(
  project: DirectorProject,
  sid: string,
  fragment: SceneFragment,
  extra: Record<string, unknown>,
) {
  const enc = new TextEncoder();
  const files: Array<{ path: string; body: Uint8Array }> = [];
  for (const [path, text] of project.files) files.push({ path, body: enc.encode(text) });
  for (const [path, source] of project.copies)
    files.push({ path, body: new Uint8Array(await readFile(source)) });
  files.push({ path: fragmentPath(sid), body: enc.encode(sceneFragmentFile(sid, fragment)) });
  for (const [name, value] of Object.entries(extra))
    files.push({ path: `data/${name}.json`, body: enc.encode(JSON.stringify(value, null, 2)) });
  return files;
}

/** Stores only the fragment file: puts the tree back on the fragment the film still shows. */
export async function storeFragment(
  s: StageContext,
  compositionId: string,
  sid: string,
  fragment: SceneFragment,
): Promise<void> {
  const body = new TextEncoder().encode(sceneFragmentFile(sid, fragment));
  await storeTree(s, compositionId, [{ path: fragmentPath(sid), body }]);
}

/** Why one attempt gave no clip, or the clip's path in the composition tree. */
export type ClipAttempt =
  /** `layout`: text or UI the check found cut by the frame edge (advisory: the clip rendered). */
  | { ok: true; layout: string[] }
  | { ok: false; kind: "contract"; problems: string[] }
  | { ok: false; kind: "budget" }
  | { ok: false; kind: "render"; why: string; log: string };

/**
 * One attempt at a scene clip from `built`: the contract check, the composition tree (with `extra` data
 * files), the sandbox check and render, and its compute booked on `usage`. `booked()` is the stage context
 * with what was spent so far; the render runs only while what is left of the budget holds it.
 */
export async function attemptSceneClip(
  booked: () => StageContext,
  a: {
    ir: VideoIR;
    scene: Scene;
    built: SceneFragment;
    timing: ClipTiming;
    compositionId: string;
    clip: string;
    extra: Record<string, unknown>;
    usageItem: string;
    usage: StageUsage[];
    /** The film system the scene was built on; a composition from before film mode (shell v1) has none. */
    shell?: FilmShell;
    /** Whether the scene sets a headline (the hook, the call to action); every scene of a v1 composition does. */
    headline?: boolean;
  },
): Promise<ClipAttempt> {
  const s = booked();
  const compositions = s.services.compositions!;
  const words = a.timing.scenes[a.scene.id]?.lines.flatMap((l) => l.words.map(([w]) => w)) ?? [];
  const shellVersion = a.shell?.shellVersion ?? 1;
  const checked = checkSceneFragment(a.built, {
    sid: a.scene.id,
    words,
    shellVersion,
    ...(a.headline !== false ? { headlinePx: headlinePxOf(a.ir) } : {}),
  });
  if (checked.problems.length > 0) return { ok: false, kind: "contract", problems: checked.problems };
  const project = buildDirectorProject({
    width: a.ir.format.width,
    height: a.ir.format.height,
    timing: a.timing,
    theme: directorTheme(a.ir, a.shell?.filmAccent),
    scenes: [{ sid: a.scene.id, fragment: checked }],
    shellVersion,
    ...(a.shell?.markSymbol ? { mark: { symbol: a.shell.markSymbol } } : {}),
    ...(a.shell?.markName ? { markName: a.shell.markName } : {}),
  });
  // An agent repair turn may have spent what the render needed: never overshoot the job budget.
  const left =
    s.job.budgetCents === undefined ? Number.POSITIVE_INFINITY : s.job.budgetCents - s.job.spentCents;
  if (left < sandboxRenderCents(s)) return { ok: false, kind: "budget" };
  await storeTree(s, a.compositionId, await treeFiles(project, a.scene.id, a.built, a.extra));
  const report = checkReportPath(a.scene.id);
  const run = await compositions.runner.run(booked(), {
    compositionId: a.compositionId,
    // The check exits 1 on any `error` finding, layout, motion and contrast included. Only a missing or
    // broken report, or lint/runtime errors (broken HTML or JS), block the render; the rest are read back
    // from the kept report and fed to the one reframe repair, so a fixable scene never costs its clip.
    command:
      `mkdir -p out && { hyperframes check . --json > ${report}; node -e '${CHECK_GATE_JS}' ${report}; } && ` +
      `hyperframes render . -o ${a.clip} --quiet`,
    timeoutSeconds: sceneRenderTimeoutSeconds(a.scene.durationMs),
    check: {
      path: a.clip,
      width: a.ir.format.width,
      height: a.ir.format.height,
      durationMs: a.scene.durationMs,
      durationToleranceMs: 250,
    },
  });
  a.usage.push({
    item: a.usageItem.slice(0, 64),
    kind: "compute",
    quantity: Math.round(run.durationMs) / 1000,
    unit: "second",
    // Billed minutes never exceed the render timeout the budget reserved.
    costCents:
      Math.min(Math.ceil(RENDER_TIMEOUT_SECONDS / 60), Math.max(1, Math.ceil(run.durationMs / 60_000))) *
      compositions.centsPerMinute,
    metadata: { exitCode: run.exitCode, compositionId: a.compositionId },
  });
  if (run.exitCode === 0 && (!run.check || run.check.passed)) {
    return { ok: true, layout: await frameClipping(s, a.compositionId, report) };
  }
  const why = run.exitCode !== 0 ? `exit ${run.exitCode}` : (run.check?.problems ?? []).join("; ");
  return { ok: false, kind: "render", why, log: run.log };
}

/**
 * The rendered clip copied to an immutable job key (the composition's own file changes when the scene is
 * edited), as the scene's video asset.
 */
export async function storeClipAsset(
  s: StageContext,
  a: {
    ir: VideoIR;
    scene: Scene;
    compositionId: string;
    clip: string;
    workDir: string;
    assetId: string;
    /** File name of the stored copy, unique per clip so an earlier clip's object is never overwritten. */
    name: string;
  },
): Promise<AssetRef> {
  const storage = s.services.storage!;
  const local = join(a.workDir, `${a.name}.mp4`);
  const { sha256 } = await storage.download(s.ctx, compositionFileKey(a.compositionId, a.clip), local);
  const stored = await storage.put(
    s.ctx,
    `generated/${s.job.id}/authored/${a.name}.mp4`,
    { filePath: local },
    { contentType: "video/mp4", sha256 },
  );
  return {
    id: a.assetId.slice(0, 64),
    kind: "video",
    storageKey: stored.key,
    sha256: stored.sha256,
    mime: "video/mp4",
    bytes: stored.bytes,
    width: a.ir.format.width,
    height: a.ir.format.height,
    durationMs: a.scene.durationMs,
    assetVersionId: `asv_${stored.sha256.slice(0, 24)}`,
    provenance: { source: "generated", provider: "studix-director" },
  };
}

/** The scene whose picture is now the rendered clip, muted (the film's mix carries the sound). */
export function authoredScene(scene: Scene, asset: AssetRef): Scene {
  // The clip owns its whole picture: no template camera move, depth planes or motif drawn over it.
  const { camera: _camera, depth: _depth, motif: _motif, ...rest } = scene;
  return {
    ...rest,
    shots: [
      {
        id: asset.id,
        type: "video",
        assetId: asset.id,
        startMs: 0,
        durationMs: scene.durationMs,
        muted: true,
        fit: "cover",
        style: { region: "full" },
        // The clip carries its own motion; the scene transition still cuts it in.
        animation: { enter: "none", exit: "none" },
      },
    ],
  };
}

/**
 * The scenes and assets with one scene's picture swapped for a clip; `replaces` names the clip asset it
 * showed before, dropped with it.
 */
export function withAuthoredClip(ir: VideoIR, sceneId: string, asset: AssetRef, replaces?: string) {
  const dropped = new Set([asset.id, replaces]);
  return {
    scenes: ir.scenes.map((sc) => (sc.id === sceneId ? authoredScene(sc, asset) : sc)),
    assets: [...ir.assets.filter((a) => !dropped.has(a.id)), asset],
  };
}

/** Path of a scene's fragment in the composition tree. */
export const fragmentPath = (sid: string) => `scenes/${sid}.scene.html`;
/** Log line prefix of the sandbox check gate's verdict. */
const CHECK_GATE_PREFIX = "studix-check: ";
/** Longest check summary carried into a warning or a repair message. */
const CHECK_SUMMARY_CHARS = 400;

/**
 * Node script (no single quotes: it sits in a single-quoted shell word) that exits 1, printing a compact
 * summary, when the check report is missing, unreadable, an error, or has lint or runtime errors.
 */
export const CHECK_GATE_JS = [
  `const p="${CHECK_GATE_PREFIX}";let r;`,
  `try{r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch(e){console.log(p+"no readable check report: "+String(e&&e.message).slice(0,200));process.exit(1)}`,
  `if(!r||typeof r!=="object"||r.error||!r.lint){console.log(p+"check failed: "+JSON.stringify(r&&r.error||r).slice(0,300));process.exit(1)}`,
  `const s=[r.lint,r.runtime].filter(Boolean);`,
  `if(s.some(x=>x.errorCount>0)){const f=s.flatMap(x=>x.findings||[]).filter(x=>x.severity==="error");`,
  `console.log(p+(f.map(x=>[x.code,x.selector,x.message].filter(Boolean).join(" ")).join("; ")||"lint or runtime errors").slice(0,${CHECK_SUMMARY_CHARS}));process.exit(1)}`,
].join("");

/**
 * The compact error summary the check gate printed into a failed run's log, or the log's tail when the
 * failure came from elsewhere (the render itself), at most `CHECK_SUMMARY_CHARS`.
 */
export function checkFailureSummary(log: string): string {
  const line = log.split("\n").find((l) => l.startsWith(CHECK_GATE_PREFIX));
  return line
    ? line.slice(CHECK_GATE_PREFIX.length, CHECK_GATE_PREFIX.length + CHECK_SUMMARY_CHARS)
    : log.trim().slice(-CHECK_SUMMARY_CHARS);
}

/** Path of the `hyperframes check --json` report of a scene's last attempt in the composition tree. */
export const checkReportPath = (sid: string) => `out/${sid}-check.json`;

/**
 * Frame-edge clipping the check reported for the attempt (`frameClippingProblems`). A report that is
 * missing or unreadable gives none: the findings only ever add a repair turn, never cost the clip.
 */
async function frameClipping(s: StageContext, compositionId: string, path: string): Promise<string[]> {
  try {
    const { body } = await s.services.storage!.get(s.ctx, compositionFileKey(compositionId, path));
    return frameClippingProblems(JSON.parse(await new Response(body).text()));
  } catch {
    return [];
  }
}

/** Path of the clip rendered for a scene in the composition tree. */
export const clipPath = (sid: string) => `out/${sid}.mp4`;
