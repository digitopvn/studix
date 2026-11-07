import type { Asset, AssetKind, AssetRole, AssetVersion } from "../entities/asset.ts";
import type { NewRecord } from "../entities/common.ts";
import type { TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

/** `role` defaults to the one inferred from `kind` and `name`; `path` to `defaultAssetPath(role)`; `tags` to none. */
export type NewAsset = Omit<NewRecord<Asset>, "currentVersionId" | "role" | "path" | "tags"> &
  Partial<Pick<Asset, "role" | "path" | "tags">>;
export type AssetListQuery = PageRequest & {
  projectId?: string;
  kind?: AssetKind;
  role?: AssetRole;
  /** Folder and everything below it. */
  pathPrefix?: string;
  tag?: string;
};
export type AssetPatch = Partial<Pick<Asset, "role" | "path" | "tags" | "name">>;
/** `version` is assigned by the repository; the asset's currentVersionId moves to the new version. */
export type NewAssetVersion = Omit<NewRecord<AssetVersion>, "version">;

export interface AssetRepository {
  create(ctx: TenantContext, input: NewAsset): Promise<Asset>;
  get(ctx: TenantContext, id: string): Promise<Asset | undefined>;
  list(ctx: TenantContext, query?: AssetListQuery): Promise<Page<Asset>>;
  /** Changes only the organization fields; the binary versions are untouched. */
  update(ctx: TenantContext, id: string, patch: AssetPatch): Promise<Asset>;
  addVersion(ctx: TenantContext, input: NewAssetVersion): Promise<AssetVersion>;
  /** The versions with these ids (missing ones are left out), in one query. */
  getVersions(ctx: TenantContext, versionIds: readonly string[]): Promise<AssetVersion[]>;
  getVersion(ctx: TenantContext, versionId: string): Promise<AssetVersion | undefined>;
  /** Newest version first. */
  listVersions(ctx: TenantContext, assetId: string): Promise<AssetVersion[]>;
}
