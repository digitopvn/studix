import type { AssetProvenance } from "@studix/video-ir";
import type { ActorRef, TenantOwned } from "./common.ts";

export const ASSET_KINDS = ["image", "video", "audio", "font", "document", "code", "render"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** Library entry; binary content lives in immutable AssetVersions. */
export interface Asset extends TenantOwned {
  projectId?: string;
  kind: AssetKind;
  name: string;
  currentVersionId?: string;
  createdBy: ActorRef;
  updatedAt: Date;
  /** Set while the asset is in the trash; its versions and bytes stay until it is restored or purged. */
  deletedAt?: Date;
}

export interface AssetVersion extends TenantOwned {
  assetId: string;
  version: number;
  /** Tenant-relative object key (see tenantObjectKey). */
  storageKey: string;
  sha256: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  provenance: AssetProvenance;
  createdBy: ActorRef;
}
