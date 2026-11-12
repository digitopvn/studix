import { readFile } from "node:fs/promises";
import { compositionFileKey } from "@studix/core";
import {
  attributeFilmCheck,
  blankCutScenes,
  buildDirectorProject,
  type CheckedSceneFragment,
  cutFrames,
  cutLumaCommand,
  type DirectorMark,
  type DirectorTiming,
  type FilmCheckVerdict,
  type FilmFrameRange,
  filmFrameRanges,
  filmSplitCommand,
  parseCutLuma,
  resolvePalette,
  scenesThrownInLog,
} from "@studix/renderers";
import type { VideoIR } from "@studix/video-ir";
import type { StageContext, StageUsage } from "@studix/workflow";
import type { BuildOutput } from "./motion-graphic-director-agents.ts";
import { MG_SCENE_BUILD_LIMITS } from "./motion-graphic-director-agents.ts";
import { clipPath, directorTheme, type FilmShell, storeTree } from "./motion-graphic-director-clip.ts";
import { sceneWindows } from "./motion-graphic-director-timing.ts";

/**
 * Film mode of the director tier: builders author every scene at once (a bounded fan-out, each call paid from a
 * budget grant), the scenes are checked together in one sandbox run with findings attributed back to their
 * scene, and the survivors are rendered together in a second run on the film's own timing, then cut into one
 * clip per scene. Spend is booked on the caller's usage list either way.
 */

/** What one scene is expected to cost to author: the admission and estimate unit of film mode. */
export const EXPECTED_SCENE_CENTS = 15;
/** Builders authoring at once. */
export const BUILD_CONCURRENCY = 5;
/** Most wall time of the film check (run 1) and the film render with its split (run 2). */
export const FILM_CHECK_TIMEOUT_SECONDS = 600;
export const FILM_RENDER_TIMEOUT_SECONDS = 1200;
/** Expected wall time of both sandbox runs: start-up plus a share per film second (sidecars run on 1.5 cores). */
export const filmSandboxMsEstimate = (filmMs: number) => 2 * 60_000 + 25 * filmMs;

const cpm = (s: StageContext) => s.services.compositions?.centsPerMinute ?? 0;
/** The most the film check may cost. */
export const filmCheckCents = (s: StageContext) => Math.ceil(FILM_CHECK_TIMEOUT_SECONDS / 60) * cpm(s);
/** The most the film render may cost. */
export const filmRenderCents = (s: StageContext) => Math.ceil(FILM_RENDER_TIMEOUT_SECONDS / 60) * cpm(s);
/** Both sandbox runs: what the fan-out never spends. */
export const filmSandboxCents = (s: StageContext) => filmCheckCents(s) + filmRenderCents(s);

/** Runs `fn` over `items` with at most `limit` in flight, keeping the order of the results. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Budget grants for builder calls that run in parallel: each call is capped at what it was granted (at most
 * the builder's cap), grants in flight count as spent, and `holdBack` (the sandbox runs) is never granted. A
 * call is admitted only when the grant holds at least the expected cost of a scene; otherwise its scene stays
 * a template card. `left()` is what the job has left after the usage booked so far.
 */
export function createBuildGrants(left: () => number, holdBack: number) {
  let reserved = 0;
  return {
    take(): number | undefined {
      const free = left() - reserved - holdBack;
      const grant = Math.min(MG_SCENE_BUILD_LIMITS.maxCostCents, Math.floor(free));
      if (!(grant >= EXPECTED_SCENE_CENTS)) return undefined;
      reserved += grant;
      return grant;
    },
    release(grant: number) {
      reserved = Math.max(0, reserved - grant);
    },
    get reserved() {
      return reserved;
    },
  };
}

/** One builder answer: the fragment, or why there is none, and the agent runs it took (2 = repair used). */
export type BuildAttempt = { built: BuildOutput; runs: number } | { failure: string; runs: number };
/** A scene's fragment after the fan-out: checked and ready to assemble, or why its card stays. */
export type AuthoredScene =
  | { index: number; built: BuildOutput; checked: CheckedSceneFragment }
  | { index: number; failure: string };

/**
 * Authors every scene: all builders run (at most `concurrency` at once), each fragment is checked against the
 * contract, and every scene that broke it goes back to its builder once, in parallel, with what is wrong,
 * unless its call already used its own schema repair turn.
 */
