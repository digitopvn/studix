import type { Asset, AssetKind, AssetRole, AssetVersion } from "../entities/asset.ts";
import type { NewRecord } from "../entities/common.ts";
import type { TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

/** `role` defaults to one inferred from the name and kind, `path` to the role folder, `tags` to none. */
export type NewAsset = Omit<NewRecord<Asset>, "currentVersionId" | "role" | "path" | "tags"> & {
  role?: AssetRole;
  path?: string;
  tags?: string[];
  /** Media type of the first version, used only to infer the role. */
  mime?: string;
};

export interface AssetListQuery extends PageRequest {
  projectId?: string;
  kind?: AssetKind;
  role?: AssetRole;
  /** Assets in this folder or any folder below it (`ep03` matches `ep03/sc01`, not `ep030`). */
  path?: string;
  tag?: string;
  /** Case-insensitive substring of the name. */
  search?: string;
}
/** `version` is assigned by the repository; the asset's currentVersionId moves to the new version. */
export type NewAssetVersion = Omit<NewRecord<AssetVersion>, "version">;

export interface AssetRepository {
  create(ctx: TenantContext, input: NewAsset): Promise<Asset>;
  get(ctx: TenantContext, id: string): Promise<Asset | undefined>;
  list(ctx: TenantContext, query?: AssetListQuery): Promise<Page<Asset>>;
  addVersion(ctx: TenantContext, input: NewAssetVersion): Promise<AssetVersion>;
  getVersion(ctx: TenantContext, versionId: string): Promise<AssetVersion | undefined>;
  /** Newest version first. */
  listVersions(ctx: TenantContext, assetId: string): Promise<AssetVersion[]>;
}
