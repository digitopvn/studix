import type { Asset, AssetKind, AssetVersion } from "../entities/asset.ts";
import type { NewRecord } from "../entities/common.ts";
import type { TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export type NewAsset = Omit<NewRecord<Asset>, "currentVersionId">;
/** `version` is assigned by the repository; the asset's currentVersionId moves to the new version. */
export type NewAssetVersion = Omit<NewRecord<AssetVersion>, "version">;

export type AssetListState = "active" | "deleted" | "all";

export type AssetListQuery = PageRequest & {
  projectId?: string;
  kind?: AssetKind;
  /** Case-insensitive part of the name. */
  q?: string;
  /** Defaults to `active`. */
  state?: AssetListState;
};

export interface AssetPatch {
  name?: string;
  projectId?: string | null;
}

export interface AssetRepository {
  create(ctx: TenantContext, input: NewAsset): Promise<Asset>;
  get(ctx: TenantContext, id: string): Promise<Asset | undefined>;
  /** Newest first. Trashed assets are left out unless `state` says otherwise. */
  list(ctx: TenantContext, query?: AssetListQuery): Promise<Page<Asset>>;
  /** Rename and/or move to another project (`null` detaches). NOT_FOUND outside the workspace. */
  update(ctx: TenantContext, id: string, patch: AssetPatch): Promise<Asset>;
  /** Move to the trash or back; idempotent. NOT_FOUND outside the workspace. */
  setDeleted(ctx: TenantContext, id: string, deleted: boolean): Promise<Asset>;
  addVersion(ctx: TenantContext, input: NewAssetVersion): Promise<AssetVersion>;
  getVersion(ctx: TenantContext, versionId: string): Promise<AssetVersion | undefined>;
  /** Newest version first. */
  listVersions(ctx: TenantContext, assetId: string): Promise<AssetVersion[]>;
}
