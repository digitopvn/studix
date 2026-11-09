import {
  COMPOSITION_LIMITS,
  CompositionCheck,
  CompositionFileInput,
  CompositionId,
  CompositionPath,
  type CompositionService,
  STUDIX_TOOLS,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { NativeTool, ToolContext } from "./native-tools.ts";

/*
 * Direct video authoring by the client AI (docs/decisions/0024-client-authoring-and-agent-roles.md): a composition is a
 * file tree; the client writes sources, runs any command over it in the skill sandbox (HyperFrames or Remotion
 * render, `multix generate` for images, TTS, music and SFX, ffmpeg, contact sheets) and reads frames back to
 * review its own work. Studix checks outputs only, when a run asks for it.
 */

export const COMPOSITION_TOOL_NAMES = {
  write: "studix_composition_write",
  read: "studix_composition_read",
  run: "studix_composition_run",
  attachRender: "studix_composition_attach_render",
} as const;

function service(ctx: ToolContext): CompositionService {
  if (!ctx.deps.compositions) {
    throw new StudixError("UNAVAILABLE", "Composition workspaces need object storage on this server", {
      retryable: false,
    });
  }
  return ctx.deps.compositions;
}

const WriteInput = z.object({
  compositionId: CompositionId.optional().describe("Omit to create a new composition."),
  title: z.string().trim().min(1).max(200).optional(),
  files: z
    .array(CompositionFileInput)
    .max(50)
    .optional()
    .describe(`{path, text} or {path, base64} (<= ${COMPOSITION_LIMITS.writeBytes / 1024 / 1024} MB each).`),
  delete: z.array(CompositionPath).max(200).optional(),
});

const ReadInput = z.object({
  compositionId: CompositionId,
  path: CompositionPath.optional().describe(
    "Omit for the file list. Images come back as images, text inline.",
  ),
});

const RunInput = z.object({
  compositionId: CompositionId,
  command: z
    .string()
    .min(1)
    .max(COMPOSITION_LIMITS.commandChars)
    .describe(
      "sh command run in the composition root, e.g. `npx hyperframes render index.html -o out/video.mp4`, `multix generate ...`, ffmpeg.",
    ),
  timeoutSeconds: z.number().int().min(1).max(COMPOSITION_LIMITS.maxTimeoutSeconds).optional(),
  check: CompositionCheck.optional().describe(
    "Output check after the command: size, duration, loudness of a rendered file. The job fails when it misses.",
  ),
  budgetCents: z.number().int().min(0).max(10_000_000).optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,200}$/)
    .optional(),
});

const AttachInput = z.object({
  compositionId: CompositionId,
  path: CompositionPath.describe("The rendered MP4 in the composition, e.g. out/video.mp4"),
  projectId: z.string().min(1).max(100).describe("The project that should show this render."),
  preset: z.enum(["preview", "final"]).optional().describe("Default final."),
});

const summary = (manifest: { id: string; title?: string; files: { path: string; bytes: number }[] }) => ({
  compositionId: manifest.id,
  ...(manifest.title ? { title: manifest.title } : {}),
  files: manifest.files.map((f) => ({ path: f.path, bytes: f.bytes })),
});

export const COMPOSITION_MCP_TOOLS = [
  {
    name: COMPOSITION_TOOL_NAMES.write,
    title: "Write composition files",
    description:
      "Create a composition workspace (omit compositionId) or write/delete its files: HyperFrames HTML, Remotion sources, scripts, small assets. Then studix_composition_run.",
    input: WriteInput,
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      const manifest = await service(ctx).write(ctx.tenant, input);
      return {
        data: summary(manifest),
        next: [
          {
            tool: COMPOSITION_TOOL_NAMES.run,
            arguments: { compositionId: manifest.id, command: "ls -R" },
            reason: "Render, generate assets or run ffmpeg over these files.",
          },
        ],
      };
    },
  } satisfies NativeTool<typeof WriteInput>,
  {
    name: COMPOSITION_TOOL_NAMES.read,
    title: "Read composition",
    description:
      "File list of a composition, or one file: text inline, images (frames, contact sheets) as images, any file with a signed URL.",
    input: ReadInput,
    readOnly: true,
    async run(ctx, input) {
      const read = await service(ctx).read(ctx.tenant, input);
      if ("manifest" in read && read.manifest) return { data: summary(read.manifest), next: [] };
      const { image, ...rest } = read as { image?: { mimeType: string; data: string } };
      return { data: rest, next: [], ...(image ? { images: [image] } : {}) };
    },
  } satisfies NativeTool<typeof ReadInput>,
  {
    name: COMPOSITION_TOOL_NAMES.run,
    title: "Run in composition",
    description:
      "Async: run a shell command over a composition in the skill sandbox (Node, Python, ffmpeg, Chromium, HyperFrames, Remotion, Multix, /skills). Changed files are stored back. Poll studix_get_job.",
    input: RunInput,
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      const { idempotencyKey, budgetCents, ...request } = input;
      const { job, replayed } = await service(ctx).run(ctx.tenant, {
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
            reason: "Poll for the exit code, log tail, changed files and check result.",
          },
          {
            tool: COMPOSITION_TOOL_NAMES.read,
            arguments: { compositionId: input.compositionId },
            reason: "Then read frames or get signed URLs of the outputs.",
          },
        ],
        scope: { jobId: job.id },
      };
    },
  } satisfies NativeTool<typeof RunInput>,
  {
    name: COMPOSITION_TOOL_NAMES.attachRender,
    title: "Attach composition render to a project",
    description:
      "Register a rendered MP4 of a composition (after studix_composition_run) as a playable render of a project: it gets an asset, version and preview, so studix_get_project and the dashboard play it. Safe to repeat.",
    input: AttachInput,
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      const { render, assetId, replayed } = await service(ctx).attachRender(ctx.tenant, input);
      return {
        data: {
          renderId: render.id,
          projectId: render.projectId,
          ...(assetId ? { assetId } : {}),
          ...(render.assetVersionId ? { assetVersionId: render.assetVersionId } : {}),
          status: render.status,
          replayed,
        },
        next: [
          {
            tool: STUDIX_TOOLS.getProject,
            arguments: { projectId: render.projectId },
            reason: "The render is listed with a signed playback URL.",
          },
        ],
      };
    },
  } satisfies NativeTool<typeof AttachInput>,
] as const;
