import { z } from "zod";
import { ColorValue, IrId, Milliseconds, PositiveMilliseconds } from "./primitives.ts";

/** Typography role resolved against the brand fonts by the renderer. */
export const TextStyleRole = z.enum(["display", "heading", "body", "caption"]);
export type TextStyleRole = z.infer<typeof TextStyleRole>;

/** Renderer-neutral style references (tokens, not CSS). */
export const ShotStyle = z.object({
  textStyle: TextStyleRole.optional(),
  color: ColorValue.optional(),
  background: ColorValue.optional(),
  align: z.enum(["start", "center", "end"]).optional(),
  region: z.enum(["top", "middle", "bottom", "full"]).optional(),
  emphasis: z.enum(["none", "low", "high"]).optional(),
});
export type ShotStyle = z.infer<typeof ShotStyle>;

export const MotionPreset = z.enum([
  "none",
  "fade",
  "slide-up",
  "slide-down",
  "slide-left",
  "slide-right",
  "scale",
  "pop",
]);
export type MotionPreset = z.infer<typeof MotionPreset>;

export const ShotAnimation = z.object({
  enter: MotionPreset.optional(),
  exit: MotionPreset.optional(),
  /** Duration of each enter/exit animation. */
  durationMs: z.number().int().min(0).max(5000).optional(),
});
export type ShotAnimation = z.infer<typeof ShotAnimation>;

/** Fields shared by every shot. Timing is relative to the start of the enclosing scene. */
const ShotBase = z.object({
  id: IrId,
  startMs: Milliseconds,
  durationMs: PositiveMilliseconds,
  style: ShotStyle.optional(),
  animation: ShotAnimation.optional(),
});

export const TitleShot = ShotBase.extend({
  type: z.literal("title"),
  text: z.string().min(1).max(160),
  subtitle: z.string().min(1).max(240).optional(),
});

export const TextShot = ShotBase.extend({
  type: z.literal("text"),
  text: z.string().min(1).max(500),
});

export const ImageShot = ShotBase.extend({
  type: z.literal("image"),
  assetId: IrId,
  alt: z.string().max(300),
  fit: z.enum(["cover", "contain"]).optional(),
});

export const VideoShot = ShotBase.extend({
  type: z.literal("video"),
  assetId: IrId,
  /** Offset into the source clip. */
  trimStartMs: Milliseconds.optional(),
  muted: z.boolean().optional(),
  fit: z.enum(["cover", "contain"]).optional(),
});

export const LogoShot = ShotBase.extend({
  type: z.literal("logo"),
  /** Logo asset id; when omitted the brand kit logo is used, else `text` is set as a wordmark. */
  assetId: IrId.optional(),
  text: z.string().min(1).max(60).optional(),
});

export const CtaShot = ShotBase.extend({
  type: z.literal("cta"),
  text: z.string().min(1).max(120),
  /** Displayed destination (e.g. a domain); not fetched by renderers. */
  url: z.string().max(300).optional(),
});

/** Composition parameter name: an identifier, so params stay plain data handed to the composition. */
const ParamName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "expected an identifier");

/**
 * A declarative composition (an HTML composition or a GL scene) stored as a versioned `code` asset. The IR
 * only names the pinned asset, an entry and plain parameters; how the code is executed is the renderer's
 * concern, so the IR stays declarative and renderer-neutral.
 */
export const CompositionShot = ShotBase.extend({
  type: z.literal("composition"),
  /** Code asset id from the IR `assets` list; it must carry an `assetVersionId` (see validateVideoIR). */
  assetId: IrId,
  /** Named entry inside the code asset (exported scene or element id); the asset's default when omitted. */
  entry: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/, "expected an identifier")
    .optional(),
  params: z
    .record(ParamName, z.union([z.string().max(500), z.number(), z.boolean()]))
    .refine((params) => Object.keys(params).length <= 50, { message: "at most 50 params" })
    .optional(),
});

const Label = (max: number) => z.string().trim().min(1).max(max);

/**
 * A built-in visual layout with typed content, drawn and animated by the renderer itself (no code asset):
 * - `prompt-box`: a text field that types `text` in, with an optional send button `action`;
 * - `code`: up to 10 lines of code shown line by line, `highlight` lines (0-based) marked;
 * - `chips`: a `hub` label wired to 2-6 `items`;
 * - `checklist`: 2-6 steps, each `done`, `active` or `todo`, ticked off in order;
 * - `counter`: a number rolling from `from` to `to`, with an optional prefix, suffix and label;
 * - `cards-row`: 2-5 cards side by side, the `highlight` one raised;
 * - `swatches`: 2-6 colour swatches with optional labels;
 * - `stat`: one big `value` and its `label`.
 */
export const LayoutSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt-box"), text: Label(160), action: Label(24).optional() }),
  z.object({
    kind: z.literal("code"),
    lines: z.array(z.string().max(64)).min(1).max(10),
    highlight: z.array(z.number().int().min(0).max(9)).max(10).optional(),
    title: Label(40).optional(),
  }),
  z.object({ kind: z.literal("chips"), hub: Label(32), items: z.array(Label(28)).min(2).max(6) }),
  z.object({
    kind: z.literal("checklist"),
    items: z
      .array(z.object({ label: Label(48), state: z.enum(["done", "active", "todo"]) }))
      .min(2)
      .max(6),
  }),
  z.object({
    kind: z.literal("counter"),
    from: z.number().int().min(0).max(999_999_999),
    to: z.number().int().min(0).max(999_999_999),
    prefix: Label(12).optional(),
    suffix: Label(12).optional(),
    label: Label(60).optional(),
  }),
  z.object({
    kind: z.literal("cards-row"),
    items: z.array(Label(40)).min(2).max(5),
    highlight: z.number().int().min(0).max(4).optional(),
  }),
  z.object({
    kind: z.literal("swatches"),
    items: z
      .array(z.object({ color: ColorValue, label: Label(24).optional() }))
      .min(2)
      .max(6),
  }),
  z.object({ kind: z.literal("stat"), value: Label(16), label: Label(80) }),
]);
export type LayoutSpec = z.infer<typeof LayoutSpec>;
export type LayoutKind = LayoutSpec["kind"];
export const LAYOUT_KINDS = [
  "prompt-box",
  "code",
  "chips",
  "checklist",
  "counter",
  "cards-row",
  "swatches",
  "stat",
] as const satisfies readonly LayoutKind[];

/** A built-in layout (`LayoutSpec`) the renderer draws and animates from its typed content. */
export const LayoutShot = ShotBase.extend({
  type: z.literal("layout"),
  layout: LayoutSpec,
});

export const SHOT_TYPES = [
  "title",
  "text",
  "image",
  "video",
  "logo",
  "cta",
  "composition",
  "layout",
] as const;
export const ShotType = z.enum(SHOT_TYPES);
export type ShotType = z.infer<typeof ShotType>;

export const Shot = z.discriminatedUnion("type", [
  TitleShot,
  TextShot,
  ImageShot,
  VideoShot,
  LogoShot,
  CtaShot,
  CompositionShot,
  LayoutShot,
]);
export type Shot = z.infer<typeof Shot>;
