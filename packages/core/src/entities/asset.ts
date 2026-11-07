import type { AssetProvenance } from "@studix/video-ir";
import type { ActorRef, TenantOwned } from "./common.ts";

export const ASSET_KINDS = ["image", "video", "audio", "font", "document", "code", "render"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** What an asset is for in a production; `kind` stays the media type. */
export const ASSET_ROLES = [
  "character",
  "background",
  "prop",
  "vfx",
  "sfx",
  "bgm",
  "voice",
  "storyboard",
  "keyframe",
  "render",
  "reference",
  "other",
] as const;
export type AssetRole = (typeof ASSET_ROLES)[number];

export const ASSET_LIMITS = { pathChars: 200, pathDepth: 8, tags: 16, tagChars: 40 } as const;

/** Library entry; binary content lives in immutable AssetVersions. */
export interface Asset extends TenantOwned {
  projectId?: string;
  kind: AssetKind;
  /** Production role (see ASSET_ROLES). */
  role: AssetRole;
  /** Virtual folder such as `ep03/sc01/s05`: lowercase segments, no leading or trailing slash. "" = root. */
  path: string;
  tags: string[];
  name: string;
  currentVersionId?: string;
  createdBy: ActorRef;
  updatedAt: Date;
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
