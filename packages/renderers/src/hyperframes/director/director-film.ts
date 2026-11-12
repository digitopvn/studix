import { z } from "zod";
import { frameClippingProblems } from "./check-frame-clipping.ts";
import { sceneSectionId } from "./scene-fragment.ts";

/**
 * Film mode of the director tier: every authored scene is assembled into one composition with film timing,
 * checked once (findings attributed back to their scene) and rendered once; the film is then cut into one clip
 * per scene on exact frame boundaries, and the frames around every cut are measured so a scene that opens or
 * closes on an empty frame is flagged. Pure helpers: the commands run in the skill sandbox.
 */

/** A scene's window on the film timeline, in ms. */
export interface FilmWindow {
  id: string;
  startMs: number;
  endMs: number;
}

/** A scene's frames in the film render: [startFrame, endFrame). */
export interface FilmFrameRange {
  sid: string;
  startFrame: number;
  endFrame: number;
}

/**
 * Frame range of every scene, from cumulative rounded times, so the ranges tile the film exactly: no frame is
 * dropped or shown twice where two clips meet.
 */
export function filmFrameRanges(windows: readonly FilmWindow[], fps: number): FilmFrameRange[] {
  const frame = (ms: number) => Math.round((ms * fps) / 1000);
  return windows.map((w) => ({ sid: w.id, startFrame: frame(w.startMs), endFrame: frame(w.endMs) }));
}

/** Composition paths are plain: the split and luma commands put them in shell words unquoted. */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const assertPath = (path: string) => {
  if (!SAFE_PATH.test(path) || path.includes("..")) throw new Error(`unsafe composition path ${path}`);
  return path;
};

/**
 * One ffmpeg run that decodes the film once and writes each scene's frames to its own silent clip. Frames are
 * trimmed by index and re-encoded (a stream copy would cut on keyframes); the intermediate is near-lossless
 * because the final render encodes these frames again.
 */
export function filmSplitCommand(
  film: string,
  clips: ReadonlyArray<FilmFrameRange & { path: string }>,
): string {
  if (clips.length === 0) throw new Error("nothing to split");
  const labels = clips.map((_, i) => `[v${i}]`);
  const graph = [
    `[0:v]split=${clips.length}${labels.join("")}`,
    ...clips.map(
      (c, i) => `[v${i}]trim=start_frame=${c.startFrame}:end_frame=${c.endFrame},setpts=PTS-STARTPTS[o${i}]`,
    ),
  ].join(";");
  const outputs = clips
    .map(
      (c, i) =>
        `-map "[o${i}]" -an -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p -movflags +faststart ${assertPath(c.path)}`,
    )
    .join(" ");
  return `ffmpeg -v error -y -i ${assertPath(film)} -filter_complex "${graph}" ${outputs}`;
}

/** Frames measured around each cut: this many before and after it. */
export const CUT_FRAMES = 2;

/** Frame indexes within ±CUT_FRAMES of every cut between two scenes (and the film's first frames). */
export function cutFrames(ranges: readonly FilmFrameRange[]): number[] {
  const last = (ranges.at(-1)?.endFrame ?? 0) - 1;
  const frames = new Set<number>();
  for (const r of ranges) {
    for (let k = -CUT_FRAMES; k <= CUT_FRAMES; k++) {
      const f = r.startFrame + k;
      if (f >= 0 && f <= last) frames.add(f);
    }
  }
  return [...frames].sort((a, b) => a - b);
}

/**
 * ffmpeg run that prints the luma statistics (mean, 10th and 90th percentile) of the given frames of the film
 * into `out`, one block per frame.
 */
export function cutLumaCommand(film: string, frames: readonly number[], out: string): string {
  if (frames.length === 0) throw new Error("no frames to measure");
  const select = frames.map((f) => `eq(n,${f})`).join("+");
  return (
    `ffmpeg -v error -y -i ${assertPath(film)} -an -vf ` +
    `"select='${select}',signalstats,metadata=mode=print:file=${assertPath(out)}" -f null -`
  );
}

/** Luma statistics of one measured frame (0..255, limited range). */
export interface FrameLuma {
  frame: number;
  avg: number;
  low: number;
  high: number;
}

/**
 * Parses what `cutLumaCommand` printed: blocks of `frame:<k> pts:<p> pts_time:<s>` followed by
 * `lavfi.signalstats.<KEY>=<v>` lines. The source frame index comes from `pts_time` (select renumbers frames).
 */
export function parseCutLuma(text: string, fps: number): FrameLuma[] {
  const out: FrameLuma[] = [];
  let current: Partial<FrameLuma> | undefined;
  const flush = () => {
    if (
      current?.frame !== undefined &&
      current.avg !== undefined &&
      current.low !== undefined &&
      current.high !== undefined
    )
      out.push(current as FrameLuma);
  };
  for (const line of text.split(/\r?\n/)) {
    const head = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (head) {
      flush();
      current = { frame: Math.round(Number(head[1]) * fps) };
      continue;
    }
    const kv = /lavfi\.signalstats\.(YAVG|YLOW|YHIGH)=(-?\d+(?:\.\d+)?)/.exec(line);
    if (!kv || !current) continue;
    const v = Number(kv[2]);
    if (kv[1] === "YAVG") current.avg = v;
    else if (kv[1] === "YLOW") current.low = v;
    else current.high = v;
  }
  flush();
  return out;
}

