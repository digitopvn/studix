import { createHash } from "node:crypto";
import { newId, StudixError } from "@studix/shared";
import { RenderPreset, resolveRenderSpec } from "@studix/video-ir";
import { z } from "zod";
import { JOB_KINDS, type Render } from "../entities/job.ts";
import type { JobQueue } from "../ports/job-queue.ts";
import type { StorageAdapter } from "../ports/storage-adapter.ts";
import type { AssetRepository } from "../repositories/asset-repository.ts";
import type { AuditRepository } from "../repositories/governance-repositories.ts";
import type { RenderRepository } from "../repositories/job-repository.ts";
import type { ProjectRepository } from "../repositories/project-repository.ts";
import { actorRef, assertPermission, type TenantContext } from "../tenant.ts";
import { toJobView } from "./job-view.ts";

/*
 * A composition workspace: a file tree an agent authors a video in (HyperFrames HTML, Remotion sources,
 * scripts, assets, renders, frames). Files live in object storage under `compositions/<id>/`, listed by a
 * manifest. `composition.run` jobs copy the tree into the skill sandbox, run one shell command there
 * (render, Multix generate, ffmpeg, a contact sheet) and store what it wrote back. Studix prescribes no flow:
 * only the optional output check of a run is hard (docs/decisions/0024-client-authoring-and-agent-roles.md).
 */

export const COMPOSITION_LIMITS = {
  files: 400,
  /** One file written through the API (text or base64); larger media is generated or fetched in a run. */
  writeBytes: 8 * 1024 * 1024,
  /** One file a run stores back. */
  runFileBytes: 1024 * 1024 * 1024,
  /** Files one run may add or change. */
  runFiles: 200,
  commandChars: 20_000,
  defaultTimeoutSeconds: 900,
  maxTimeoutSeconds: 3600,
  /** Images returned inline by a read, so a client model can look at frames and contact sheets. */
  inlineImageBytes: 1536 * 1024,
} as const;

export const CompositionId = z.string().regex(/^cmp_[A-Za-z0-9_-]{6,60}$/, "a composition id (cmp_...)");

/** A relative POSIX path inside the composition: no leading slash, `..`, empty or hidden segments. */
export const CompositionPath = z
  .string()
  .min(1)
  .max(240)
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9_.@+-]*(\/[A-Za-z0-9_][A-Za-z0-9_.@+-]*)*$/,
    "a relative path like src/index.html",
  )
  .refine((p) => !p.split("/").includes(".."), "must not contain '..'");

export const CompositionFileInput = z.union([
  z.object({ path: CompositionPath, text: z.string().max(COMPOSITION_LIMITS.writeBytes) }).strict(),
  z
    .object({
      path: CompositionPath,
      base64: z.string().max(Math.ceil((COMPOSITION_LIMITS.writeBytes * 4) / 3) + 4),
      contentType: z.string().max(120).optional(),
    })
    .strict(),
]);
export type CompositionFileInput = z.infer<typeof CompositionFileInput>;

