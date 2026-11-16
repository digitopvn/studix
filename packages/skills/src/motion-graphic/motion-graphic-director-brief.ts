import { MARK_SVG_CHARS } from "@studix/renderers";
import { parseModelJson } from "@studix/shared";
import { z } from "zod";
import { truncateText } from "../vietnamese-safe-text.ts";

/**
 * The director's brief (direction v4, the artifact script): one idea for the film, the reusable on-screen
 * artifacts (`props`) with their verbatim lines, the sample prompt the film threads through (`thread`) and,
 * per scene, the verbatim strings it shows (`copy`), its hero line, its framing and the prop it carries across
 * the cut.
 *
 * Models drift in harmless ways: a few characters over a length, numbers as strings, `focal_words` for
 * `focalWords`, a fourth focal word, a stray key, the object wrapped in a JSON string or fence. The schemas
 * absorb that drift (each step only touches a value the strict schema would reject), so only a real structural
 * error earns the agent's schema repair turn. Verbatim on-screen text is never cut: it parses under a generous
 * hard cap, and `directionIssues` sends anything over the script's limits back to the director as a repair.
 */

/** Limits of the artifact script; `directionIssues` reports every breach as a repair issue. */
export const DIRECTION_SCRIPT_LIMITS = {
  threadChars: 90,
  props: 6,
  propLines: 8,
  lineChars: 80,
  copyMin: 3,
  copyMax: 10,
  copyChars: 80,
  heroChars: 80,
  /** Close scenes the film needs at least (fewer when the film is too short to alternate into three). */
  closeScenes: 3,
  /** Middle scenes the thread must come back in (fewer when the film has fewer middle scenes). */
  threadMiddleScenes: 2,
} as const;

/** What a verbatim string may hold before it is a structural error rather than a repairable overshoot. */
const VERBATIM_HARD_CHARS = 400;

export const PROP_KINDS = [
  "prompt",
  "code",
  "tool-call",
  "rail",
  "tiles",
  "player",
  "meter",
  "stat",
] as const;
export const FRAMINGS = ["close", "medium", "wide"] as const;

const rectSchema = z.object({
  x: z.number().min(-10_000).max(10_000),
  y: z.number().min(-10_000).max(10_000),
  w: z.number().min(0).max(10_000),
  h: z.number().min(0).max(10_000),
  r: z.number().min(0).max(5_000).optional(),
});

/** A string a model may overshoot: trimmed and cut at `max` instead of rejected. Never for on-screen copy. */
export const softText = (max: number) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    // truncateText counts what is visible; the schema counts UTF-16 units, so cut again when they differ.
    const cut = truncateText(v.trim(), max);
    return cut.length > max ? cut.slice(0, max) : cut;
  }, z.string().trim().min(1).max(max));
/** Verbatim on-screen text: trimmed, never cut. */
const verbatim = z.string().trim().min(1).max(VERBATIM_HARD_CHARS);
/** A list of verbatim strings; one string reads as a list of one, blank entries are dropped. */
const verbatimList = (hardMax: number) =>
  z.preprocess((v) => {
    const list = typeof v === "string" ? [v] : unstring(v);
    return Array.isArray(list) ? list.filter((s) => !(typeof s === "string" && s.trim() === "")) : list;
  }, z.array(verbatim).max(hardMax));
/** A number a model may send as a numeric string. */
export const looseNumber = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v),
    schema,
  );
/** A JSON value a model may send as a (fenced) JSON string. */
export const unstring = (v: unknown) => {
  if (typeof v !== "string") return v;
  try {
    return parseModelJson(v);
  } catch {
    return v;
  }
};
/** Keys compared without case, `_` or `-`, so `focal_words` and `FocalWords` read as `focalWords`. */
export const canonicalKeys = (names: readonly string[]) => (v: unknown) => {
  const value = unstring(v);
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const byKey = new Map(names.map((n) => [n.toLowerCase(), n]));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    const name = byKey.get(key.toLowerCase().replace(/[_-]/g, "")) ?? key;
    if (!(name in out) || name === key) out[name] = val;
  }
  return out;
};
/** An enum value compared without case, `_` or spaces (`Tool_Call` reads as `tool-call`); unknown is dropped. */
const looseEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return undefined;
    const key = v
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, "-");
    return (values as readonly string[]).includes(key) ? key : undefined;
  }, z.enum(values).optional());
/** A prop id: trimmed text, a number read as text. */
const propId = z.preprocess((v) => (typeof v === "number" ? String(v) : v), softText(40));

export const Rect = z.preprocess(
  canonicalKeys(["x", "y", "w", "h", "r"]),
  z.object({
    x: looseNumber(rectSchema.shape.x),
    y: looseNumber(rectSchema.shape.y),
    w: looseNumber(rectSchema.shape.w),
    h: looseNumber(rectSchema.shape.h),
    r: looseNumber(rectSchema.shape.r),
  }),
);
/** A rect that does not read as one is dropped. */
const optionalRect = z.preprocess(
  (v) => (v == null || Rect.safeParse(v).success ? v : null),
  Rect.nullable().optional(),
);

