import { EXTERNAL_SKILL_LIMITS, type ExternalSkillFileKind, type FetchedSkillFile } from "@studix/core";
import { decodeUtf8, downloadBlob, sha256Hex } from "./github-blob.ts";
import type { GitHubSession } from "./github-client.ts";
import type { TreeEntry } from "./github-schemas.ts";
import type { RepoRef } from "./github-tree.ts";

/** A file under a skill directory, classified from the tree alone (nothing downloaded yet). */
export interface PlannedFile {
  path: string;
  kind: ExternalSkillFileKind;
  bytes: number;
  gitSha: string;
  contentType: string;
  /** Text files are checked for UTF-8 and scanned for warnings once downloaded. */
  text: boolean;
  skipped?: string;
}

const KIND_BY_DIR: Readonly<Record<string, ExternalSkillFileKind>> = {
  references: "reference",
  assets: "asset",
  scripts: "script",
};
const TEXT_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv",
  toml: "application/toml",
  html: "text/html",
  css: "text/css",
  xml: "application/xml",
  tsv: "text/tab-separated-values",
};
const ASSET_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};
const OPAQUE_TYPE = "application/octet-stream";
export const SKILL_MD_TYPE = "text/markdown; charset=utf-8";
export const SCRIPT_SKIPPED = "script: recorded as metadata only, never executed";

/** `sha256` of a file that was recorded but not downloaded: its git blob sha, prefixed `git:`. */
export function metadataSha(gitSha: string): string {
  return `git:${gitSha}`;
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function classify(entry: TreeEntry, rel: string, kind: ExternalSkillFileKind): PlannedFile {
  const bytes = entry.size ?? 0;
  const base = { path: rel, kind, bytes, gitSha: entry.sha, contentType: OPAQUE_TYPE, text: false };
  if (entry.type === "commit") return { ...base, skipped: "submodule: not followed" };
  if (entry.mode === "120000") return { ...base, skipped: "symlink" };
  if (kind === "script") return { ...base, skipped: SCRIPT_SKIPPED };
  const ext = extension(rel);
  const textType = TEXT_TYPES[ext];
  if (textType !== undefined) {
    const planned = { ...base, contentType: `${textType}; charset=utf-8`, text: true };
    const limit = EXTERNAL_SKILL_LIMITS.maxTextFileBytes;
    return bytes > limit ? { ...planned, skipped: `too large (${bytes} bytes, limit ${limit})` } : planned;
  }
  const assetType = ASSET_TYPES[ext];
  if (assetType !== undefined) {
    const planned = { ...base, contentType: assetType };
    const limit = EXTERNAL_SKILL_LIMITS.maxAssetFileBytes;
    return bytes > limit ? { ...planned, skipped: `too large (${bytes} bytes, limit ${limit})` } : planned;
  }
  if (ext === "svg") return { ...base, contentType: "image/svg+xml", skipped: "svg may contain script" };
  return { ...base, skipped: "unsupported file type" };
}

/**
 * Classify the supported files of skill directory `dir` (`references/**`, `assets/**`, `scripts/**`).
 * `reserved` counts the files and bytes already committed (SKILL.md, license). Files beyond the count or
 * aggregate size bounds stay listed with a `skipped` reason; nothing is silently dropped.
 */
export function planSkillFiles(
  /** Sorted by path (as `indexTree` returns them), so a directory's entries are one contiguous range. */
  entries: TreeEntry[],
  dir: string,
  reserved: { files: number; bytes: number },
): PlannedFile[] {
  let files = reserved.files;
  let bytes = reserved.bytes;
  const planned: PlannedFile[] = [];
  const prefix = dir === "" ? "" : `${dir}/`;
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((entries[mid]?.path ?? "") < prefix) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined || !entry.path.startsWith(prefix)) break;
    if (entry.type === "tree" || entry.path === dir) continue;
    const rel = dir === "" ? entry.path : entry.path.slice(dir.length + 1);
    const slash = rel.indexOf("/");
    const kind = slash > 0 ? KIND_BY_DIR[rel.slice(0, slash)] : undefined;
    if (kind === undefined) continue;
    const file = classify(entry, rel, kind);
    if (file.skipped === undefined) {
      if (files >= EXTERNAL_SKILL_LIMITS.maxFilesPerSkill) {
        file.skipped = `file count limit (${EXTERNAL_SKILL_LIMITS.maxFilesPerSkill} files)`;
      } else if (bytes + file.bytes > EXTERNAL_SKILL_LIMITS.maxSkillBytes) {
        file.skipped = `skill size limit (${EXTERNAL_SKILL_LIMITS.maxSkillBytes} bytes)`;
      } else {
        files += 1;
        bytes += file.bytes;
      }
    }
    planned.push(file);
  }
  return planned;
}

/** Download every planned file that is not skipped; text files that turn out binary are skipped instead. */
export async function fetchPlannedFiles(
  session: GitHubSession,
  ref: RepoRef,
  planned: PlannedFile[],
): Promise<{ files: FetchedSkillFile[]; texts: string[] }> {
  const files: FetchedSkillFile[] = [];
  const texts: string[] = [];
  for (const file of planned) {
    const entry = { path: file.path, kind: file.kind, bytes: file.bytes, contentType: file.contentType };
    if (file.skipped !== undefined) {
      files.push({ ...entry, sha256: metadataSha(file.gitSha), skipped: file.skipped });
      continue;
    }
    const limit = file.text
      ? EXTERNAL_SKILL_LIMITS.maxTextFileBytes
      : EXTERNAL_SKILL_LIMITS.maxAssetFileBytes;
    const blob = await downloadBlob(session, ref, file.gitSha, limit);
    const text = blob.ok && file.text ? decodeUtf8(blob.bytes) : undefined;
    if (!blob.ok || (file.text && text === undefined)) {
      const skipped = blob.ok ? "binary content in a text file" : blob.reason;
      files.push({ ...entry, sha256: metadataSha(file.gitSha), skipped });
      continue;
    }
    if (text !== undefined) texts.push(text);
    files.push({ ...entry, bytes: blob.bytes.length, sha256: sha256Hex(blob.bytes), content: blob.bytes });
  }
  return { files, texts };
}