export interface CompositionFile {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export interface CompositionManifest {
  id: string;
  title?: string;
  files: CompositionFile[];
  updatedAt: string;
}

/** The output check of a run: hard, and the only one Studix applies. Omitted fields are not checked. */
export const CompositionCheck = z
  .object({
    path: CompositionPath.describe("The rendered file to check, e.g. out/video.mp4"),
    width: z.number().int().min(16).max(8192).optional(),
    height: z.number().int().min(16).max(8192).optional(),
    durationMs: z.number().int().min(100).max(3_600_000).optional(),
    durationToleranceMs: z.number().int().min(0).max(60_000).default(500),
    /** Integrated loudness target (LUFS, +/-2 LU) and true peak <= -1 dBTP; requires an audio track. */
    loudnessLufs: z.number().min(-40).max(-5).optional(),
  })
  .strict();
export type CompositionCheck = z.output<typeof CompositionCheck>;

export const CompositionRunRequest = z
  .object({
    compositionId: CompositionId,
    command: z.string().min(1).max(COMPOSITION_LIMITS.commandChars),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(COMPOSITION_LIMITS.maxTimeoutSeconds)
      .default(COMPOSITION_LIMITS.defaultTimeoutSeconds),
    check: CompositionCheck.optional(),
  })
  .strict();
export type CompositionRunRequest = z.output<typeof CompositionRunRequest>;

export interface CompositionRunResult {
  exitCode: number | null;
  durationMs: number;
  /** stdout and stderr interleaved, as a terminal shows them (the tail). */
  log: string;
  /** Files the command added or changed, now stored in the composition. */
  changed: CompositionFile[];
  check?: { path: string; passed: boolean; problems: string[]; probe?: Record<string, unknown> };
}

export const compositionPrefix = (id: string) => `compositions/${id}`;
export const compositionFileKey = (id: string, path: string) => `${compositionPrefix(id)}/files/${path}`;
export const compositionManifestKey = (id: string) => `${compositionPrefix(id)}/manifest.json`;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  jsx: "text/plain",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  srt: "text/plain",
  vtt: "text/vtt",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

export function compositionContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Refuses a composition that would hold more than the file cap. */
export function assertCompositionFits(fileCount: number): void {
  if (fileCount > COMPOSITION_LIMITS.files) {
    throw new StudixError("VALIDATION", `A composition holds at most ${COMPOSITION_LIMITS.files} files`, {
      retryable: false,
      details: { files: fileCount, limit: COMPOSITION_LIMITS.files },
      suggestedAction: "Delete renders or frames you no longer need (delete: [paths]).",
    });
  }
}

/** The file count a composition would have after a merge, without changing it. */
export function compositionCountAfter(
  manifest: Pick<CompositionManifest, "files">,
  paths: readonly string[],
): number {
  const all = new Set(manifest.files.map((f) => f.path));
  for (const p of paths) all.add(p);
  return all.size;
}

/** Merges written or changed files into a manifest, newest wins, sorted by path. */
export function mergeManifest(
  manifest: CompositionManifest,
  files: readonly CompositionFile[],
  remove: readonly string[] = [],
  now: Date = new Date(),
): CompositionManifest {
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  for (const path of remove) byPath.delete(path);
  for (const f of files) byPath.set(f.path, f);
  assertCompositionFits(byPath.size);
  return {
    ...manifest,
    files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    updatedAt: now.toISOString(),
  };
}

async function readJson(storage: Pick<StorageAdapter, "get">, ctx: TenantContext, key: string) {
  const { body } = await storage.get(ctx, key);
  return JSON.parse(await new Response(body).text()) as unknown;
}

export async function loadCompositionManifest(
  storage: Pick<StorageAdapter, "get" | "head">,
  ctx: TenantContext,
  id: string,
): Promise<CompositionManifest> {
  const key = compositionManifestKey(CompositionId.parse(id));
  if (!(await storage.head(ctx, key))) {
    throw new StudixError("NOT_FOUND", `composition ${id} not found`, {
      retryable: false,
      suggestedAction: "Create one with studix_composition_write (omit compositionId).",
    });
  }
  return (await readJson(storage, ctx, key)) as CompositionManifest;
}

export async function saveCompositionManifest(
  storage: Pick<StorageAdapter, "put">,
  ctx: TenantContext,
  manifest: CompositionManifest,
): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(manifest));
  await storage.put(ctx, compositionManifestKey(manifest.id), body, { contentType: "application/json" });
}

/** Registers a rendered MP4 of a composition as a playable render of a project. */
export const CompositionAttachRequest = z
  .object({
    compositionId: CompositionId,
    path: CompositionPath.describe("The rendered MP4 in the composition, e.g. out/video.mp4"),
    projectId: z.string().min(1).max(100),
    preset: RenderPreset.default("final"),
  })
  .strict();
export type CompositionAttachRequest = z.input<typeof CompositionAttachRequest>;

export interface CompositionServiceDeps {
  storage: Pick<StorageAdapter, "get" | "head" | "put" | "delete" | "signedUrl">;
  queue: JobQueue;
  /** Needed by `attachRender` only. */
  projects?: Pick<ProjectRepository, "get">;
  renders?: Pick<RenderRepository, "listByProject" | "create" | "update">;
  assets?: Pick<AssetRepository, "create" | "addVersion" | "getVersion">;
  audit: Pick<AuditRepository, "append">;
  defaults: { jobBudgetCents: number };
}

export type CompositionService = ReturnType<typeof createCompositionService>;

