import { z } from "zod";
import { BrandKit } from "./brand-kit.ts";
import { AspectRatio, HexColor, IrId, LanguageTag } from "./primitives.ts";

/** One beat of a creative direction: what the frame shows, the words on screen and the line spoken. */
export const CreativeBeat = z.object({
  /** What the frame shows; the prompt a storyboard frame or a clip is generated from. */
  visual: z.string().trim().min(1).max(600),
  /** Short on-screen line (a headline, not a paragraph). */
  onScreen: z.string().trim().min(1).max(120).optional(),
  /** Voice-over line spoken over the beat. */
  voiceover: z.string().trim().min(1).max(400).optional(),
});
export type CreativeBeat = z.infer<typeof CreativeBeat>;

/**
 * One creative direction of a multi-variant brief (one ad per direction). Directions share the brief's
 * brand, language, format and length; each brings its own angle, hook and, optionally, its beats.
 */
export const CreativeDirection = z.object({
  id: IrId,
  name: z.string().trim().min(1).max(120),
  /** The angle in a sentence or two. */
  concept: z.string().trim().min(1).max(1000),
  /** What the first seconds say or show to stop the scroll. */
  hook: z.string().trim().min(1).max(200).optional(),
  keyMessages: z.array(z.string().trim().min(1).max(300)).max(6).optional(),
  callToAction: z.string().trim().min(1).max(200).optional(),
  /** Look and feel of the frames (lighting, palette, lens), or a motion style profile id. */
  visualStyle: z.string().trim().min(1).max(300).optional(),
  /** The beats in order; planners derive them from the concept and messages when omitted. */
  beats: z.array(CreativeBeat).min(2).max(6).optional(),
});
export type CreativeDirection = z.infer<typeof CreativeDirection>;

/** What the user asked for, before any planning. Input to the planner and stored on the project. */
export const CreativeBrief = z.object({
  /** Free-form goal in the user's language, e.g. "Video giới thiệu thương hiệu cà phê 15 giây". */
  prompt: z.string().trim().min(1).max(4000),
  title: z.string().trim().min(1).max(200).optional(),
  language: LanguageTag.optional(),
  objective: z.enum(["awareness", "launch", "promotion", "explainer", "social", "other"]).optional(),
  audience: z.string().max(500).optional(),
  tone: z.array(z.string().min(1).max(60)).max(8).optional(),
  keyMessages: z.array(z.string().min(1).max(300)).max(10).optional(),
  callToAction: z.string().max(200).optional(),
  aspectRatio: AspectRatio.optional(),
  /** Length of the video, or of each variant when the brief has `directions`. */
  durationMs: z.number().int().min(1000).max(600_000).optional(),
  /**
   * Whether the video has a spoken voice-over (default true). False makes a voiceless video: no voice, no
   * captions read from it and no sound accent laid under it. Honoured by `motion-graphic`.
   */
  voiceover: z.boolean().optional(),
  brand: BrandKit.optional(),
  /**
   * The brand's website. Studix reads its name, theme colours and logo from the page for what `brand`,
   * `brandLogo` and `brandColors` leave unset. Honoured by `motion-graphic`.
   */
  brandUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
  /**
   * The brand's logo: an https URL of the image, or the uploaded image itself as a data URL (PNG, JPEG,
   * WebP or SVG, up to about 500 KB). Wins over a logo found at `brandUrl`. Honoured by `motion-graphic`.
   */
  brandLogo: z
    .union([
      z.url({ protocol: /^https$/ }).max(2048),
      z
        .string()
        .max(700_000)
        .regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/, "an image data URL"),
    ])
    .optional(),
  /**
   * Brand colours, the main one first: it becomes the accent (and the CTA fill) of the graphic, a second one
   * its secondary colour. Wins over colours found at `brandUrl`. Honoured by `motion-graphic`.
   */
  brandColors: z.array(HexColor).min(1).max(4).optional(),
  /** Storage keys or URLs of reference material supplied by the user. */
  references: z.array(z.string().min(1).max(2048)).max(20).optional(),
  constraints: z.array(z.string().min(1).max(300)).max(20).optional(),
  /** Creative directions for packs that make one variant per direction (e.g. marketing-video). */
  directions: z
    .array(CreativeDirection)
    .min(1)
    .max(6)
    .refine((ds) => new Set(ds.map((d) => d.id)).size === ds.length, {
      message: "direction ids must be unique",
    })
    .optional(),
});
export type CreativeBrief = z.infer<typeof CreativeBrief>;