export async function authorScenes(a: {
  count: number;
  concurrency: number;
  build: (
    index: number,
    repair?: { issues: Array<{ path: string; message: string }>; output: BuildOutput },
  ) => Promise<BuildAttempt>;
  check: (index: number, built: BuildOutput) => CheckedSceneFragment;
}): Promise<AuthoredScene[]> {
  type First =
    | AuthoredScene
    | { index: number; broken: { built: BuildOutput; runs: number; problems: string[] } };
  const contract = (problems: readonly string[]) =>
    `the fragment breaks the contract: ${problems.slice(0, 3).join("; ")}`;
  const indexes = Array.from({ length: a.count }, (_, i) => i);
  const first = await mapLimit(indexes, a.concurrency, async (index): Promise<First> => {
    const attempt = await a.build(index);
    if ("failure" in attempt) return { index, failure: attempt.failure };
    const checked = a.check(index, attempt.built);
    if (checked.problems.length === 0) return { index, built: attempt.built, checked };
    return { index, broken: { built: attempt.built, runs: attempt.runs, problems: checked.problems } };
  });
  return mapLimit(first, a.concurrency, async (scene): Promise<AuthoredScene> => {
    if (!("broken" in scene)) return scene;
    const { index, broken } = scene;
    if (broken.runs >= 2) return { index, failure: contract(broken.problems) };
    const issues = broken.problems.slice(0, 10).map(problemIssue);
    const again = await a.build(index, { issues, output: broken.built });
    if ("failure" in again) return { index, failure: again.failure };
    const checked = a.check(index, again.built);
    if (checked.problems.length === 0) return { index, built: again.built, checked };
    return { index, failure: contract(checked.problems) };
  });
}

/** A contract or check problem as a repair issue: `html: ...` names the part it is about. */
export const problemIssue = (problem: string) => {
  const part = /^(html|css|js):/.exec(problem)?.[1];
  return { path: part ?? "fragment", message: problem };
};

/** Path of the film check report, the film render and its luma measurements in the composition tree. */
export const FILM_CHECK_REPORT = "out/film-check.json";
export const FILM_RENDER = "out/film.mp4";
export const FILM_LUMA = "out/film-luma.txt";

/** Everything the two sandbox runs need. */
export interface FilmJob {
  ir: VideoIR;
  compositionId: string;
  timing: DirectorTiming;
  shell: FilmShell;
  mark: DirectorMark;
  usage: StageUsage[];
  /** Data files stored with the tree (`data/<name>.json`). */
  data: Record<string, unknown>;
  /** Fragment files stored with the tree (`scenes/<sid>.scene.html`), path -> text. */
  fragments: Map<string, string>;
  /** Seconds the sandbox may still use before the job deadline; caps each run's timeout. */
  secondsLeft: () => number;
}

const encoder = new TextEncoder();

/** The film composition of `scenes` and the files it needs, as composition tree files. */
async function filmFiles(
  job: FilmJob,
  scenes: ReadonlyArray<{ sid: string; checked: CheckedSceneFragment }>,
  withData: boolean,
) {
  const project = buildDirectorProject({
    width: job.ir.format.width,
    height: job.ir.format.height,
    timing: job.timing,
    theme: directorTheme(job.ir, job.shell.filmAccent),
    scenes: scenes.map((s) => ({ sid: s.sid, fragment: s.checked })),
    shellVersion: job.shell.shellVersion,
    mark: job.mark,
    ...(job.shell.markName ? { markName: job.shell.markName } : {}),
  });
  const files: Array<{ path: string; body: Uint8Array }> = [];
  for (const [path, text] of project.files) files.push({ path, body: encoder.encode(text) });
  if (!withData) return files;
  for (const [path, source] of project.copies)
    files.push({ path, body: new Uint8Array(await readFile(source)) });
  for (const [path, text] of job.fragments) files.push({ path, body: encoder.encode(text) });
  for (const [name, value] of Object.entries(job.data))
    files.push({ path: `data/${name}.json`, body: encoder.encode(JSON.stringify(value, null, 2)) });
  return files;
}

/** Books one sandbox run's compute on the usage list: started minutes, never above its timeout. */
function bookRun(
  s: StageContext,
  usage: StageUsage[],
  item: string,
  run: { durationMs: number; exitCode: number | null },
  timeoutSeconds: number,
  compositionId: string,
) {
  usage.push({
    item,
    kind: "compute",
    quantity: Math.round(run.durationMs) / 1000,
    unit: "second",
    costCents:
      Math.min(Math.ceil(timeoutSeconds / 60), Math.max(1, Math.ceil(run.durationMs / 60_000))) * cpm(s),
    metadata: { exitCode: run.exitCode, compositionId },
  });
}

const timeoutWithin = (cap: number, secondsLeft: number) =>
  Math.max(60, Math.min(cap, Math.floor(secondsLeft)));

async function readTree(s: StageContext, compositionId: string, path: string): Promise<string | undefined> {
  try {
    const { body } = await s.services.storage!.get(s.ctx, compositionFileKey(compositionId, path));
    return await new Response(body).text();
  } catch {
    return undefined;
  }
}

/**
 * Run 1: stores the tree (shell, every fragment, the data files) and runs `hyperframes check` once on the whole
 * film. Its findings are attributed to scenes; a scene the shell logged a throw for counts as an error too.
 */