/** One reusable on-screen artifact, defined once and shown by the scenes that list its id. */
const DirectionProp = z.preprocess(
  canonicalKeys(["id", "kind", "lines"]),
  z.object({
    id: propId,
    kind: looseEnum(PROP_KINDS),
    /** The artifact's text, verbatim, one entry per line. */
    lines: verbatimList(40),
  }),
);
export type DirectionProp = z.infer<typeof DirectionProp>;

const SCENE_KEYS = [
  "scene",
  "shot",
  "focalWords",
  "exit",
  "exitRect",
  "copy",
  "hero",
  "props",
  "framing",
  "carry",
] as const;
const DirectionScene = z.preprocess(
  canonicalKeys(SCENE_KEYS),
  z.object({
    /** Scene number from 1, in film order. */
    scene: looseNumber(z.number().int().min(1).max(20)),
    /** What the frame shows and how it moves: the product working, not a headline over a device. */
    shot: softText(500),
    /** One to three spoken words of this scene that the big moves land on, as they are spoken. */
    focalWords: z.preprocess(
      (v) => {
        const list = typeof v === "string" ? [v] : v;
        return Array.isArray(list)
          ? list.filter((w) => typeof w === "string" && w.trim() !== "").slice(0, 3)
          : list;
      },
      z.array(softText(40)).min(1).max(3),
    ),
    /** How the scene hands off to the next one (the carried prop's last pose, a cut, a morph). */
    exit: z.preprocess(
      (v) => (v === undefined || v === null || v === "" ? "a straight cut" : v),
      softText(240),
    ),
    /** Where the carried prop sits at this scene's last frame, in px; null when it is not on screen. */
    exitRect: optionalRect,
    /** Every string the scene shows, verbatim. Optional at parse (older briefs); the director must write it. */
    copy: verbatimList(30).optional(),
    /** The artifact's main line, shown at headline size. */
    hero: verbatim.optional(),
    /** Ids of the props on screen in this scene. */
    props: z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(propId).max(20)).optional(),
    framing: looseEnum(FRAMINGS),
    /** Id of the prop that crosses the cut into the next scene. */
    carry: z.preprocess((v) => (v === null || v === "" ? undefined : v), propId.optional()),
  }),
);
export type DirectionScene = z.infer<typeof DirectionScene>;

/**
 * The film system: the product surface the film moves through and where its main artifact sits in the hook,
 * so the call to action closes the loop in the same place. Optional: a brief stored before film mode has none.
 */
const FilmSystem = z.preprocess(
  canonicalKeys(["surface", "anchor"]),
  z.object({
    /** What the product is and the states it moves through across the film, in a sentence or two. */
    surface: softText(400),
    /** The hook's main artifact rect in frame px; the closing scene mirrors it. Null when it has none. */
    anchor: optionalRect,
  }),
);
export type FilmSystem = z.infer<typeof FilmSystem>;

/** The director's brief: one idea for the whole film, its artifacts and what each scene shows, verbatim. */
export const DirectionBrief = z.preprocess(
  canonicalKeys(["concept", "motif", "rhythm", "system", "thread", "props", "mark", "scenes"]),
  z.object({
    /** The film's one idea, in a sentence or two. */
    concept: softText(400),
    /** The one artifact carried through every scene, and how it changes. */
    motif: softText(300),
    /** Pacing: where the film breathes, where it hits (drops, the call to action). */
    rhythm: softText(300),
    /** The film system; a system that does not read as one is dropped (the scenes then share only the theme). */
    system: z.preprocess((v) => (FilmSystem.safeParse(v).success ? v : undefined), FilmSystem.optional()),
    /** The sample prompt a user types, verbatim: in the hook, in middle scenes and back in the call to action. */
    thread: z.preprocess((v) => (v === null || v === "" ? undefined : v), verbatim.optional()),
    /** The film's reusable artifacts. */
    props: z.preprocess(
      (v) => (v === null ? undefined : unstring(v)),
      z.array(DirectionProp).max(20).optional(),
    ),
    /**
     * A small inline SVG mark, only when the brand kit has no logo. Sanitized before use (plain shapes only); a
     * mark that is not usable falls back to a monogram.
     */
    mark: z.preprocess(
      (v) => (typeof v === "string" && v.trim() !== "" && v.length <= MARK_SVG_CHARS ? v : undefined),
      z.string().optional(),
    ),
    scenes: z.preprocess(
      (v) => (Array.isArray(v) ? v.slice(0, 20) : unstring(v)),
      z.array(DirectionScene).min(1).max(20),
    ),
  }),
);
export type DirectionBrief = z.infer<typeof DirectionBrief>;

/** `{ direction }`, also read from a bare brief or a brief sent as a JSON string. */
export const DirectionOutput = z.preprocess(
  (v) => {
    const value = canonicalKeys(["direction"])(v);
    if (value && typeof value === "object" && !("direction" in value) && "scenes" in value)
      return { direction: value };
    return value;
  },
  z.object({ direction: DirectionBrief }),
);

