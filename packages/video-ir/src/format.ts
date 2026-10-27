import { z } from "zod";
import { AspectRatio, PositiveMilliseconds } from "./primitives.ts";

const RATIO_VALUE: Record<AspectRatio, number> = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1 };

/** Output frame geometry and total duration. Width/height must match the aspect ratio within 1%. */
export const VideoFormat = z
  .object({
    aspectRatio: AspectRatio,
    width: z.number().int().min(144).max(7680),
    height: z.number().int().min(144).max(7680),
    fps: z.number().int().min(12).max(120),
    durationMs: PositiveMilliseconds,
  })
  .refine(
    (f) => Math.abs(f.width / f.height - RATIO_VALUE[f.aspectRatio]) / RATIO_VALUE[f.aspectRatio] <= 0.01,
    {
      message: "width/height do not match aspectRatio",
      path: ["width"],
    },
  )
  .refine((f) => f.width % 2 === 0 && f.height % 2 === 0, {
    message: "width and height must be even (H.264 requirement)",
    path: ["width"],
  });
export type VideoFormat = z.infer<typeof VideoFormat>;
