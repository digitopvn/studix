import { z } from "zod";

export const RenderPreset = z.enum(["preview", "final"]);
export type RenderPreset = z.infer<typeof RenderPreset>;

/** Renderer-neutral output request. Renderers map it to their own flags. */
export const RenderSpec = z.object({
  preset: RenderPreset,
  container: z.literal("mp4"),
  videoCodec: z.literal("h264"),
  audioCodec: z.literal("aac"),
  /** Output scale relative to the IR format size (0 < scale <= 1). */
  scale: z.number().gt(0).max(1),
  /** Constant rate factor; lower is better quality. */
  crf: z.number().int().min(0).max(51),
  /** Frame-rate override; defaults to the IR format fps. */
  fps: z.number().int().min(12).max(120).optional(),
});
export type RenderSpec = z.infer<typeof RenderSpec>;

export const RENDER_PRESETS: Record<RenderPreset, RenderSpec> = {
  preview: {
    preset: "preview",
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    scale: 0.5,
    crf: 30,
  },
  final: { preset: "final", container: "mp4", videoCodec: "h264", audioCodec: "aac", scale: 1, crf: 18 },
};

/** Preset defaults merged with validated overrides. */
export function resolveRenderSpec(
  preset: RenderPreset,
  overrides: Partial<Omit<RenderSpec, "preset">> = {},
): RenderSpec {
  return RenderSpec.parse({ ...RENDER_PRESETS[preset], ...overrides, preset });
}

/** Output pixel size for a render: scaled and rounded down to even numbers. */
export function renderDimensions(
  format: { width: number; height: number },
  spec: Pick<RenderSpec, "scale">,
): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  return { width: even(format.width * spec.scale), height: even(format.height * spec.scale) };
}
