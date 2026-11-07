import {
  JOB_KINDS,
  MEDIA_EXEC_LIMITS,
  MEDIA_EXEC_TOOLS,
  MediaExecInputSource,
  MediaExecOutput,
  type MediaExecResult,
  STUDIX_TOOLS,
  type TenantContext,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { ArtifactUrlDeps } from "../artifact-urls.ts";
import type { NativeTool } from "./native-tools.ts";

export const MEDIA_EXEC_TOOL_NAME = "studix_media_exec";

const Input = z.object({
  tool: z.enum(MEDIA_EXEC_TOOLS),
  args: z
    .array(z.string().max(MEDIA_EXEC_LIMITS.argChars))
    .max(MEDIA_EXEC_LIMITS.args)
    .describe("Raw argv, no shell. Files only as {in:<name>} and {out:<name>}; no absolute paths or URLs."),
  inputs: z
    .record(z.string(), MediaExecInputSource)
    .optional()
    .describe("name -> {assetId} | {url: https public} | {base64: <=2 MB}. The name is the file name."),
  outputs: z
    .array(MediaExecOutput)
    .max(MEDIA_EXEC_LIMITS.outputs)
    .optional()
    .describe("Files the run writes; stored as workspace assets."),
  timeoutSeconds: z.number().int().min(1).max(MEDIA_EXEC_LIMITS.maxTimeoutSeconds).optional(),
  budgetCents: z.number().int().min(0).max(10_000_000).optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,200}$/)
    .optional(),
});

export const MEDIA_EXEC_MCP_TOOLS = [
  {
    name: MEDIA_EXEC_TOOL_NAME,
    title: "Run ffmpeg or ffprobe",
    description:
      "Async ffmpeg/ffprobe with raw args in an offline sandbox, e.g. args ['-i','{in:a.mp4}','-vn','{out:a.mp3}']. Poll studix_get_job for exit code, logs, ffprobe JSON and signed output URLs.",
    input: Input,
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      if (!ctx.deps.mediaExec) {
        throw new StudixError("UNAVAILABLE", "Media exec is not configured on this server", {
          retryable: false,
        });
      }
      const { idempotencyKey, budgetCents, ...request } = input;
      const { job, replayed } = await ctx.deps.mediaExec.start(ctx.tenant, {
        request,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(budgetCents !== undefined ? { budgetCents } : {}),
      });
      return {
        data: { jobId: job.id, status: job.status, replayed },
        next: [
          {
            tool: STUDIX_TOOLS.getJob,
            arguments: { jobId: job.id },
            reason: "Poll for the exit code, logs and output URLs.",
          },
        ],
        scope: { jobId: job.id },
      };
    },
  } satisfies NativeTool<typeof Input>,
] as const;

/** A finished media exec job's outputs with signed download URLs; other jobs are returned unchanged. */
export async function withMediaExecUrls<T extends { kind: string; status: string; result?: unknown }>(
  deps: ArtifactUrlDeps,
  ctx: TenantContext,
  job: T,
): Promise<T> {
  if (job.kind !== JOB_KINDS.mediaExec || job.status !== "succeeded" || !job.result) return job;
  const result = job.result as MediaExecResult;
  if (!Array.isArray(result.outputs)) return job;
  const signer = deps.storage;
  const outputs = await Promise.all(
    result.outputs.map(async (o) => {
      const { storageKey: _key, ...rest } = o;
      if (!signer)
        return { ...rest, urlUnavailableReason: "Artifact storage is not configured on this server." };
      const url = await signer.signedUrl(ctx, o.storageKey, { downloadName: o.name }).catch(() => undefined);
      return url ? { ...rest, url } : { ...rest, urlUnavailableReason: "The output could not be signed." };
    }),
  );
  return { ...job, result: { ...result, outputs } };
}
