import { StudixError } from "@studix/shared";
import { z } from "zod";

/**
 * A film scene stored as a versioned `code` asset: the edit decision list (EDL) of one scene and the scene
 * module (sets, cards, cels, weather, cameras, FX and edit cues) that runs on the ported film engine. A
 * composition shot names the asset; the renderer bundles the module against the engine and captures it.
 *
 * Media is never a path: a string `asset:<ir-asset-id>` anywhere in the EDL or the module resolves to the
 * IR asset's local copy inside the project, so a scene renders only from hash-verified tenant assets.
 */
export const FILM_SCENE_MIME = "application/vnd.studix.film-scene+json";
export const FILM_SCENE_FORMAT = "studix.film-scene";
/** Engine contract the package is written for (bumped when the ported engine changes incompatibly). */
export const FILM_ENGINE_VERSION = 1;

/** Largest scene module accepted (the engine itself is bundled separately). */
const MAX_MODULE_BYTES = 256 * 1024;
const Seconds = z.number().min(0).max(3600);
const ShotId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "expected a shot id of letters, digits, _ or -");
const CssColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected a hex colour");

const DialogueWord = z.looseObject({ text: z.string().min(1).max(80), t0: Seconds });

const DialogueLine = z
  .looseObject({
    speaker: z.string().max(64).optional(),
    t0: Seconds,
    t1: Seconds,
    text: z.string().min(1).max(500),
    /** Translation shown as the second caption line. */
    tr: z.string().max(500).optional(),
    words: z.array(DialogueWord).max(200).optional(),
    /** Caption lift in px from the frame bottom. */
    cap_bottom: z.number().min(0).max(4000).optional(),
  })
  .refine((l) => l.t1 > l.t0, { message: "t1 must be after t0", path: ["t1"] });

const FilmShot = z
  .looseObject({
    id: ShotId,
    kind: z.enum(["gl", "cel", "video"]),
    start: Seconds,
    end: Seconds,
    /** gl: scene-module set id. */
    set: z.string().max(64).optional(),
    /** cel: still image (`asset:<id>`). */
    img: z.string().max(200).optional(),
    /** video: clip (`asset:<id>`), already conformed to the shot. */
    src: z.string().max(200).optional(),
    /** video: seconds into the clip. */
    in: Seconds.optional(),
    speed: z.number().positive().max(8).optional(),
    xfade: z.number().min(0).max(10).optional(),
    dialogue: z.array(DialogueLine).max(50).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.end <= s.start) ctx.addIssue({ code: "custom", message: "end must be after start", path: ["end"] });
    if (s.kind === "cel" && !s.img)
      ctx.addIssue({ code: "custom", message: "cel shots need img", path: ["img"] });
    if (s.kind === "video" && !s.src)
      ctx.addIssue({ code: "custom", message: "video shots need src", path: ["src"] });
    if (s.speed !== undefined && s.speed !== 1)
      ctx.addIssue({
        code: "custom",
        message: "speed other than 1 needs a conformed clip; retime the clip and reference that asset",
        path: ["speed"],
      });
  });
export type FilmShot = z.infer<typeof FilmShot>;

export const FilmEdl = z
  .looseObject({
    fps: z.number().int().min(1).max(120),
    duration: z.number().positive().max(3600),
    width: z.number().int().min(16).max(3840).optional(),
    height: z.number().int().min(16).max(3840).optional(),
    title: z
      .looseObject({
        text: z.string().min(1).max(120),
        sub: z.string().max(120).optional(),
        at: Seconds,
        dur: z.number().positive().max(10).optional(),
      })
      .optional(),
    fade: z
      .looseObject({ in: z.number().min(0).max(10).optional(), out: z.number().min(0).max(10).optional() })
      .optional(),
    captions: z
      .looseObject({ highlight: CssColor.optional(), hold: z.number().min(0).max(5).optional() })
      .optional(),
    speakers: z
      .record(
        z.string().max(64),
        z.looseObject({
          name: z.string().max(120).optional(),
          color: CssColor.optional(),
          hl: CssColor.optional(),
        }),
      )
      .optional(),
    shots: z.array(FilmShot).min(1).max(200),
  })
  .superRefine((edl, ctx) => {
    const ids = new Set<string>();
    let cursor = 0;
    const eps = 1e-6;
    edl.shots.forEach((s, i) => {
      if (ids.has(s.id))
        ctx.addIssue({ code: "custom", message: `duplicate shot id "${s.id}"`, path: ["shots", i, "id"] });
      ids.add(s.id);
      // The engine looks shots up by time: they must tile [0, duration] in order, with no gap or overlap.
      if (Math.abs(s.start - cursor) > eps)
        ctx.addIssue({
          code: "custom",
          message: `shot starts at ${s.start}s, expected ${cursor}s`,
          path: ["shots", i, "start"],
        });
      cursor = s.end;
    });
    if (Math.abs(cursor - edl.duration) > eps)
      ctx.addIssue({
        code: "custom",
        message: `shots end at ${cursor}s, the EDL lasts ${edl.duration}s`,
        path: ["shots"],
      });
  });
export type FilmEdl = z.infer<typeof FilmEdl>;

export const FilmScenePackage = z.object({
  format: z.literal(FILM_SCENE_FORMAT),
  engine: z.literal(FILM_ENGINE_VERSION),
  /** BCP 47 language of the spoken captions (the page `lang`). */
  lang: z
    .string()
    .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
    .optional(),
  edl: FilmEdl,
  /**
   * ES module source exporting `scene` (required), `fxCues(t, shot, fx)` and `editCues(kit)`. It may import
   * only `engine/<path>` (the ported engine), `three`, `edl` (this EDL) and `params` (the shot params).
   */
  module: z
    .string()
    .min(1)
    .refine((m) => Buffer.byteLength(m, "utf8") <= MAX_MODULE_BYTES, { message: "module is too large" }),
});
export type FilmScenePackage = z.infer<typeof FilmScenePackage>;

const ASSET_TOKEN = /asset:([a-z0-9][a-z0-9-]{0,63})/g;

/** IR asset ids referenced as `asset:<id>` by the EDL or the module, sorted. */
export function filmSceneAssetIds(pkg: FilmScenePackage): string[] {
  const ids = new Set<string>();
  const text = `${JSON.stringify(pkg.edl)}\n${pkg.module}`;
  for (const m of text.matchAll(ASSET_TOKEN)) ids.add(m[1]!);
  return [...ids].sort();
}

/** Replace every `asset:<id>` token in `text` with the project path of that asset. */
export function resolveAssetTokens(text: string, paths: ReadonlyMap<string, string>): string {
  return text.replace(ASSET_TOKEN, (token, id: string) => paths.get(id) ?? token);
}

/** Parse a film scene package from the code asset's bytes; a malformed package is a VALIDATION error. */
export function parseFilmScenePackage(raw: string, assetId: string): FilmScenePackage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new StudixError("VALIDATION", `Code asset "${assetId}" is not valid JSON`, {
      cause: err,
      retryable: false,
      details: { assetId },
    });
  }
  const parsed = FilmScenePackage.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "/"}: ${i.message}`);
    throw new StudixError("VALIDATION", `Code asset "${assetId}" is not a film scene: ${issues[0]}`, {
      retryable: false,
      details: { assetId, issues },
      suggestedAction: `Store the scene as ${FILM_SCENE_MIME} with format "${FILM_SCENE_FORMAT}" and engine ${FILM_ENGINE_VERSION}.`,
    });
  }
  return parsed.data;
}
