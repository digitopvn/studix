import type { Asset, AssetKind, AssetVersion } from "../entities/asset.ts";
import type { NewRecord } from "../entities/common.ts";
import type { TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export type NewAsset = Omit<NewRecord<Asset>, "currentVersionId">;
/** `version` is assigned by the repository; the asset's currentVersionId moves to the new version. */
export type NewAssetVersion = Omit<NewRecord<AssetVersion>, "version">;

export interface AssetRepository {
  create(ctx: TenantContext, input: NewAsset): Promise<Asset>;
  get(ctx: TenantContext, id: string): Promise<Asset | undefined>;
  list(
    ctx: TenantContext,
    query?: PageRequest & { projectId?: string; kind?: AssetKind },
  ): Promise<Page<Asset>>;
  addVersion(ctx: TenantContext, input: NewAssetVersion): Promise<AssetVersion>;
  getVersion(ctx: TenantContext, versionId: string): Promise<AssetVersion | undefined>;
  /** Newest version first. */
  listVersions(ctx: TenantContext, assetId: string): Promise<AssetVersion[]>;
}