/** Limited-range BT.709 luma of a hex colour, as signalstats reports it for a frame of that colour. */
export function hexLuma(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length <= 4 ? [...h.slice(0, 3)].map((c) => c + c).join("") : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  return 16 + 219 * (0.2126 * r + 0.7152 * g + 0.0722 * b);
}

/** A frame within this much mean luma of the background, with this little spread, shows nothing but the page. */
export const BLANK_LUMA = { avgDelta: 8, spread: 12 } as const;

/** Whether a measured frame is blank: the background (and the faint chrome) with no scene content on it. */
export const isBlankFrame = (f: FrameLuma, backgroundLuma: number) =>
  Math.abs(f.avg - backgroundLuma) <= BLANK_LUMA.avgDelta && f.high - f.low <= BLANK_LUMA.spread;

/**
 * Scenes with a blank frame at one of their cuts: a frame within CUT_FRAMES after a scene starts belongs to
 * that scene, one before it to the scene that ends there. `only` limits the verdict to the scenes measured
 * (authored ones); a frame no listed scene owns is ignored.
 */
export function blankCutScenes(
  ranges: readonly FilmFrameRange[],
  lumas: readonly FrameLuma[],
  background: string,
  only?: ReadonlySet<string>,
): Array<{ sid: string; frames: number[] }> {
  const bg = hexLuma(background);
  const owner = (frame: number) => ranges.find((r) => frame >= r.startFrame && frame < r.endFrame)?.sid;
  const flagged = new Map<string, number[]>();
  for (const f of lumas) {
    if (!isBlankFrame(f, bg)) continue;
    const sid = owner(f.frame);
    if (!sid || (only && !only.has(sid))) continue;
    flagged.set(sid, [...(flagged.get(sid) ?? []), f.frame]);
  }
  return ranges.flatMap((r) => {
    const frames = flagged.get(r.sid);
    return frames ? [{ sid: r.sid, frames }] : [];
  });
}

const Finding = z
  .object({
    code: z.string().optional(),
    severity: z.string().optional(),
    selector: z.string().optional(),
    containerSelector: z.string().optional(),
    message: z.string().optional(),
    text: z.string().optional(),
    time: z.number().optional(),
  })
  .passthrough();
const Section = z.object({ findings: z.array(z.unknown()).default([]) }).passthrough();
const Report = z
  .object({ lint: Section.optional(), runtime: Section.optional(), layout: Section.optional() })
  .passthrough();

/** Scene ids the v2 shell logged a throw for (`[studix-scene <sid>] ...`) in a sandbox run's log. */
export function scenesThrownInLog(log: string, sids: readonly string[]): string[] {
  return sids.filter((sid) => log.includes(`[studix-scene ${sid}]`));
}

/** What the film check says about each scene. */
export interface FilmCheckVerdict {
  /** Blocking errors (lint, runtime) per scene id: such a scene falls back to its card. */
  errors: Map<string, string[]>;
  /** Advisory layout problems per scene id (text cut at the frame edge), as `frameClippingProblems` words them. */
  layout: Map<string, string[]>;
  /** Blocking errors no scene could be named for: the whole film falls back. */
  film: string[];
  /** Whether the report could be read at all. */
  readable: boolean;
}

/**
 * Attributes the findings of `hyperframes check --json` on the film composition to scenes: by a selector
 * inside a scene's section (`#sc-<sid>`), then by the `[studix-scene <sid>]` tag the v2 shell logs when a
 * scene throws, then by the time of the finding inside a scene's window. Only lint and runtime errors block.
 */
export function attributeFilmCheck(
  report: unknown,
  scenes: ReadonlyArray<{ sid: string; start: number; end: number }>,
): FilmCheckVerdict {
  const verdict: FilmCheckVerdict = { errors: new Map(), layout: new Map(), film: [], readable: false };
  const parsed = Report.safeParse(report);
  if (!parsed.success || !parsed.data.lint) return verdict;
  verdict.readable = true;
  const owner = (f: z.infer<typeof Finding>): string | undefined => {
    const where = `${f.selector ?? ""} ${f.containerSelector ?? ""}`;
    for (const s of scenes) if (where.includes(`#${sceneSectionId(s.sid)}`)) return s.sid;
    const said = `${f.message ?? ""} ${f.text ?? ""}`;
    for (const s of scenes) if (said.includes(`[studix-scene ${s.sid}]`)) return s.sid;
    if (f.time !== undefined) return scenes.find((s) => f.time! >= s.start && f.time! < s.end)?.sid;
    return undefined;
  };
  const push = (map: Map<string, string[]>, sid: string, line: string) =>
    map.set(sid, [...(map.get(sid) ?? []), line]);
  for (const section of [parsed.data.lint, parsed.data.runtime]) {
    for (const raw of section?.findings ?? []) {
      const f = Finding.safeParse(raw);
      if (!f.success || f.data.severity !== "error") continue;
      const line = [f.data.code, f.data.selector, f.data.message].filter(Boolean).join(" ").slice(0, 300);
      const sid = owner(f.data);
      if (sid) push(verdict.errors, sid, line);
      else verdict.film.push(line);
    }
  }
  // Layout problems per scene: the clipping reader runs on each scene's own findings.
  const layoutFindings = parsed.data.layout?.findings ?? [];
  for (const s of scenes) {
    const own = layoutFindings.filter((raw) => {
      const f = Finding.safeParse(raw);
      return f.success && owner(f.data) === s.sid;
    });
    const problems = frameClippingProblems({ layout: { findings: own } });
    if (problems.length > 0) verdict.layout.set(s.sid, problems);
  }
  return verdict;
}
