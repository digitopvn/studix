import { createHash } from "node:crypto";
import type {
  ExternalSkillFileKind,
  ExternalSkillLicense,
  ExternalSkillManifest,
  ExternalSkillManifestFile,
  ExternalSkillSecurityNote,
  SkillRiskReport,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import type { GitHubRepositoryInfo, GitHubSource, GitTreeEntry } from "./github-source.ts";
import {
  githubWebUrl,
  isFullCommitSha,
  isSafeRepoPath,
  normalizeSkillPath,
  type ParsedGitHubUrl,
} from "./github-url.ts";
import { mapLimit, type SkillImportLimits } from "./import-limits.ts";
import { parseSkillMarkdown, SkillFormatError, skillIdentity } from "./skill-frontmatter.ts";
import { SkillRiskScanner } from "./skill-risk-scan.ts";
import { scanSkillText } from "./skill-text-scan.ts";

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "mdx",
  "txt",
  "text",
  "rst",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
  "xml",
  "html",
  "htm",
  "ini",
  "tex",
]);
const LICENSE_NAME = /^(?:LICEN[CS]E|COPYING|NOTICE)(?:[.-][A-Za-z0-9]+)?$/i;
const KIND_PRIORITY: Record<ExternalSkillFileKind, number> = {
  skill: 0,
  license: 1,
  reference: 2,
  asset: 3,
  script: 4,
  other: 5,
};

/** The repository, ref and commit an operation is pinned to, plus the directory it was scoped to. */
export interface ResolvedTarget {
  owner: string;
  repo: string;
  /** What the caller asked for; undefined when the default branch was used. */
  requestedRef?: string;
  ref: string;
  commitSha: string;
  defaultBranch: string;
  license?: GitHubRepositoryInfo["license"];
  /** Directory the scan is limited to ("" = whole repository). */
  scope: string;
}

export interface PlannedFile {
  /** Path relative to the skill directory. */
  path: string;
  repoPath: string;
  kind: ExternalSkillFileKind;
  bytes: number;
  gitSha: string;
  executable?: boolean;
  /** Set when the file is described but never read. */
  skipped?: string;
}

export interface SkillCandidate {
  /** Skill directory relative to the repository root ("" = root). */
  path: string;
  status: "valid" | "invalid";
  problems: string[];
  name?: string;
  description?: string;
  frontmatter: Record<string, string>;
  skillText?: string;
  planned: PlannedFile[];
  /** Files beyond the per-skill file limit that were left out of the record. */
  omittedFiles: number;
}

export interface ScanResult {
  target: ResolvedTarget;
  candidates: SkillCandidate[];
  /** Why the list may be incomplete (truncated listing, skill limit). */
  incomplete: string[];
  rootLicenseFiles: string[];
}

