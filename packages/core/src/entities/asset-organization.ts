import { StudixError } from "@studix/shared";
import { ASSET_LIMITS, type AssetKind, type AssetRole } from "./asset.ts";

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Canonical virtual folder: trims slashes and blanks, lowercases, and rejects `.`/`..`, odd characters and
 * overlong or too deep paths. "" is the root.
 */
export function normalizeAssetPath(raw: string | undefined): string {
  const segments = (raw ?? "")
    .trim()
    .toLowerCase()
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const path = segments.join("/");
  const invalid =
    segments.length > ASSET_LIMITS.pathDepth ||
    path.length > ASSET_LIMITS.pathChars ||
    segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..");
  if (invalid) {
    throw new StudixError(
      "VALIDATION",
      `Asset path "${raw}" is not valid: use up to ${ASSET_LIMITS.pathDepth} lowercase segments like ep03/sc01/s05 (letters, digits, . _ -).`,
      { retryable: false, details: { field: "path" } },
    );
  }
  return path;
}

/** Lowercased, trimmed, de-duplicated tags within the limits. */
export function normalizeAssetTags(raw: readonly string[] | undefined): string[] {
  const tags = [...new Set((raw ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  if (tags.length > ASSET_LIMITS.tags || tags.some((t) => t.length > ASSET_LIMITS.tagChars)) {
    throw new StudixError(
      "VALIDATION",
      `Use at most ${ASSET_LIMITS.tags} tags of ${ASSET_LIMITS.tagChars} characters each.`,
      { retryable: false, details: { field: "tags" } },
    );
  }
  return tags;
}

const NAME_HINTS: ReadonlyArray<readonly [RegExp, AssetRole]> = [
  [/(^|[^a-z])(sfx|foley|whoosh|impact|sound[-_ ]?effect)([^a-z]|$)/, "sfx"],
  [/(^|[^a-z])(bgm|music|soundtrack|theme[-_ ]?song)([^a-z]|$)/, "bgm"],
  [/(^|[^a-z])(voice|vo|voiceover|dialog(ue)?|narration|tts|speech)([^a-z]|$)/, "voice"],
  [/(^|[^a-z])(vfx|particles?|overlay|glitch|fx)([^a-z]|$)/, "vfx"],
  [/(^|[^a-z])(storyboard)([^a-z]|$)/, "storyboard"],
  [/(^|[^a-z])(keyframe|key[-_ ]?frame|kf)([^a-z]|$)/, "keyframe"],
  [/(^|[^a-z])(character|char|turnaround)([^a-z]|$)/, "character"],
  [/(^|[^a-z])(background|bg|backdrop|environment|location)([^a-z]|$)/, "background"],
  [/(^|[^a-z])(prop|props)([^a-z]|$)/, "prop"],
  [/(^|[^a-z])(reference|ref|moodboard)([^a-z]|$)/, "reference"],
];

/**
 * Best-effort role for a file nobody labelled: the file name wins, then the media type. Audio and anything
 * unrecognized fall back to `other` rather than guessing a role the file may not have.
 */
export function inferAssetRole(input: { name: string; mime?: string; kind?: AssetKind }): AssetRole {
  const name = input.name.toLowerCase();
  for (const [pattern, role] of NAME_HINTS) if (pattern.test(name)) return role;
  const kind =
    input.kind ??
    (input.mime?.startsWith("video/") ? "video" : input.mime?.startsWith("audio/") ? "audio" : undefined);
  if (kind === "render") return "render";
  return "other";
}

/** Folder an agent saves into when it names none: the role, so a library reads as `sfx/`, `bgm/`, … */
export function defaultAssetPath(role: AssetRole): string {
  return role === "other" ? "" : role;
}

/** The role, folder and tags a new asset is stored with, from what the caller gave and what can be inferred. */
export function organizeNewAsset(input: {
  name: string;
  kind: AssetKind;
  mime?: string;
  role?: AssetRole;
  path?: string;
  tags?: readonly string[];
}): { role: AssetRole; path: string; tags: string[] } {
  const role = input.role ?? inferAssetRole(input);
  const path = input.path === undefined ? defaultAssetPath(role) : normalizeAssetPath(input.path);
  return { role, path, tags: normalizeAssetTags(input.tags) };
}

/** Whether `path` is `folder` or inside it; the root folder ("") holds everything. */
export function isInAssetFolder(path: string, folder: string): boolean {
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}