export async function checkFilm(
  booked: () => StageContext,
  job: FilmJob,
  scenes: ReadonlyArray<{ sid: string; checked: CheckedSceneFragment }>,
): Promise<{ verdict: FilmCheckVerdict; seconds: number }> {
  const s = booked();
  await storeTree(s, job.compositionId, await filmFiles(job, scenes, true));
  const timeoutSeconds = timeoutWithin(FILM_CHECK_TIMEOUT_SECONDS, job.secondsLeft());
  const run = await s.services.compositions!.runner.run(booked(), {
    compositionId: job.compositionId,
    // The check exits 1 on any error finding; the report is read back and attributed, never the exit code.
    command: `mkdir -p out && { hyperframes check . --json > ${FILM_CHECK_REPORT} || true; }`,
    timeoutSeconds,
  });
  bookRun(s, job.usage, "film-check", run, timeoutSeconds, job.compositionId);
  const text = await readTree(booked(), job.compositionId, FILM_CHECK_REPORT);
  let report: unknown;
  try {
    report = text === undefined ? undefined : JSON.parse(text);
  } catch {
    report = undefined;
  }
  const windows = sceneWindows(job.ir);
  const verdict = attributeFilmCheck(
    report,
    scenes.map((sc) => {
      const w = windows.find((x) => x.id === sc.sid);
      return { sid: sc.sid, start: (w?.startMs ?? 0) / 1000, end: (w?.endMs ?? 0) / 1000 };
    }),
  );
  for (const sid of scenesThrownInLog(
    run.log,
    scenes.map((sc) => sc.sid),
  )) {
    if (!verdict.errors.has(sid))
      verdict.errors.set(sid, [`[studix-scene ${sid}] threw while the page built`]);
  }
  return { verdict, seconds: Math.round(run.durationMs) / 1000 };
}

/** What the film render gave: a clip per rendered scene, scenes that threw or open/close blank, and its time. */
export interface FilmRender {
  ok: boolean;
  /** Why the render gave no film (exit code, failed output check). */
  why?: string;
  log?: string;
  clips: Map<string, string>;
  thrown: string[];
  blankCuts: Array<{ sid: string; frames: number[] }>;
  seconds: number;
}

/**
 * Run 2: assembles the scenes that passed the check into the film composition, renders it once on the film's
 * timing (captions off), cuts it into one silent clip per scene on exact frame ranges and measures the luma of
 * the frames around every cut.
 */
export async function renderFilm(
  booked: () => StageContext,
  job: FilmJob,
  scenes: ReadonlyArray<{ sid: string; checked: CheckedSceneFragment }>,
): Promise<FilmRender> {
  const s = booked();
  await storeTree(s, job.compositionId, await filmFiles(job, scenes, false));
  const filmMs = sceneWindows(job.ir).at(-1)?.endMs ?? job.ir.format.durationMs;
  const ranges = filmFrameRanges(sceneWindows(job.ir), job.ir.format.fps);
  const wanted = new Set(scenes.map((sc) => sc.sid));
  const clips = ranges
    .filter((r) => wanted.has(r.sid))
    .map((r): FilmFrameRange & { path: string } => ({ ...r, path: clipPath(r.sid) }));
  const timeoutSeconds = timeoutWithin(FILM_RENDER_TIMEOUT_SECONDS, job.secondsLeft());
  const run = await s.services.compositions!.runner.run(booked(), {
    compositionId: job.compositionId,
    command:
      `mkdir -p out && hyperframes render . -o ${FILM_RENDER} --quiet && ${filmSplitCommand(FILM_RENDER, clips)}` +
      ` && { ${cutLumaCommand(FILM_RENDER, cutFrames(ranges), FILM_LUMA)} || true; }`,
    timeoutSeconds,
    check: {
      path: FILM_RENDER,
      width: job.ir.format.width,
      height: job.ir.format.height,
      durationMs: Math.round(filmMs),
      durationToleranceMs: 250,
    },
  });
  bookRun(s, job.usage, "film-render", run, timeoutSeconds, job.compositionId);
  const seconds = Math.round(run.durationMs) / 1000;
  if (run.exitCode !== 0 || (run.check && !run.check.passed)) {
    const why = run.exitCode !== 0 ? `exit ${run.exitCode}` : (run.check?.problems ?? []).join("; ");
    return { ok: false, why, log: run.log, clips: new Map(), thrown: [], blankCuts: [], seconds };
  }
  const written = new Set(run.changed.map((f) => f.path));
  const made = new Map(clips.filter((c) => written.has(c.path)).map((c) => [c.sid, c.path]));
  const thrown = scenesThrownInLog(run.log, [...wanted]);
  const luma = await readTree(booked(), job.compositionId, FILM_LUMA);
  const background = resolvePalette(job.ir.brand).background;
  const blankCuts = luma
    ? blankCutScenes(ranges, parseCutLuma(luma, job.ir.format.fps), background, wanted)
    : [];
  return { ok: true, clips: made, thrown, blankCuts, seconds };
}