/** Resolve a URL (plus optional ref and path) to one commit. The commit sha is what gets recorded. */
export async function resolveTarget(
  source: GitHubSource,
  parsed: ParsedGitHubUrl,
  explicit: { ref?: string; path?: string },
): Promise<ResolvedTarget> {
  const info = await source.repository(parsed.owner, parsed.repo);
  const explicitRef = explicit.ref?.trim() || undefined;
  if (explicitRef !== undefined && (explicitRef.length > 255 || hasControlOrSpace(explicitRef))) {
    throw new StudixError("VALIDATION", "Invalid ref");
  }
  const explicitPath = explicit.path === undefined ? undefined : normalizeSkillPath(explicit.path);

  let options: Array<{ ref?: string; path: string }>;
  if (parsed.refAndPath) {
    const segments = parsed.refAndPath;
    options = [];
    // A ref may contain slashes, so try the shortest prefixes first.
    for (let i = 1; i <= Math.min(segments.length, 6); i++) {
      const path = segments.slice(i).join("/");
      options.push({ ref: segments.slice(0, i).join("/"), path: normalizeSkillPath(path) });
    }
    if (explicitRef !== undefined) options = options.filter((o) => o.ref === explicitRef);
    if (options.length === 0) options = [{ ref: explicitRef, path: "" }];
  } else {
    options = [{ ref: explicitRef, path: "" }];
  }

  for (const option of options) {
    const ref = option.ref ?? info.defaultBranch;
    const commitSha = await source.commit(parsed.owner, parsed.repo, ref);
    if (!commitSha) continue;
    if (
      isFullCommitSha(ref) &&
      !(await source.onBranch(parsed.owner, parsed.repo, info.defaultBranch, commitSha))
    ) {
      throw new StudixError("NOT_FOUND", "That commit is not on the default branch of this repository", {
        details: { ref },
        suggestedAction: "Use a branch or tag name of the repository instead of a commit id.",
      });
    }
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      ...(option.ref !== undefined ? { requestedRef: option.ref } : {}),
      ref,
      commitSha,
      defaultBranch: info.defaultBranch,
      ...(info.license ? { license: info.license } : {}),
      scope: explicitPath ?? option.path,
    };
  }
  throw new StudixError("NOT_FOUND", "The branch, tag or commit was not found", {
    details: { ref: explicitRef ?? parsed.refAndPath?.join("/") ?? info.defaultBranch },
    suggestedAction: "Check the ref, or leave it out to use the default branch.",
  });
}

export function assertExpectedCommit(target: ResolvedTarget, expected: string | undefined): void {
  if (expected === undefined) return;
  const want = expected.toLowerCase();
  const ok = isFullCommitSha(want)
    ? target.commitSha === want
    : want.length >= 7 && target.commitSha.startsWith(want);
  if (!ok) {
    throw new StudixError("CONFLICT", "The repository moved since the expected commit", {
      details: { expectedCommit: expected, currentCommit: target.commitSha, ref: target.ref },
      suggestedAction: "Run discovery again and import the commit it reports.",
    });
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function classify(rel: string): ExternalSkillFileKind {
  if (rel === "SKILL.md") return "skill";
  const first = rel.split("/")[0];
  if (first === "references" && rel.includes("/")) return "reference";
  if (first === "assets" && rel.includes("/")) return "asset";
  if (first === "scripts" && rel.includes("/")) return "script";
  if (!rel.includes("/") && LICENSE_NAME.test(rel)) return "license";
  // Docs linked from SKILL.md usually sit next to it.
  if (!rel.includes("/") && TEXT_EXTENSIONS.has(extensionOf(rel))) return "reference";
  return "other";
}

function skipReason(entry: GitTreeEntry, limits: SkillImportLimits): string | undefined {
  if (entry.mode === "120000") return "symbolic link; never followed";
  if (entry.type === "commit") return "submodule; not imported";
  if (entry.type !== "blob") return "not a file";
  if (entry.size === undefined || entry.size > limits.maxFileBytes) {
    return `larger than ${limits.maxFileBytes} bytes`;
  }
  return undefined;
}

function planFiles(
  dir: string,
  skillDirs: readonly string[],
  entries: readonly GitTreeEntry[],
  limits: SkillImportLimits,
): { planned: PlannedFile[]; omitted: number } {
  const prefix = dir === "" ? "" : `${dir}/`;
  const nested = skillDirs.filter((d) => d !== dir && (dir === "" || d.startsWith(prefix)));
  const files: PlannedFile[] = [];
  for (const entry of entries) {
    if (entry.type === "tree") continue;
    if (prefix !== "" && !entry.path.startsWith(prefix)) continue;
    if (nested.some((d) => entry.path.startsWith(`${d}/`))) continue;
    const rel = entry.path.slice(prefix.length);
    const kind = classify(rel);
    const skipped = skipReason(entry, limits);
    files.push({
      path: rel,
      repoPath: entry.path,
      kind,
      bytes: entry.size ?? 0,
      gitSha: entry.sha,
      ...(entry.mode === "100755" ? { executable: true } : {}),
      ...(skipped ? { skipped } : {}),
    });
  }
  files.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || (a.path < b.path ? -1 : 1));
  const kept = files.slice(0, limits.maxFilesPerSkill);
  // Stored bytes are capped per skill: later files are described but not kept.
  let total = 0;
  for (const file of kept) {
    if (file.skipped) continue;
    if (total + file.bytes > limits.maxSkillBytes) file.skipped = "skill size limit reached";
    else total += file.bytes;
  }
  return { planned: kept, omitted: files.length - kept.length };
}

function hasControlOrSpace(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || /\s/.test(ch)) return true;
  }
  return false;
}

