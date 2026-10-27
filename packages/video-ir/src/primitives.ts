import { z } from "zod";

/** Stable element id inside one IR document: lowercase kebab-case. */
export const IrId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase kebab-case");

export const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected #rrggbb or #rrggbbaa");

/** Integer milliseconds; all IR timing is in integer ms to avoid float drift across renderers. */
export const Milliseconds = z.number().int().min(0).max(3_600_000);
export const PositiveMilliseconds = z.number().int().min(1).max(3_600_000);

/** BCP 47 language tag such as `vi`, `en`, `vi-VN`. */
export const LanguageTag = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "expected a BCP 47 tag");

export const ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export const AspectRatio = z.enum(ASPECT_RATIOS);
export type AspectRatio = z.infer<typeof AspectRatio>;

/** Canonical full-HD frame sizes per aspect ratio. */
export const ASPECT_RATIO_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
};

/** Brand palette role, resolved by renderers against the BrandKit. */
export const ColorRole = z.enum(["primary", "secondary", "accent", "background", "foreground", "muted"]);
export type ColorRole = z.infer<typeof ColorRole>;

/** A colour given either as a palette role or a literal hex value. */
export const ColorValue = z.union([ColorRole, HexColor]);
export type ColorValue = z.infer<typeof ColorValue>;
