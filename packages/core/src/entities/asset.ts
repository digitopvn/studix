import { StudixError } from "@studix/shared";
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

export const MAX_ASSET_PATH_LENGTH = 200;
export const MAX_ASSET_TAGS = 20;

/**
 * Virtual folder such as `ep03/sc01/s05`: lowercase segments joined by `/`, no leading or trailing slash.
 * Throws on `..` or other unsafe segments; an empty string is the library root.
 */
export function normalizeAssetPath(raw: string): string {
  const segments = raw
    .trim()
    .toLowerCase()
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const segment of segments) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(segment) || segment === "." || segment === "..") {
      throw new StudixError(
        "VALIDATION",
        `invalid asset path segment "${segment}": use letters, digits, ".", "_" or "-"`,
      );
    }
  }
  const path = segments.join("/");
  if (path.length > MAX_ASSET_PATH_LENGTH)
    throw new StudixError("VALIDATION", `asset path longer than ${MAX_ASSET_PATH_LENGTH}`);
  return path;
}

export function normalizeAssetTags(tags: readonly string[]): string[] {
  const out = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  for (const tag of out) {
    if (tag.length > 40) throw new StudixError("VALIDATION", "asset tags are at most 40 characters");
  }
  if (out.length > MAX_ASSET_TAGS)
    throw new StudixError("VALIDATION", `at most ${MAX_ASSET_TAGS} asset tags`);
  return out;
}

/** A word of the file name: letters only, so digits, `-`, `_` and `.` all separate words. */
const word = (alternatives: string) => new RegExp(`(^|[^a-z])(?:${alternatives})([^a-z]|$)`);

// Order matters, and migration 0034 backfills with the same words in the same order.
const ROLE_WORDS: ReadonlyArray<readonly [AssetRole, RegExp]> = [
  ["storyboard", word("storyboard|story[^a-z]?board")],
  ["keyframe", word("keyframes?|key[^a-z]?frames?")],
  ["character", word("characters?|char|lead[^a-z]?sheet|turnaround")],
  ["background", word("backgrounds?|bg|backdrop|environment")],
  ["prop", word("props?")],
  ["vfx", word("vfx|particles?|explosions?")],
  ["sfx", word("sfx|sound[^a-z]?effects?|whoosh|impact|foley|fx")],
  ["bgm", word("bgm|music|score|soundtrack|theme")],
  ["voice", word("voice|vo|narration|dialogue|speech")],
  ["reference", word("reference|ref|moodboard")],
];

/** Best guess of the role from the media kind and file name; `other` when nothing fits. */
export function inferAssetRole(kind: AssetKind, name: string): AssetRole {
  if (kind === "render") return "render";
  const text = name.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, "");
  for (const [role, re] of ROLE_WORDS) {
    if (!re.test(text)) continue;
    // Sound roles apply to audio only; picture roles apply to images and video.
    const sound = role === "sfx" || role === "bgm" || role === "voice";
    if (sound !== (kind === "audio")) continue;
    return role;
  }
  return "other";
}

/** Folder an agent saves into when it names none: `<role>`. */
export function defaultAssetPath(role: AssetRole): string {
  return role === "other" ? "" : role;
}

/** Library entry; binary content lives in immutable AssetVersions. */
export interface Asset extends TenantOwned {
  projectId?: string;
  kind: AssetKind;
  role: AssetRole;
  /** Virtual folder (see normalizeAssetPath); empty at the library root. */
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
