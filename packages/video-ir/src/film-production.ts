import { z } from "zod";
import { HexColor, IrId, LanguageTag, Milliseconds } from "./primitives.ts";
import type { Storyboard } from "./storyboard.ts";
import {
  safeValidate,
  toPointer,
  type ValidationIssue,
  type ValidationIssueCode,
  type ValidationResult,
} from "./validation-result.ts";

/**
 * Character, continuity and lipsync plan of a narrative film, shared by the `anime` and `long-form-film`
 * packs. It sits beside a Storyboard (same character and shot ids) and adds what identity-safe generation
 * needs: a versioned character bible with canonical reference images, the continuity state each shot
 * hands on, and the dialogue cues lipsync is driven by.
 */
export const FILM_PRODUCTION_SCHEMA_VERSION = 1 as const;

export const ReferenceView = z.enum([
  "front",
  "three_quarter_left",
  "three_quarter_right",
  "profile",
  "full_body",
  "back",
  "expression",
  "detail",
  "turnaround",
  "expression_sheet",
  "wide",
]);
export type ReferenceView = z.infer<typeof ReferenceView>;

/** `canonical` references condition generation; `candidate` await review; `retired` are kept for history. */
export const ReferenceStatus = z.enum(["canonical", "candidate", "retired"]);
export type ReferenceStatus = z.infer<typeof ReferenceStatus>;

export const CharacterReference = z.object({
  id: IrId,
  /** Image asset in the storyboard `assets` list. */
  assetId: IrId,
  view: ReferenceView,
  status: ReferenceStatus,
  /** Identity version the image depicts; canonical references must match the bible's version. */
  version: z.number().int().min(1).max(1000),
  /** Candidate reference this one was promoted from. */
  promotedFrom: IrId.optional(),
});
export type CharacterReference = z.infer<typeof CharacterReference>;

export const CharacterBible = z.object({
  /** Storyboard character this bible describes. */
  characterId: IrId,
  /** Bumped whenever the design changes; references of an older version can no longer be canonical. */
  identityVersion: z.number().int().min(1).max(1000),
  /** Visual traits every image of the character must keep (hair, eyes, silhouette, marks). */
  anchors: z.array(z.string().min(1).max(300)).min(1).max(24),
  palette: z.array(z.object({ name: z.string().min(1).max(60), hex: HexColor })).max(16),
  handedness: z.enum(["left", "right", "ambidextrous"]).optional(),
  /** Traits generation must avoid (the drift seen so far). */
  negatives: z.array(z.string().min(1).max(300)).max(24),
  voice: z
    .object({
      direction: z.string().max(500).optional(),
      /** Voice id of the speech provider; the storyboard character's `voice` when absent. */
      voiceRef: z.string().min(1).max(200).optional(),
      language: LanguageTag.optional(),
    })
    .optional(),
  acting: z.string().max(1000).optional(),
  references: z.array(CharacterReference).max(32),
});
export type CharacterBible = z.infer<typeof CharacterBible>;

export const LipsyncMode = z.enum(["none", "native", "dedicated"]);
export type LipsyncMode = z.infer<typeof LipsyncMode>;

/** Spend class of a shot: how much identity fidelity (and money) its generation gets. */
export const RenderClass = z.enum(["PREVIS", "CHEAP_BROLL", "STANDARD", "CHARACTER_CRITICAL", "HERO"]);
export type RenderClass = z.infer<typeof RenderClass>;

/**
 * How a shot joins the previous one: `locked-composition` keeps the framing (a match cut or held plate),
 * `camera-transition` moves the camera continuously, `intentional-cut` is a deliberate cut. Boundary QA
 * thresholds follow it.
 */
export const ShotBoundary = z.enum(["locked-composition", "camera-transition", "intentional-cut"]);
export type ShotBoundary = z.infer<typeof ShotBoundary>;

/** Screen position values the continuity diff understands for `position.<character>` keys. */
export const SCREEN_POSITIONS = ["left", "center", "right", "offscreen"] as const;
/** Values of the `direction` key that mean "not moving"; any other value is a movement direction. */
export const STILL_DIRECTIONS = ["static", "none"] as const;

const StateKey = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/,
    "state keys are dotted lowercase, e.g. wardrobe.mai",
  );