export function createCompositionService(deps: CompositionServiceDeps) {
  const { storage } = deps;
  return {
    /** Creates the composition when `compositionId` is omitted, then writes and deletes files. */
    async write(
      ctx: TenantContext,
      input: { compositionId?: string; title?: string; files?: CompositionFileInput[]; delete?: string[] },
    ): Promise<CompositionManifest> {
      assertPermission(ctx, "project:write");
      const manifest: CompositionManifest = input.compositionId
        ? await loadCompositionManifest(storage, ctx, input.compositionId)
        : {
            id: newId("cmp"),
            ...(input.title ? { title: input.title } : {}),
            files: [],
            updatedAt: new Date().toISOString(),
          };
      const written: CompositionFile[] = [];
      // Refuse before storing or deleting anything, so a write over the cap leaves the composition unchanged.
      const removing = new Set(input.delete ?? []);
      assertCompositionFits(
        compositionCountAfter(
          { files: manifest.files.filter((f) => !removing.has(f.path)) },
          (input.files ?? []).map((f) => f.path),
        ),
      );
      for (const file of input.files ?? []) {
        const bytes =
          "text" in file
            ? new TextEncoder().encode(file.text)
            : Uint8Array.from(Buffer.from(file.base64, "base64"));
        if (bytes.byteLength > COMPOSITION_LIMITS.writeBytes) {
          throw new StudixError("VALIDATION", `${file.path} is over ${COMPOSITION_LIMITS.writeBytes} bytes`, {
            retryable: false,
            suggestedAction: "Generate or download large media inside studix_composition_run instead.",
          });
        }
        const contentType = ("contentType" in file && file.contentType) || compositionContentType(file.path);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        await storage.put(ctx, compositionFileKey(manifest.id, file.path), bytes, { contentType, sha256 });
        written.push({ path: file.path, bytes: bytes.byteLength, sha256, contentType });
      }
      for (const path of input.delete ?? []) {
        await storage.delete(ctx, compositionFileKey(manifest.id, CompositionPath.parse(path)));
      }
      const next = mergeManifest(
        { ...manifest, ...(input.title ? { title: input.title } : {}) },
        written,
        input.delete,
      );
      await saveCompositionManifest(storage, ctx, next);
      return next;
    },

    /** The manifest, or one file: text inline, an image inline (for frames), anything with a signed URL. */
    async read(ctx: TenantContext, input: { compositionId: string; path?: string }) {
      assertPermission(ctx, "project:read");
      const manifest = await loadCompositionManifest(storage, ctx, input.compositionId);
      if (!input.path) return { manifest };
      const file = manifest.files.find((f) => f.path === input.path);
      if (!file) {
        throw new StudixError("NOT_FOUND", `${input.path} is not in composition ${manifest.id}`, {
          retryable: false,
          details: { files: manifest.files.slice(0, 50).map((f) => f.path) },
        });
      }
      const key = compositionFileKey(manifest.id, file.path);
      const url = await storage.signedUrl(ctx, key, { downloadName: file.path.split("/").pop() });
      const textual = /^(text\/|application\/json|image\/svg)/.test(file.contentType);
      const image = /^image\/(png|jpeg|webp|gif)$/.test(file.contentType);
      if (
        (textual && file.bytes <= 512 * 1024) ||
        (image && file.bytes <= COMPOSITION_LIMITS.inlineImageBytes)
      ) {
        const { body } = await storage.get(ctx, key);
        const buf = Buffer.from(await new Response(body).arrayBuffer());
        return textual
          ? { file, url, text: buf.toString("utf8") }
          : { file, url, image: { mimeType: file.contentType, data: buf.toString("base64") } };
      }
      return { file, url };
    },

    /**
     * Copies a rendered MP4 of the composition under `renders/` and records it as the project's render, with
     * an asset and version, so the project, its jobs and the dashboard play it. Idempotent for the same file.
     */
    async attachRender(
      ctx: TenantContext,
      input: CompositionAttachRequest,
    ): Promise<{ render: Render; assetId?: string; replayed: boolean }> {
      assertPermission(ctx, "project:write");
      const { projects, renders, assets } = deps;
      if (!projects || !renders || !assets) {
        throw new StudixError("UNAVAILABLE", "Attaching renders is not configured on this server", {
          retryable: false,
        });
      }
      const request = CompositionAttachRequest.parse(input);
      const project = await projects.get(ctx, request.projectId);
      if (!project) throw new StudixError("NOT_FOUND", `project ${request.projectId} not found`);
      if (!project.currentVersionId) {
        throw new StudixError("CONFLICT", "The project has no version to attach a render to", {
          retryable: false,
          suggestedAction: "Create the project with a spec (studix_create_video) or wait for planning.",
        });
      }
      const manifest = await loadCompositionManifest(storage, ctx, request.compositionId);
      const file = manifest.files.find((f) => f.path === request.path);
      if (!file) {
        throw new StudixError("NOT_FOUND", `${request.path} is not in composition ${manifest.id}`, {
          retryable: false,
          details: { files: manifest.files.slice(0, 50).map((f) => f.path) },
        });
      }
      if (file.contentType !== "video/mp4") {
        throw new StudixError("VALIDATION", `${file.path} is ${file.contentType}, not an MP4 video`, {
          retryable: false,
          suggestedAction: "Attach the rendered .mp4 (for example out/video.mp4).",
        });
      }
      // The storage key is the idempotency key: same file, project, preset and version means the same render.
      // The render id itself stays a sortable id, because renders are listed newest first by id.
      const keyHash = createHash("sha256")
        .update(
          [project.id, project.currentVersionId, manifest.id, file.path, file.sha256, request.preset].join(
            "\n",
          ),
        )
        .digest("hex")
        .slice(0, 26);
      const storageKey = `renders/attached-${keyHash}/${request.preset}.mp4`;
      const createdBy = actorRef(ctx.actor);
      const existing = (await renders.listByProject(ctx, project.id, { limit: 100 })).items.find(
        (r) => r.storageKey === storageKey,
      );
      let render = existing;
      if (!render) {
        const source = await storage.get(ctx, compositionFileKey(manifest.id, file.path));
        await storage.put(ctx, storageKey, source.body, { contentType: "video/mp4", sha256: file.sha256 });
        render = await renders.create(ctx, {
          id: newId("rnd"),
          projectId: project.id,
          versionId: project.currentVersionId,
          preset: request.preset,
          spec: resolveRenderSpec(request.preset),
          status: "succeeded",
          storageKey,
          completedAt: new Date(),
        });
      }
      // A retry after a failure between the steps completes the asset instead of repeating the copy.
      let assetId: string | undefined;
      if (render.assetVersionId) {
        assetId = (await assets.getVersion(ctx, render.assetVersionId))?.assetId;
      } else {
        const asset = await assets.create(ctx, {
          projectId: project.id,
          kind: "render",
          name: file.path.split("/").pop() ?? "video.mp4",
          createdBy,
        });
        const version = await assets.addVersion(ctx, {
          assetId: asset.id,
          storageKey,
          sha256: file.sha256,
          mime: "video/mp4",
          bytes: file.bytes,
          provenance: { source: "rendered", provider: "composition", createdAt: new Date().toISOString() },
          createdBy,
        });
        render = await renders.update(ctx, render.id, { assetVersionId: version.id });
        assetId = asset.id;
      }
      if (existing && existing.assetVersionId) {
        return { render, ...(assetId ? { assetId } : {}), replayed: true };
      }
      await deps.audit.append(ctx, {
        actor: createdBy,
        action: "composition.render_attached",
        subjectType: "render",
        subjectId: render.id,
        data: { compositionId: manifest.id, path: file.path, projectId: project.id, bytes: file.bytes },
      });
      return { render, ...(assetId ? { assetId } : {}), replayed: false };
    },

    /** Queues one command in the skill sandbox over the composition's files. */
    async run(
      ctx: TenantContext,
      input: { request: unknown; idempotencyKey?: string; budgetCents?: number },
    ) {
      assertPermission(ctx, "media:exec");
      const parsed = CompositionRunRequest.safeParse(input.request);
      if (!parsed.success) {
        throw new StudixError("VALIDATION", "Invalid composition run", {
          retryable: false,
          details: { issues: parsed.error.issues.slice(0, 10) },
        });
      }
      const request = parsed.data;
      await loadCompositionManifest(storage, ctx, request.compositionId);
      const { job, created } = await deps.queue.enqueue(ctx, {
        kind: JOB_KINDS.compositionRun,
        payload: { request },
        ...(input.idempotencyKey ? { idempotencyKey: `composition-run:${input.idempotencyKey}` } : {}),
        budgetCents: input.budgetCents ?? deps.defaults.jobBudgetCents,
        maxAttempts: 1,
        createdBy: actorRef(ctx.actor),
      });
      if (created) {
        // The command text may hold prompts; only its shape is audited.
        await deps.audit.append(ctx, {
          actor: actorRef(ctx.actor),
          action: "composition.run_started",
          subjectType: "job",
          subjectId: job.id,
          data: {
            compositionId: request.compositionId,
            commandChars: request.command.length,
            timeoutSeconds: request.timeoutSeconds,
            check: Boolean(request.check),
          },
        });
      }
      return { job: toJobView(job, []), replayed: !created };
    },
  };
}
