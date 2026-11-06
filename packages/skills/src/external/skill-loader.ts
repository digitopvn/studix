import {
  EXTERNAL_SKILL_LIMITS,
  type FetchedSkill,
  type FetchedSkillFile,
  type RejectedSkill,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { decodeUtf8, downloadBlob, sha256Hex } from "./github-blob.ts";
import type { GitHubSession } from "./github-client.ts";
import type { TreeEntry } from "./github-schemas.ts";
import type { RepoRef } from "./github-tree.ts";
import {
  baseName,
  dirName,
  displaySkillPath,
  normalizeRepoPath,
  pathDepth,
  printablePath,
} from "./repo-path.ts";
import { fetchPlannedFiles, metadataSha, planSkillFiles, SKILL_MD_TYPE } from "./skill-files.ts";
import { parseSkillMd } from "./skill-frontmatter.ts";
import { collectNotices, type RepoLicense, resolveLicense } from "./skill-license.ts";
import { mergeWarnings, scanSkillWarnings } from "./skill-warnings.ts";

export const SKILL_MD = "SKILL.md";

export interface TreeIndex {
  /** Entries with safe, normalized paths no deeper than the depth bound. */
  entries: TreeEntry[];
  /** Every `SKILL.md` blob (including symlinks, which `loadSkill` rejects), keyed by skill directory. */
  skillMds: Map<string, TreeEntry>;
  /** `SKILL.md` files rejected from the tree alone, keyed by skill directory (or printable raw path). */
  rejected: Map<string, string>;
}

export type LoadedSkill = { ok: true; skill: FetchedSkill } | { ok: false; reason: string };

export interface LoadContext {
  session: GitHubSession;
  ref: RepoRef;
  index: TreeIndex;
  license: RepoLicense | undefined;
  /** Download references and assets too (fetch), or only SKILL.md (discover). */
  download: boolean;
}

/** Validate every tree path individually; unsafe or too-deep `SKILL.md` files become rejections. */
export function indexTree(raw: TreeEntry[]): TreeIndex {
  const index: TreeIndex = { entries: [], skillMds: new Map(), rejected: new Map() };
  for (const entry of raw) {
    const isSkillMd = baseName(entry.path) === SKILL_MD && entry.type === "blob";
    const path = normalizeRepoPath(entry.path);
    if (path === undefined || path === "") {
      if (isSkillMd) index.rejected.set(printablePath(entry.path), "unsafe path");
      continue;
    }
    if (pathDepth(path) > EXTERNAL_SKILL_LIMITS.maxPathDepth) {
      if (isSkillMd) {
        index.rejected.set(dirName(path), `path deeper than ${EXTERNAL_SKILL_LIMITS.maxPathDepth} levels`);
      }
      continue;
    }
    const safe = { ...entry, path };
    index.entries.push(safe);
    if (isSkillMd) index.skillMds.set(dirName(path), safe);
  }
  index.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return index;
}

export function rejectedList(rejected: Map<string, string>, keep: (dir: string) => boolean): RejectedSkill[] {
  return [...rejected]
    .filter(([dir]) => keep(dir))
    .map(([dir, reason]) => ({ path: displaySkillPath(dir), reason }));
}

/**
 * Load one skill from its `SKILL.md` entry. Only budget/lookup failures of this skill are turned into a
 * rejection; rate limits, timeouts and provider errors still fail the whole operation.
 */
export async function loadSkill(ctx: LoadContext, dir: string, entry: TreeEntry): Promise<LoadedSkill> {
  try {
    return await loadSkillUnchecked(ctx, dir, entry);
  } catch (err) {
    if (err instanceof StudixError && (err.code === "VALIDATION" || err.code === "NOT_FOUND")) {
      return { ok: false, reason: err.message };
    }
    throw err;
  }
}

async function loadSkillUnchecked(ctx: LoadContext, dir: string, entry: TreeEntry): Promise<LoadedSkill> {
  if (entry.mode === "120000") return { ok: false, reason: "symlink" };
  const limit = EXTERNAL_SKILL_LIMITS.maxSkillMdBytes;
  if ((entry.size ?? 0) > limit) return { ok: false, reason: `SKILL.md too large (limit ${limit} bytes)` };
  const blob = await downloadBlob(ctx.session, ctx.ref, entry.sha, limit);
  if (!blob.ok) return { ok: false, reason: `SKILL.md ${blob.reason}` };
  const text = decodeUtf8(blob.bytes);
  if (text === undefined)
    return { ok: false, reason: "SKILL.md is not valid UTF-8 text or contains NUL bytes" };
  const parsed = parseSkillMd(text, dir === "" ? ctx.ref.repo : baseName(dir));
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const licenseFile = ctx.license?.file;
  const licenseBytes = licenseFile?.content?.length ?? 0;
  const reserved = { files: licenseBytes > 0 ? 2 : 1, bytes: blob.bytes.length + licenseBytes };
  const planned = planSkillFiles(ctx.index.entries, dir, reserved);
  const fetched = ctx.download
    ? await fetchPlannedFiles(ctx.session, ctx.ref, planned)
    : {
        files: planned.map(({ path, kind, bytes, contentType, gitSha, skipped }) => ({
          path,
          kind,
          bytes,
          contentType,
          sha256: metadataSha(gitSha),
          ...(skipped === undefined ? {} : { skipped }),
        })),
        texts: [],
      };
  const skillFile: FetchedSkillFile = {
    path: SKILL_MD,
    kind: "skill",
    bytes: blob.bytes.length,
    sha256: sha256Hex(blob.bytes),
    contentType: SKILL_MD_TYPE,
    content: blob.bytes,
  };
  const files = [skillFile, ...(licenseFile ? [licenseFile] : []), ...fetched.files];
  return {
    ok: true,
    skill: {
      path: displaySkillPath(dir),
      name: parsed.name,
      description: parsed.description,
      frontmatter: parsed.frontmatter,
      files,
      license: resolveLicense(ctx.license, parsed.frontmatter),
      notices: collectNotices(parsed.frontmatter, ctx.license?.text),
      warnings: mergeWarnings(parsed.warnings, ...[text, ...fetched.texts].map(scanSkillWarnings)),
    },
  };
}
