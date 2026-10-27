import { z } from "zod";
import { BrandKit } from "./brand-kit.ts";
import { AspectRatio, LanguageTag } from "./primitives.ts";

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
  durationMs: z.number().int().min(1000).max(600_000).optional(),
  brand: BrandKit.optional(),
  /** Storage keys or URLs of reference material supplied by the user. */
  references: z.array(z.string().min(1).max(2048)).max(20).optional(),
  constraints: z.array(z.string().min(1).max(300)).max(20).optional(),
});
export type CreativeBrief = z.infer<typeof CreativeBrief>;