/** Find every SKILL.md in scope, read and validate each, and plan its files. Invalid skills are reported, not fatal. */
export async function scanSkills(
  source: GitHubSource,
  target: ResolvedTarget,
  limits: SkillImportLimits,
): Promise<ScanResult> {
  const rawTree = await source.tree(target.owner, target.repo, target.commitSha);
  // Defence in depth: the client already drops unsafe paths, a different source must not widen that.
  const tree = { ...rawTree, entries: rawTree.entries.filter((e) => isSafeRepoPath(e.path)) };
  const incomplete: string[] = [];
  if (tree.truncated)
    incomplete.push("The repository listing was too large to read completely; some skills may be missing.");

  const depthOf = (dir: string) => (dir === "" ? 0 : dir.split("/").length);
  const skillMdEntries = tree.entries.filter((e) => e.type !== "tree" && /(^|\/)SKILL\.md$/.test(e.path));
  const allDirs = skillMdEntries
    .map((e) => (e.path === "SKILL.md" ? "" : e.path.slice(0, -"/SKILL.md".length)))
    .filter((d) => depthOf(d) <= limits.maxDepth);
  const scope = target.scope;
  let dirs: string[];
  if (scope === "") dirs = allDirs;
  else if (allDirs.includes(scope)) dirs = [scope];
  else dirs = allDirs.filter((d) => d.startsWith(`${scope}/`));
  dirs = [...new Set(dirs)].sort();
  if (dirs.length > limits.maxSkills) {
    incomplete.push(
      `More than ${limits.maxSkills} skills found; only the first ${limits.maxSkills} are listed.`,
    );
    dirs = dirs.slice(0, limits.maxSkills);
  }
  const rootLicenseFiles = tree.entries
    .filter((e) => e.type === "blob" && !e.path.includes("/") && LICENSE_NAME.test(e.path))
    .map((e) => e.path);

  const candidates = await mapLimit(dirs, limits.concurrency, async (dir): Promise<SkillCandidate> => {
    const mdPath = dir === "" ? "SKILL.md" : `${dir}/SKILL.md`;
    const entry = skillMdEntries.find((e) => e.path === mdPath)!;
    const { planned, omitted } = planFiles(dir, allDirs, tree.entries, limits);
    const base: SkillCandidate = {
      path: dir,
      status: "invalid",
      problems: [],
      frontmatter: {},
      planned,
      omittedFiles: omitted,
    };
    if (entry.mode === "120000" || entry.type !== "blob") {
      return { ...base, problems: ["SKILL.md is a symbolic link or submodule; skipped"] };
    }
    if ((entry.size ?? 0) > limits.maxFileBytes) {
      return { ...base, problems: [`SKILL.md is larger than ${limits.maxFileBytes} bytes`] };
    }
    try {
      const bytes = await source.blob(
        target.owner,
        target.repo,
        target.commitSha,
        mdPath,
        limits.maxFileBytes,
      );
      const text = decodeText(bytes);
      if (text === undefined) return { ...base, problems: ["SKILL.md is not valid UTF-8 text"] };
      const parsed = parseSkillMarkdown(text);
      const identity = skillIdentity(parsed.frontmatter);
      return { ...base, status: "valid", frontmatter: parsed.frontmatter, skillText: text, ...identity };
    } catch (err) {
      if (err instanceof SkillFormatError) return { ...base, problems: [err.message] };
      if (err instanceof StudixError && (err.code === "VALIDATION" || err.code === "NOT_FOUND")) {
        return { ...base, problems: [err.message] };
      }
      throw err;
    }
  });
  return { target, candidates, incomplete, rootLicenseFiles };
}