/** Text compared the way the fragment check compares it: every whitespace removed. */
export const squeeze = (text: string) => text.replace(/\s+/g, "");

/** The props a scene lists, resolved in the order it lists them; unknown ids are skipped. */
export function sceneProps(direction: DirectionBrief, scene: DirectionScene): DirectionProp[] {
  const byId = new Map((direction.props ?? []).map((p) => [p.id, p]));
  return (scene.props ?? []).flatMap((id) => byId.get(id) ?? []);
}

type Issue = { path: string; message: string };
const L = DIRECTION_SCRIPT_LIMITS;
const quote = (s: string) => `"${truncateText(s, 40)}"`;

/**
 * Where the brief breaks the artifact script, as repair issues for the director: missing or over-long verbatim
 * text, prop references that do not resolve, framing that repeats or never comes close, and a thread that does
 * not run through the film. [] when the script is complete.
 */
export function directionIssues(direction: DirectionBrief): Issue[] {
  const issues: Issue[] = [];
  const props = direction.props ?? [];
  const ids = new Set(props.map((p) => p.id));
  const thread = direction.thread;
  if (!thread) issues.push({ path: "direction.thread", message: "write the film's sample prompt (thread)" });
  else if (thread.length > L.threadChars)
    issues.push({ path: "direction.thread", message: `at most ${L.threadChars} characters; shorten it` });
  if (props.length > L.props)
    issues.push({ path: "direction.props", message: `at most ${L.props} props; merge or drop some` });
  props.forEach((p, i) => {
    const path = `direction.props.${i}`;
    if (!p.kind) issues.push({ path: `${path}.kind`, message: `kind is one of ${PROP_KINDS.join(", ")}` });
    if (p.lines.length === 0 || p.lines.length > L.propLines)
      issues.push({ path: `${path}.lines`, message: `one to ${L.propLines} lines of verbatim text` });
    p.lines.forEach((line, j) => {
      if (line.length > L.lineChars)
        issues.push({
          path: `${path}.lines.${j}`,
          message: `${quote(line)} is over ${L.lineChars} characters; shorten or split it`,
        });
    });
  });
  if (ids.size < props.length) issues.push({ path: "direction.props", message: "every prop id is unique" });

  const scenes = direction.scenes;
  scenes.forEach((d, i) => {
    const path = `direction.scenes.${i}`;
    const copy = d.copy ?? [];
    if (copy.length < L.copyMin || copy.length > L.copyMax)
      issues.push({
        path: `${path}.copy`,
        message: `${L.copyMin} to ${L.copyMax} verbatim strings this scene shows (it has ${copy.length})`,
      });
    copy.forEach((c, j) => {
      if (c.length > L.copyChars)
        issues.push({
          path: `${path}.copy.${j}`,
          message: `${quote(c)} is over ${L.copyChars} characters; shorten or split it`,
        });
    });
    if (!d.hero) issues.push({ path: `${path}.hero`, message: "write the scene's hero line" });
    else if (d.hero.length > L.heroChars)
      issues.push({ path: `${path}.hero`, message: `at most ${L.heroChars} characters` });
    if (!d.framing) issues.push({ path: `${path}.framing`, message: `framing is ${FRAMINGS.join(", ")}` });
    else if (i > 0 && scenes[i - 1]?.framing === d.framing)
      issues.push({
        path: `${path}.framing`,
        message: `scene ${d.scene} repeats the ${d.framing} framing of the scene before; change one`,
      });
    const unknown = (d.props ?? []).filter((id) => !ids.has(id));
    if (unknown.length > 0)
      issues.push({ path: `${path}.props`, message: `unknown prop ids: ${unknown.map(quote).join(", ")}` });
    if (d.carry && !ids.has(d.carry))
      issues.push({ path: `${path}.carry`, message: `unknown prop id ${quote(d.carry)}` });
  });

  const needClose = Math.min(L.closeScenes, Math.ceil(scenes.length / 2));
  if (scenes.filter((d) => d.framing === "close").length < needClose)
    issues.push({ path: "direction.scenes", message: `at least ${needClose} scenes are framed close` });

  if (thread) {
    const t = squeeze(thread);
    // The thread may sit in the scene's copy or in a line of a prop the scene shows.
    const shows = (d: DirectionScene) =>
      [...(d.copy ?? []), ...sceneProps(direction, d).flatMap((p) => p.lines)].some((s) =>
        squeeze(s).includes(t),
      );
    const last = scenes.length - 1;
    const ends: Array<[number, string]> = [
      [0, "the hook"],
      [last, "the call to action"],
    ];
    for (const [i, what] of ends)
      if (scenes[i] && !shows(scenes[i]))
        issues.push({ path: `direction.scenes.${i}.copy`, message: `${what} shows the thread verbatim` });
    const middle = scenes.slice(1, last);
    const needMiddle = Math.min(L.threadMiddleScenes, middle.length);
    if (middle.filter(shows).length < needMiddle)
      issues.push({
        path: "direction.scenes",
        message: `the thread comes back verbatim in at least ${needMiddle} middle scenes`,
      });
  }
  return issues;
}
