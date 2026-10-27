import { StudixError } from "@studix/shared";
import { RenderPreset, unwrapValidation, validateVideoIR } from "@studix/video-ir";
import { z } from "zod";
import type { StageContext } from "./workflow-types.ts";

/** Shapes of the video.create payload and stage checkpoints, re-validated whenever they are read back. */
export const VideoCreatePayload = z.object({
  projectId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  renderPreset: RenderPreset.default("preview"),
});
export const PlanOutput = z.object({ ir: z.unknown(), versionId: z.string().optional() });
export const ValidateOutput = z.object({ versionId: z.string() });
export const RenderOutput = z.object({
  filePath: z.string(),
  mime: z.string(),
  probe: z.object({
    durationMs: z.number(),
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    videoCodec: z.string(),
    audioCodec: z.string().optional(),
    bytes: z.number(),
  }),
});
export const UploadOutput = z.object({ storageKey: z.string(), bytes: z.number(), sha256: z.string() });

export function read<T extends z.ZodType>(
  schema: T,
  value: unknown,
  what: string,
  code: "VALIDATION" | "INTERNAL" = "INTERNAL",
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new StudixError(code, `Invalid ${what}`, {
    retryable: false,
    details: { issues: parsed.error.issues },
  });
}

export const payloadOf = (s: StageContext) =>
  read(VideoCreatePayload, s.job.payload, "video.create job payload", "VALIDATION");
export const irOf = (s: StageContext) =>
  unwrapValidation(
    validateVideoIR(read(PlanOutput, s.outputs.plan, "plan checkpoint").ir),
    "planned VideoIR",
  );
