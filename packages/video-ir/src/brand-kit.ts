import { z } from "zod";
import { HexColor, IrId } from "./primitives.ts";

export const BrandPalette = z.object({
  primary: HexColor,
  secondary: HexColor.optional(),
  accent: HexColor.optional(),
  background: HexColor,
  foreground: HexColor,
  muted: HexColor.optional(),
});
export type BrandPalette = z.infer<typeof BrandPalette>;

export const BrandFonts = z.object({
  heading: z.string().min(1).max(80),
  body: z.string().min(1).max(80),
});
export type BrandFonts = z.infer<typeof BrandFonts>;

/** Brand identity shared by briefs and IR documents. Logos are referenced by IR asset id. */
export const BrandKit = z.object({
  name: z.string().min(1).max(120),
  tagline: z.string().max(200).optional(),
  palette: BrandPalette,
  fonts: BrandFonts,
  /** Asset id (in the enclosing IR `assets`) of the primary logo. */
  logoAssetId: IrId.optional(),
  /** Tone-of-voice keywords, e.g. ["confident", "warm"]. */
  voice: z.array(z.string().min(1).max(60)).max(12).optional(),
  /** Hard brand rules a planner and QA must respect. */
  rules: z.array(z.string().min(1).max(300)).max(20).optional(),
});
export type BrandKit = z.infer<typeof BrandKit>;