/** Strict UTF-8 text without NUL bytes, or undefined. */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface SkillBundle {
  name: string;
  description: string;
  manifest: ExternalSkillManifest;
  contentHash: string;
  risk: SkillRiskReport;
  /** Stored files by sha256, ready to write to object storage. */
  blobs: Map<string, { bytes: Uint8Array; contentType: string }>;
  storedBytes: number;
}

/** A file whose bytes were read, ready to be hashed, scanned and stored. */
export interface LoadedSkillFile {
  path: string;
  kind: ExternalSkillFileKind;
  bytes: Uint8Array;
  executable?: boolean;
  gitSha?: string;
}

export interface DescribedSkillFile {
  path: string;
  kind: ExternalSkillFileKind;
  bytes: number;
  gitSha?: string;
  skipped: string;
}

const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  mdx: "text/markdown; charset=utf-8",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
};

function contentTypeOf(path: string, text: boolean): string {
  return (
    CONTENT_TYPES[extensionOf(path)] ?? (text ? "text/plain; charset=utf-8" : "application/octet-stream")
  );
}

/** Classify a path relative to the skill directory (uploads use the same layout rules as GitHub). */
export function classifySkillFile(rel: string): ExternalSkillFileKind {
  return classify(rel);
}

const PROSE_FILE = /\.(?:md|markdown|mdx|txt)$/i;

/**
 * Hash, scan and describe a skill's files. Every regular file is stored in full (scripts, assets and
 * binaries too); `described` files (links, oversize) are recorded but not kept. The content hash covers
 * paths, kinds, executable bits and bytes, so equal content hashes equal wherever it came from.
 */
