import {
  ASSET_KINDS,
  ASSET_ROLES,
  type Asset,
  type AssetRepository,
  type AssetVersion,
  assertPermission,
  MAX_ASSET_PATH_LENGTH,
  MAX_ASSET_TAGS,
  normalizeAssetPath,
  type Page,
  type TenantContext,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";

const FolderPath = z
  .string()
  .max(MAX_ASSET_PATH_LENGTH)
  .refine((p) => {
    try {
      normalizeAssetPath(p);
      return true;
    } catch {
      return false;
    }
  }, "folder names use letters, digits, '.', '_' or '-', separated by '/'");

/** Filters shared by `GET /api/assets` and `studix_list_assets`. */
export const AssetListInput = z.object({
  role: z.enum(ASSET_ROLES).optional().describe("character, vfx, sfx, bgm, voice, storyboard, ..."),
  kind: z.enum(ASSET_KINDS).optional().describe("Media type: image, video, audio, ..."),
  path: FolderPath.optional().describe("Folder and everything below it, e.g. ep03/sc01."),
  tag: z.string().trim().min(1).max(40).optional(),
  projectId: z.string().trim().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(200).optional(),
});
export type AssetListInput = z.infer<typeof AssetListInput>;

/** Organization fields only; at least one is required. The binary and its versions never change here. */
export const AssetUpdateInput = z.object({
  role: z.enum(ASSET_ROLES).optional(),
  path: FolderPath.optional().describe("Virtual folder; empty string moves it to the library root."),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(MAX_ASSET_TAGS)
    .optional()
    .describe("Replaces all tags."),
  name: z.string().trim().min(1).max(200).optional(),
});
export type AssetUpdateInput = z.infer<typeof AssetUpdateInput>;

export interface AssetView {
  id: string;
  name: string;
  kind: Asset["kind"];
  role: Asset["role"];
  path: string;
  tags: string[];
  projectId?: string;
  currentVersionId?: string;
  mime?: string;
  bytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  updatedAt: string;
}

function view(asset: Asset, version: AssetVersion | undefined): AssetView {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    role: asset.role,
    path: asset.path,
    tags: asset.tags,
    ...(asset.projectId ? { projectId: asset.projectId } : {}),
    ...(asset.currentVersionId ? { currentVersionId: asset.currentVersionId } : {}),
    ...(version
      ? {
          mime: version.mime,
          bytes: version.bytes,
          ...(version.durationMs !== undefined ? { durationMs: version.durationMs } : {}),
          ...(version.width !== undefined ? { width: version.width } : {}),
          ...(version.height !== undefined ? { height: version.height } : {}),
        }
      : {}),
    updatedAt: asset.updatedAt.toISOString(),
  };
}

export async function listAssets(
  repo: AssetRepository,
  ctx: TenantContext,
  input: AssetListInput,
): Promise<{ assets: AssetView[]; nextCursor?: string }> {
  assertPermission(ctx, "asset:read");
  const page: Page<Asset> = await repo.list(ctx, {
    ...(input.role ? { role: input.role } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.path ? { pathPrefix: input.path } : {}),
    ...(input.tag ? { tag: input.tag } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  const ids = page.items.flatMap((a) => (a.currentVersionId ? [a.currentVersionId] : []));
  const versions = new Map((await repo.getVersions(ctx, ids)).map((v) => [v.id, v]));
  return {
    assets: page.items.map((a) => view(a, a.currentVersionId ? versions.get(a.currentVersionId) : undefined)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function updateAsset(
  repo: AssetRepository,
  ctx: TenantContext,
  id: string,
  input: AssetUpdateInput,
): Promise<AssetView> {
  assertPermission(ctx, "asset:write");
  if (Object.values(input).every((v) => v === undefined)) {
    throw new StudixError("VALIDATION", "Nothing to change", {
      retryable: false,
      suggestedAction: "Give at least one of role, path, tags or name.",
    });
  }
  if (!(await repo.get(ctx, id))) {
    throw new StudixError("NOT_FOUND", `Asset ${id} not found`, {
      retryable: false,
      suggestedAction: "List assets with studix_list_assets to find the id.",
    });
  }
  const asset = await repo.update(ctx, id, input);
  return view(asset, asset.currentVersionId ? await repo.getVersion(ctx, asset.currentVersionId) : undefined);
}