export const ShotPlan = z.object({
  /** Storyboard shot this plan belongs to. */
  shotId: IrId,
  renderClass: RenderClass,
  /** Characters whose mouths are on screen while they speak. */
  visibleSpeakers: z.array(IrId).max(8),
  lipsync: LipsyncMode,
  /** Shot whose end state this one starts from. */
  continuityFrom: IrId.optional(),
  boundary: ShotBoundary.default("intentional-cut"),
  /**
   * State at the end of the shot, keyed `position.<character>`, `wardrobe.<character>`,
   * `condition.<character>`, `prop.<prop>`, `direction`, ... A key carried from `continuityFrom` with a new
   * value is a continuity break unless it is declared in `changes`.
   */
  state: z.record(StateKey, z.string().min(1).max(200)),
  changes: z.array(z.object({ field: StateKey, reason: z.string().min(1).max(500) })).max(32),
  /** Character references that condition this shot's generation. */
  conditioningRefs: z.array(IrId).max(16).optional(),
});
export type ShotPlan = z.input<typeof ShotPlan>;
export type ShotPlanOutput = z.output<typeof ShotPlan>;

export const AlignedWord = z.object({
  text: z.string().min(1).max(200),
  startMs: Milliseconds,
  endMs: Milliseconds,
});
export type AlignedWord = z.infer<typeof AlignedWord>;

/** One spoken line: `temp` audio may drive previs; only `master` audio with an alignment drives lipsync. */
export const DialogueCue = z.object({
  id: IrId,
  shotId: IrId,
  characterId: IrId,
  text: z.string().min(1).max(1000),
  status: z.enum(["temp", "master"]),
  /** Audio asset in the storyboard `assets` list. */
  audioAssetId: IrId.optional(),
  alignment: z.object({ words: z.array(AlignedWord).min(1).max(2000) }).optional(),
});
export type DialogueCue = z.infer<typeof DialogueCue>;

export const FilmProduction = z.object({
  schemaVersion: z.literal(FILM_PRODUCTION_SCHEMA_VERSION),
  characters: z.array(CharacterBible).max(50),
  shots: z.array(ShotPlan).max(2000),
  dialogue: z.array(DialogueCue).max(5000),
});
export type FilmProduction = z.output<typeof FilmProduction>;
export type FilmProductionInput = z.input<typeof FilmProduction>;

/**
 * How far production has got, each phase adding requirements to the previous:
 * - `plan`: references resolve and continuity holds;
 * - `design`: every character on screen has a canonical reference of its current identity (the G1 sheet);
 * - `generation`: every lip-synced line has master audio and an alignment (audio first).
 */
export const FilmProductionPhase = z.enum(["plan", "design", "generation"]);
export type FilmProductionPhase = z.infer<typeof FilmProductionPhase>;

type Path = ReadonlyArray<string | number>;

const isFlip = (a: string, b: string) => (a === "left" && b === "right") || (a === "right" && b === "left");
const isMoving = (v: string) => !(STILL_DIRECTIONS as readonly string[]).includes(v);

/**
 * Whether a state key's change from `before` to `after` breaks continuity: positions only break on a
 * left/right flip (entering, leaving and centring are staging), direction only when the movement reverses
 * or turns while still moving, anything else on any change.
 */
export function isContinuityBreak(key: string, before: string, after: string): boolean {
  if (before === after) return false;
  if (key.startsWith("position.")) return isFlip(before, after);
  if (key === "direction") return isMoving(before) && isMoving(after);
  return true;
}