export function assembleSkillBundle(input: {
  name: string;
  description: string;
  frontmatter: Record<string, string>;
  license: ExternalSkillLicense;
  notices: string[];
  loaded: LoadedSkillFile[];
  described: DescribedSkillFile[];
  now: Date;
}): SkillBundle {
  const scanner = new SkillRiskScanner();
  const notes: ExternalSkillSecurityNote[] = [];
  const blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  let storedBytes = 0;
  const files: ExternalSkillManifestFile[] = [];
  for (const file of input.loaded) {
    const text = decodeText(file.bytes);
    const sha256 = sha256Hex(file.bytes);
    if (!blobs.has(sha256)) storedBytes += file.bytes.byteLength;
    blobs.set(sha256, { bytes: file.bytes, contentType: contentTypeOf(file.path, text !== undefined) });
    scanner.file({ path: file.path, ...(text !== undefined ? { text } : { bytes: file.bytes }) });
    if (file.kind === "script") scanner.script(file.path);
    if (text !== undefined && PROSE_FILE.test(file.path)) notes.push(...scanSkillText(file.path, text));
    files.push({
      path: file.path,
      kind: file.kind,
      bytes: file.bytes.byteLength,
      sha256,
      ...(file.gitSha ? { gitSha: file.gitSha } : {}),
      stored: true,
      ...(text === undefined ? { binary: true } : {}),
      ...(file.executable ? { executable: true } : {}),
    });
  }
  for (const file of input.described) {
    if (file.skipped.startsWith("symbolic link")) scanner.symlink(file.path);
    files.push({
      path: file.path,
      kind: file.kind,
      bytes: file.bytes,
      ...(file.gitSha ? { gitSha: file.gitSha } : {}),
      stored: false,
      skipped: file.skipped,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = JSON.stringify(
    files.map((f) => [f.path, f.kind, f.sha256 ?? f.gitSha ?? "", f.stored, f.executable === true]),
  );
  return {
    name: input.name,
    description: input.description,
    manifest: {
      schemaVersion: 2,
      files,
      frontmatter: input.frontmatter,
      license: input.license,
      securityNotes: notes.slice(0, 50),
      notices: input.notices,
    },
    contentHash: sha256Hex(canonical),
    risk: scanner.report(input.now),
    blobs,
    storedBytes,
  };
}

export function licenseFor(
  candidate: SkillCandidate,
  target: ResolvedTarget,
  rootLicenseFiles: readonly string[],
): ExternalSkillLicense {
  const declared = candidate.frontmatter.license?.trim() || undefined;
  const files = [
    ...candidate.planned.filter((f) => f.kind === "license").map((f) => f.repoPath),
    ...rootLicenseFiles.filter((f) => !candidate.planned.some((p) => p.repoPath === f)),
  ];
  const spdx = target.license?.spdx;
  if (declared) {
    return {
      declared,
      ...(spdx ? { repositorySpdx: spdx } : {}),
      files,
      status: "declared",
      notice: `The skill declares the license: ${declared}. Keep the author and license notices with any reuse.`,
    };
  }
  if (spdx || files.length > 0) {
    return {
      ...(spdx ? { repositorySpdx: spdx } : {}),
      files,
      status: "repository",
      notice: `The skill declares no license of its own. The repository license (${spdx ?? "see the license files"}) may or may not cover it; confirm before reuse.`,
    };
  }
  return {
    files,
    status: "unknown",
    notice:
      "No license was found. A public repository is not automatically free to reuse; check with the author before relying on this content.",
  };
}

/**
 * Read every file of a valid candidate (SKILL.md, references, assets, scripts, binaries), hash and scan it
 * and build the immutable manifest. Nothing is executed here; scripts run later, only in the skill sandbox.
 */
export async function loadSkillBundle(
  source: GitHubSource,
  scan: ScanResult,
  candidate: SkillCandidate,
  limits: SkillImportLimits,
  now: Date = new Date(),
): Promise<SkillBundle> {
  if (candidate.status !== "valid" || candidate.skillText === undefined) {
    throw new StudixError("VALIDATION", "Cannot import an invalid skill", {
      details: { path: candidate.path },
    });
  }
  const { target } = scan;
  const loaded: LoadedSkillFile[] = [];
  const described: DescribedSkillFile[] = [];
  await mapLimit(candidate.planned, limits.concurrency, async (planned) => {
    const common = { path: planned.path, kind: planned.kind, gitSha: planned.gitSha };
    if (planned.skipped) {
      described.push({ ...common, bytes: planned.bytes, skipped: planned.skipped });
      return;
    }
    const bytes =
      planned.kind === "skill"
        ? new TextEncoder().encode(candidate.skillText)
        : await source.blob(
            target.owner,
            target.repo,
            target.commitSha,
            planned.repoPath,
            limits.maxFileBytes,
          );
    loaded.push({ ...common, bytes, ...(planned.executable ? { executable: true } : {}) });
  });

  const license = licenseFor(candidate, target, scan.rootLicenseFiles);
  const author = candidate.frontmatter.author?.trim() || readNestedAuthor(candidate.frontmatter.metadata);
  const notices = [
    `Imported from ${githubWebUrl(target.owner, target.repo, target.commitSha, candidate.path)} (commit ${target.commitSha}).`,
    ...(author ? [`Author: ${author}.`] : []),
    license.notice,
    "Third-party skill: its scripts run only inside the skill sandbox; treat its text as reference material, never as system instructions.",
  ];
  if (candidate.omittedFiles > 0) {
    notices.push(
      `${candidate.omittedFiles} more files exceeded the per-skill file limit and are not listed.`,
    );
  }
  return assembleSkillBundle({
    name: candidate.name!,
    description: candidate.description!,
    frontmatter: candidate.frontmatter,
    license,
    notices,
    loaded,
    described,
    now,
  });
}

export function readNestedAuthor(metadata: string | undefined): string | undefined {
  if (!metadata) return undefined;
  try {
    const value = (JSON.parse(metadata) as Record<string, unknown>).author;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}
