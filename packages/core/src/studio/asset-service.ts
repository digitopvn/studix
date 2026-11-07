import { createHash } from "node:crypto";
import { newId, StudixError } from "@studix/shared";
import type { AssetProvenance } from "@studix/video-ir";
import { z } from "zod";
import type { Asset, AssetKind, AssetVersion } from "../entities/asset.ts";
import { ASSET_KINDS } from "../entities/asset.ts";
import type { StorageAdapter } from "../ports/storage-adapter.ts";
import type { AssetRepository } from "../repositories/asset-repository.ts";
import type { AuditRepository, ProjectRepository, RevisionRepository } from "../repositories/index.ts";
import { actorRef, assertPermission, type TenantContext } from "../tenant.ts";
import { parseInput } from "./studio-input.ts";

/** Size limits for bytes sent inline (a /mcp request body is capped at 2 MB) or fetched from a URL. */
export const ASSET_UPLOAD_LIMITS = {
  base64Bytes: 1_500_000,
  urlBytes: 100 * 1024 * 1024,
} as const;

const SIGNED_URL_SECONDS = 3600;

const Id = z.string().trim().min(1).max(100);
const Name = z.string().trim().min(1).max(200);

export const AssetListInput = z
  .object({
    projectId: Id.optional(),
    kind: z.enum(ASSET_KINDS).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    state: z.enum(["active", "deleted", "all"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type AssetListInput = z.input<typeof AssetListInput>;

export const AssetGetInput = z
  .object({
    assetId: Id,
    /** Sign this version instead of the current one. */
    versionId: Id.optional(),
  })
  .strict();
export type AssetGetInput = z.input<typeof AssetGetInput>;

/** Bytes come from exactly one of `base64` and `url`. With `assetId` they become a new version of that asset. */
export const AssetUploadInput = z
  .object({
    name: Name.optional(),
    base64: z
      .string()
      .min(1)
      .max(Math.ceil((ASSET_UPLOAD_LIMITS.base64Bytes * 4) / 3) + 8)
      .optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    contentType: z
      .string()
      .trim()
      .regex(/^[\w.+-]+\/[\w.+-]+$/)
      .max(120)
      .optional(),
    projectId: Id.optional(),
    kind: z.enum(ASSET_KINDS).optional(),
    assetId: Id.optional(),
    license: z.string().trim().min(1).max(200).optional(),
    /** Asset version ids this file was made from; shown as lineage. */
    derivedFrom: z.array(Id).max(32).optional(),
  })
  .strict()
  .refine((v) => (v.base64 === undefined) !== (v.url === undefined), {
    message: "give exactly one of base64 and url",
    path: ["base64"],
  })
  .refine((v) => v.assetId !== undefined || v.name !== undefined || v.url !== undefined, {
    message: "a new asset needs a name (or a url to take it from)",
    path: ["name"],
  });
export type AssetUploadInput = z.input<typeof AssetUploadInput>;

export const AssetUpdateInput = z
  .object({
    assetId: Id,
    name: Name.optional(),
    /** Move to another project; `null` detaches the asset from its project. */
    projectId: Id.nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.projectId !== undefined, {
    message: "give name and/or projectId",
    path: ["name"],
  });
export type AssetUpdateInput = z.input<typeof AssetUpdateInput>;

/** An asset with the facts of its current version; what lists return. */
export interface AssetSummary {
  id: string;
  name: string;
  kind: AssetKind;
  projectId?: string;
  versions: number;
  mime?: string;
  bytes?: number;
  durationMs?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface AssetVersionView {
  versionId: string;
  version: number;
  mime: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  durationMs?: number;
  source: AssetProvenance["source"];
  sourceUrl?: string;
  license?: string;
  createdBy: string;
  createdAt: string;
  current: boolean;
}

export interface AssetLineageView {
  /** The versions the current version was made from. `assetId` is missing when that asset is gone. */
  derivedFrom: Array<{ versionId: string; assetId?: string; version?: number; name?: string; role?: string }>;
  /** Versions of other assets made, directly or through others, from a version of this asset. */
  derivatives: Array<{ assetId: string; versionId: string; version: number }>;
}

export interface AssetDetails {
  asset: AssetSummary;
  /** The version `url` was signed for. */
  versionId?: string;
  /** Signed download URL; absent when the server has no object storage. */
  url?: string;
  urlExpiresAt?: string;
  urlUnavailableReason?: string;
  versions: AssetVersionView[];
  lineage: AssetLineageView;
}

export interface AssetUploadResult {
  asset: AssetSummary;
  versionId: string;
  version: number;
  /** True when the file was identical to the current version, so nothing was stored. */
  unchanged: boolean;
  url?: string;
}

export interface AssetServiceDeps {
  assets: AssetRepository;
  projects: Pick<ProjectRepository, "get">;
  audit: Pick<AuditRepository, "append">;
  /** Lineage of asset versions: what a file was made from and what was made from it. */
  revisions: Pick<RevisionRepository, "addLineage" | "listLineage" | "derivedAssetVersions">;
  /** Without storage the asset operations that need bytes answer UNAVAILABLE. */
  storage?: Pick<StorageAdapter, "put" | "signedUrl">;
  /** Public https fetch with the SSRF guard (`fetchPublicUrlWithType` from @studix/storage). Without it `url` is refused. */
  fetchUrl?: (
    url: string,
    maxBytes: number,
    signal: AbortSignal,
  ) => Promise<{ body: Uint8Array; contentType?: string; url?: URL }>;
  clock?: () => Date;
}

export type AssetService = ReturnType<typeof createAssetService>;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
};

const CODE_EXTENSIONS = new Set(["html", "css", "js", "ts", "tsx", "jsx", "glsl", "frag", "vert"]);

const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/** The asset kind a file belongs to, by media type, falling back to its extension. */
export function assetKindFor(mime: string, name: string): AssetKind {
  const ext = extensionOf(name);
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("font/") || mime.startsWith("application/font")) return "font";
  return "document";
}

/** A file name safe for an object key: letters, digits, dot, dash and underscore only. */
export function safeObjectName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "");
  return (cleaned || "file").slice(-100);
}

function nameFromUrl(raw: string): string | undefined {
  try {
    const last = new URL(raw).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64(text: string): Uint8Array {
  const compact = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new StudixError("VALIDATION", "base64 is not valid base64", {
      suggestedAction: "Send the file as standard base64, or use url for a public https file.",
    });
  }
  return Uint8Array.from(Buffer.from(compact, "base64"));
}

const actorLabel = (a: { type: string; id: string }) => `${a.type}:${a.id}`;

/**
 * Library operations on project assets, shared by the MCP tools, the REST API and the dashboard: list and
 * search, details with versions, lineage and a signed URL, upload or import from a URL, new versions,
 * rename or move, and delete/restore (a trash: bytes stay until purged). Every call is scoped to the
 * caller's workspace by the repositories, so a foreign asset or project id reads as NOT_FOUND.
 */
export function createAssetService(deps: AssetServiceDeps) {
  const now = () => (deps.clock ?? (() => new Date()))();

  const summarize = async (ctx: TenantContext, asset: Asset): Promise<AssetSummary> => {
    const [current, versions] = await Promise.all([
      asset.currentVersionId ? deps.assets.getVersion(ctx, asset.currentVersionId) : undefined,
      deps.assets.listVersions(ctx, asset.id),
    ]);
    return summaryOf(asset, current, versions.length);
  };

  const summaryOf = (asset: Asset, current: AssetVersion | undefined, versions: number): AssetSummary => ({
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    ...(asset.projectId ? { projectId: asset.projectId } : {}),
    versions,
    ...(current
      ? {
          mime: current.mime,
          bytes: current.bytes,
          ...(current.durationMs !== undefined ? { durationMs: current.durationMs } : {}),
        }
      : {}),
    createdBy: actorLabel(asset.createdBy),
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    ...(asset.deletedAt ? { deletedAt: asset.deletedAt.toISOString() } : {}),
  });

  const requireAsset = async (ctx: TenantContext, id: string): Promise<Asset> => {
    const asset = await deps.assets.get(ctx, id);
    if (!asset) {
      throw new StudixError("NOT_FOUND", `asset ${id} not found`, {
        retryable: false,
        suggestedAction: "List assets with studix_list_assets to find a valid id.",
      });
    }
    return asset;
  };

  const requireProject = async (ctx: TenantContext, projectId: string): Promise<void> => {
    if (!(await deps.projects.get(ctx, projectId))) {
      throw new StudixError("NOT_FOUND", `project ${projectId} not found`, { retryable: false });
    }
  };

  const sign = async (ctx: TenantContext, asset: Asset, version: AssetVersion) => {
    if (!deps.storage) return { reason: "Object storage is not configured on this server." } as const;
    try {
      const url = await deps.storage.signedUrl(ctx, version.storageKey, {
        expiresInSeconds: SIGNED_URL_SECONDS,
        downloadName: asset.name,
      });
      return { url, expiresAt: new Date(now().getTime() + SIGNED_URL_SECONDS * 1000).toISOString() } as const;
    } catch {
      return { reason: "The file could not be signed." } as const;
    }
  };

  const audit = (ctx: TenantContext, action: string, assetId: string, data: Record<string, unknown>) =>
    deps.audit.append(ctx, {
      actor: actorRef(ctx.actor),
      action,
      subjectType: "asset",
      subjectId: assetId,
      data,
    });

  /** The bytes of an upload and what is known about their type. */
  const readBytes = async (
    input: z.output<typeof AssetUploadInput>,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType?: string; sourceUrl?: string }> => {
    if (input.base64 !== undefined) {
      const bytes = decodeBase64(input.base64);
      if (bytes.byteLength > ASSET_UPLOAD_LIMITS.base64Bytes) {
        throw new StudixError("VALIDATION", "The file is larger than 1.5 MB for base64", {
          suggestedAction: "Host the file at a public https URL and pass url instead.",
        });
      }
      return { bytes, ...(input.contentType ? { contentType: input.contentType } : {}) };
    }
    if (!deps.fetchUrl) {
      throw new StudixError("UNAVAILABLE", "Importing from a URL is not enabled on this server", {
        retryable: false,
        suggestedAction: "Send the file as base64 instead.",
      });
    }
    const fetched = await deps.fetchUrl(input.url as string, ASSET_UPLOAD_LIMITS.urlBytes, signal);
    const type = input.contentType ?? fetched.contentType;
    return {
      bytes: fetched.body,
      ...(type ? { contentType: type } : {}),
      sourceUrl: (fetched.url ?? new URL(input.url as string)).toString(),
    };
  };

  return {
    async list(ctx: TenantContext, raw: AssetListInput = {}) {
      assertPermission(ctx, "asset:read");
      const input = parseInput(AssetListInput, raw, "asset list");
      const page = await deps.assets.list(ctx, {
        limit: input.limit ?? 20,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.q ? { q: input.q } : {}),
        ...(input.state ? { state: input.state } : {}),
      });
      const items = await Promise.all(page.items.map((asset) => summarize(ctx, asset)));
      return { ...page, items };
    },

    async get(ctx: TenantContext, raw: AssetGetInput): Promise<AssetDetails> {
      assertPermission(ctx, "asset:read");
      const input = parseInput(AssetGetInput, raw, "asset request");
      const asset = await requireAsset(ctx, input.assetId);
      const versions = await deps.assets.listVersions(ctx, asset.id);
      const current = versions.find((v) => v.id === asset.currentVersionId);
      const target = input.versionId ? versions.find((v) => v.id === input.versionId) : current;
      if (input.versionId && !target) {
        throw new StudixError("NOT_FOUND", `version ${input.versionId} not found on asset ${asset.id}`, {
          retryable: false,
        });
      }
      const [signed, inputs, derivedIds] = await Promise.all([
        target ? sign(ctx, asset, target) : undefined,
        current ? deps.revisions.listLineage(ctx, current.id) : [],
        deps.revisions.derivedAssetVersions(
          ctx,
          versions.map((v) => ({ kind: "asset_version" as const, id: v.id })),
        ),
      ]);
      const own = new Set(versions.map((v) => v.id));
      const [parents, derivatives] = await Promise.all([
        Promise.all(
          inputs
            .filter((i) => i.inputKind === "asset_version")
            .slice(0, 32)
            .map(async (i) => {
              const parent = await deps.assets.getVersion(ctx, i.inputId);
              const parentAsset = parent ? await deps.assets.get(ctx, parent.assetId) : undefined;
              return {
                versionId: i.inputId,
                ...(i.role ? { role: i.role } : {}),
                ...(parent ? { assetId: parent.assetId, version: parent.version } : {}),
                ...(parentAsset ? { name: parentAsset.name } : {}),
              };
            }),
        ),
        Promise.all(
          derivedIds
            .filter((id) => !own.has(id))
            .slice(0, 50)
            .map(async (id) => {
              const child = await deps.assets.getVersion(ctx, id);
              return child
                ? { assetId: child.assetId, versionId: child.id, version: child.version }
                : undefined;
            }),
        ),
      ]);
      return {
        asset: summaryOf(asset, current, versions.length),
        ...(target ? { versionId: target.id } : {}),
        ...(signed && "url" in signed ? { url: signed.url, urlExpiresAt: signed.expiresAt } : {}),
        ...(signed && "reason" in signed ? { urlUnavailableReason: signed.reason } : {}),
        versions: versions.map((v) => ({
          versionId: v.id,
          version: v.version,
          mime: v.mime,
          bytes: v.bytes,
          sha256: v.sha256,
          ...(v.width !== undefined ? { width: v.width } : {}),
          ...(v.height !== undefined ? { height: v.height } : {}),
          ...(v.durationMs !== undefined ? { durationMs: v.durationMs } : {}),
          source: v.provenance.source,
          ...(v.provenance.sourceUrl ? { sourceUrl: v.provenance.sourceUrl } : {}),
          ...(v.provenance.license ? { license: v.provenance.license } : {}),
          createdBy: actorLabel(v.createdBy),
          createdAt: v.createdAt.toISOString(),
          current: v.id === asset.currentVersionId,
        })),
        lineage: {
          derivedFrom: parents,
          derivatives: derivatives.filter((d) => d !== undefined),
        },
      };
    },

    /** Store a file as a new asset, or as a new version of `assetId`. */
    async upload(
      ctx: TenantContext,
      raw: AssetUploadInput,
      signal?: AbortSignal,
    ): Promise<AssetUploadResult> {
      assertPermission(ctx, "asset:write");
      const input = parseInput(AssetUploadInput, raw, "asset upload");
      if (!deps.storage) {
        throw new StudixError("UNAVAILABLE", "Object storage is not configured on this server", {
          retryable: false,
        });
      }
      const existing = input.assetId ? await requireAsset(ctx, input.assetId) : undefined;
      if (existing?.deletedAt) {
        throw new StudixError("CONFLICT", `asset ${existing.id} is in the trash`, {
          retryable: false,
          suggestedAction: "Restore it with studix_restore_asset, then add the version.",
        });
      }
      if (input.projectId) await requireProject(ctx, input.projectId);
      for (const versionId of input.derivedFrom ?? []) {
        if (!(await deps.assets.getVersion(ctx, versionId))) {
          throw new StudixError("NOT_FOUND", `version ${versionId} (derivedFrom) not found`, {
            retryable: false,
            suggestedAction: "Pass version ids from studix_get_asset versions[].versionId.",
          });
        }
      }

      const source = await readBytes(input, signal ?? new AbortController().signal);
      if (source.bytes.byteLength === 0) throw new StudixError("VALIDATION", "The file is empty");
      const name = input.name ?? existing?.name ?? nameFromUrl(input.url ?? "") ?? "file";
      const mime =
        source.contentType && source.contentType !== "application/octet-stream"
          ? source.contentType
          : (MIME_BY_EXTENSION[extensionOf(name)] ?? source.contentType ?? "application/octet-stream");
      const sha256 = createHash("sha256").update(source.bytes).digest("hex");

      if (existing) {
        const versions = await deps.assets.listVersions(ctx, existing.id);
        const current = versions.find((v) => v.id === existing.currentVersionId);
        if (current?.sha256 === sha256) {
          return {
            asset: summaryOf(existing, current, versions.length),
            versionId: current.id,
            version: current.version,
            unchanged: true,
          };
        }
      }

      const asset =
        existing ??
        (await deps.assets.create(ctx, {
          ...(input.projectId ? { projectId: input.projectId } : {}),
          kind: input.kind ?? assetKindFor(mime, name),
          name,
          createdBy: actorRef(ctx.actor),
        }));
      const versionId = newId("astv");
      const storageKey = `assets/${asset.id}/${versionId}/${safeObjectName(name)}`;
      try {
        await deps.storage.put(ctx, storageKey, source.bytes, { contentType: mime, sha256 });
        const provenance: AssetProvenance = {
          source: source.sourceUrl ? "external" : "upload",
          ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
          ...(input.license ? { license: input.license } : {}),
          createdAt: now().toISOString(),
        };
        const version = await deps.assets.addVersion(ctx, {
          id: versionId,
          assetId: asset.id,
          storageKey,
          sha256,
          mime,
          bytes: source.bytes.byteLength,
          provenance,
          createdBy: actorRef(ctx.actor),
        });
        if (input.derivedFrom?.length) {
          await deps.revisions.addLineage(
            ctx,
            input.derivedFrom.map((inputId) => ({
              assetVersionId: version.id,
              inputKind: "asset_version" as const,
              inputId,
              role: "derived",
            })),
          );
        }
        await audit(ctx, existing ? "asset.version_added" : "asset.uploaded", asset.id, {
          versionId: version.id,
          version: version.version,
          bytes: version.bytes,
          mime,
          source: provenance.source,
        });
        const fresh = (await deps.assets.get(ctx, asset.id)) ?? asset;
        const signed = await sign(ctx, fresh, version);
        return {
          asset: summaryOf(fresh, version, version.version),
          versionId: version.id,
          version: version.version,
          unchanged: false,
          ...("url" in signed ? { url: signed.url } : {}),
        };
      } catch (err) {
        // A new asset whose first version failed would be an empty shell; move it to the trash.
        if (!existing) await deps.assets.setDeleted(ctx, asset.id, true).catch(() => undefined);
        throw err;
      }
    },

    async update(ctx: TenantContext, raw: AssetUpdateInput): Promise<AssetSummary> {
      assertPermission(ctx, "asset:write");
      const input = parseInput(AssetUpdateInput, raw, "asset update");
      const before = await requireAsset(ctx, input.assetId);
      if (input.projectId) await requireProject(ctx, input.projectId);
      const asset = await deps.assets.update(ctx, before.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      });
      await audit(ctx, "asset.updated", asset.id, {
        ...(input.name !== undefined ? { name: { from: before.name, to: asset.name } } : {}),
        ...(input.projectId !== undefined
          ? { projectId: { from: before.projectId ?? null, to: asset.projectId ?? null } }
          : {}),
      });
      return summarize(ctx, asset);
    },

    /** Trash (`deleted: true`) or restore an asset. Repeating a call changes nothing. */
    async setDeleted(ctx: TenantContext, assetId: string, deleted: boolean): Promise<AssetSummary> {
      assertPermission(ctx, "asset:write");
      const id = parseInput(Id, assetId, "asset id");
      const before = await requireAsset(ctx, id);
      const asset = await deps.assets.setDeleted(ctx, id, deleted);
      if (Boolean(before.deletedAt) !== deleted) {
        await audit(ctx, deleted ? "asset.deleted" : "asset.restored", asset.id, {});
      }
      return summarize(ctx, asset);
    },
  };
}