/** Cross-reference, continuity and lipsync invariants of a production against its storyboard. */
export function filmProductionIssues(
  production: FilmProduction,
  storyboard: Storyboard,
  phase: FilmProductionPhase = "plan",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: Path, code: ValidationIssueCode, message: string) =>
    issues.push({ path: toPointer(path), code, message });

  const assetKinds = new Map(storyboard.assets.map((a) => [a.id, a.kind]));
  const characters = new Set(storyboard.characters.map((c) => c.id));
  const shotCharacters = new Map<string, Set<string>>();
  for (const scene of storyboard.scenes) {
    for (const shot of scene.shots) shotCharacters.set(shot.id, new Set(shot.characterIds ?? []));
  }

  const bibles = new Map<string, CharacterBible>();
  const references = new Map<string, { characterId: string; ref: CharacterReference; current: boolean }>();
  for (const [i, bible] of production.characters.entries()) {
    const path = ["characters", i];
    if (bibles.has(bible.characterId))
      add([...path, "characterId"], "duplicate_id", `duplicate bible for "${bible.characterId}"`);
    if (!characters.has(bible.characterId))
      add([...path, "characterId"], "unknown_reference", `unknown character "${bible.characterId}"`);
    bibles.set(bible.characterId, bible);
    const canonicalViews = new Set<string>();
    const known = new Set(bible.references.map((r) => r.id));
    for (const [j, ref] of bible.references.entries()) {
      const rpath = [...path, "references", j];
      if (references.has(ref.id)) add([...rpath, "id"], "duplicate_id", `duplicate reference id "${ref.id}"`);
      const kind = assetKinds.get(ref.assetId);
      if (kind === undefined)
        add([...rpath, "assetId"], "unknown_reference", `unknown asset "${ref.assetId}"`);
      else if (kind !== "image")
        add([...rpath, "assetId"], "wrong_asset_kind", `reference "${ref.id}" must be an image, got ${kind}`);
      if (ref.status === "canonical") {
        if (ref.version !== bible.identityVersion)
          add(
            [...rpath, "version"],
            "continuity",
            `canonical reference "${ref.id}" depicts identity v${ref.version}, the bible is v${bible.identityVersion}`,
          );
        if (canonicalViews.has(ref.view))
          add([...rpath, "view"], "duplicate_id", `two canonical "${ref.view}" references`);
        canonicalViews.add(ref.view);
      }
      if (ref.promotedFrom !== undefined && !known.has(ref.promotedFrom))
        add([...rpath, "promotedFrom"], "unknown_reference", `unknown reference "${ref.promotedFrom}"`);
      references.set(ref.id, {
        characterId: bible.characterId,
        ref,
        current: ref.status === "canonical" && ref.version === bible.identityVersion,
      });
    }
  }

  const plans = new Map<string, ShotPlanOutput>();
  for (const [i, plan] of production.shots.entries()) {
    if (plans.has(plan.shotId))
      add(["shots", i, "shotId"], "duplicate_id", `duplicate plan for "${plan.shotId}"`);
    plans.set(plan.shotId, plan);
  }

  const cuesByShot = new Map<string, DialogueCue[]>();
  const cueIds = new Set<string>();
  for (const [i, cue] of production.dialogue.entries()) {
    const path = ["dialogue", i];
    if (cueIds.has(cue.id)) add([...path, "id"], "duplicate_id", `duplicate cue id "${cue.id}"`);
    cueIds.add(cue.id);
    if (!shotCharacters.has(cue.shotId))
      add([...path, "shotId"], "unknown_reference", `unknown shot "${cue.shotId}"`);
    if (!characters.has(cue.characterId))
      add([...path, "characterId"], "unknown_reference", `unknown character "${cue.characterId}"`);
    if (cue.audioAssetId !== undefined) {
      const kind = assetKinds.get(cue.audioAssetId);
      if (kind === undefined)
        add([...path, "audioAssetId"], "unknown_reference", `unknown asset "${cue.audioAssetId}"`);
      else if (kind !== "audio")
        add(
          [...path, "audioAssetId"],
          "wrong_asset_kind",
          `cue "${cue.id}" audio must be audio, got ${kind}`,
        );
    }
    let lastEnd = 0;
    for (const [j, word] of (cue.alignment?.words ?? []).entries()) {
      if (word.endMs <= word.startMs || word.startMs < lastEnd)
        add(
          [...path, "alignment", "words", j],
          "timeline",
          `word "${word.text}" overlaps or has no duration`,
        );
      lastEnd = Math.max(lastEnd, word.endMs);
    }
    const list = cuesByShot.get(cue.shotId) ?? [];
    list.push(cue);
    cuesByShot.set(cue.shotId, list);
  }

  for (const [i, plan] of production.shots.entries()) {
    const path = ["shots", i];
    const onScreen = shotCharacters.get(plan.shotId);
    if (onScreen === undefined) {
      add([...path, "shotId"], "unknown_reference", `unknown shot "${plan.shotId}"`);
      continue;
    }
    for (const [j, speaker] of plan.visibleSpeakers.entries()) {
      if (!onScreen.has(speaker))
        add(
          [...path, "visibleSpeakers", j],
          "unknown_reference",
          `visible speaker "${speaker}" is not in shot "${plan.shotId}"`,
        );
    }
    if (plan.visibleSpeakers.length > 0 && plan.lipsync === "none")
      add([...path, "lipsync"], "lipsync", `shot "${plan.shotId}" shows a speaker but plans no lipsync`);
    if (plan.visibleSpeakers.length === 0 && plan.lipsync !== "none")
      add([...path, "lipsync"], "lipsync", `shot "${plan.shotId}" routes lipsync with no visible speaker`);

    for (const [j, refId] of (plan.conditioningRefs ?? []).entries()) {
      const entry = references.get(refId);
      if (entry === undefined)
        add([...path, "conditioningRefs", j], "unknown_reference", `unknown reference "${refId}"`);
      else if (!entry.current)
        add(
          [...path, "conditioningRefs", j],
          "continuity",
          `reference "${refId}" is not a canonical reference of the current identity`,
        );
      else if (!onScreen.has(entry.characterId))
        add(
          [...path, "conditioningRefs", j],
          "unknown_reference",
          `"${entry.characterId}" is not in the shot`,
        );
    }

    if (plan.continuityFrom !== undefined) {
      const prev = plans.get(plan.continuityFrom);
      if (plan.continuityFrom === plan.shotId)
        add([...path, "continuityFrom"], "cycle", `shot "${plan.shotId}" continues from itself`);
      else if (prev === undefined)
        add([...path, "continuityFrom"], "unknown_reference", `no plan for shot "${plan.continuityFrom}"`);
      else {
        const declared = new Set(plan.changes.map((c) => c.field));
        for (const [key, after] of Object.entries(plan.state)) {
          const before = prev.state[key];
          if (before !== undefined && !declared.has(key) && isContinuityBreak(key, before, after))
            add(
              [...path, "state", key],
              "continuity",
              `"${key}" changes from "${before}" to "${after}" without a declared change`,
            );
        }
      }
    }

    if (phase === "design" || phase === "generation") {
      for (const characterId of onScreen) {
        const bible = bibles.get(characterId);
        const canonical = bible?.references.some((r) => references.get(r.id)?.current) ?? false;
        if (!canonical)
          add(
            [...path, "shotId"],
            "not_ready",
            `"${characterId}" in shot "${plan.shotId}" has no canonical reference of its current identity`,
          );
      }
    }
    if (phase === "generation" && plan.lipsync !== "none") {
      const cues = cuesByShot.get(plan.shotId) ?? [];
      for (const speaker of plan.visibleSpeakers) {
        const lines = cues.filter((c) => c.characterId === speaker);
        if (lines.length === 0 || lines.some((c) => c.status !== "master" || !c.audioAssetId || !c.alignment))
          add(
            [...path, "visibleSpeakers"],
            "not_ready",
            `lipsync in shot "${plan.shotId}" needs master audio and an alignment for "${speaker}" first`,
          );
      }
    }
  }

  for (const [si, scene] of storyboard.scenes.entries()) {
    for (const [i, shot] of scene.shots.entries()) {
      if ((shot.characterIds?.length ?? 0) > 0 && !plans.has(shot.id))
        add(
          ["scenes", si, "shots", i, "id"],
          "unknown_reference",
          `shot "${shot.id}" has no production plan`,
        );
    }
  }
  return issues;
}

/** Schema then cross-checks against the storyboard. Never throws. */
export function validateFilmProduction(
  input: unknown,
  storyboard: Storyboard,
  phase: FilmProductionPhase = "plan",
): ValidationResult<FilmProduction> {
  const parsed = safeValidate(FilmProduction, input);
  if (!parsed.ok) return parsed;
  const issues = filmProductionIssues(parsed.value, storyboard, phase);
  return issues.length === 0 ? parsed : { ok: false, issues };
}

/** Canonical references of a character's current identity, in bible order (for conditioning a prompt). */
export function canonicalReferences(production: FilmProduction, characterId: string): CharacterReference[] {
  const bible = production.characters.find((c) => c.characterId === characterId);
  if (!bible) return [];
  return bible.references.filter((r) => r.status === "canonical" && r.version === bible.identityVersion);
}
