import { createHash } from "node:crypto";
import type { ExternalSkillFile, ExternalSkillFileKind, ExternalSkillSkippedFile } from "@studix/core";
import { StudixError } from "@studix/shared";
import type { GitHubSkillSource, GitHubTreeEntry, PinnedRepo } from "./github-source.ts";
import { EXTERNAL_SKILL_LIMITS, type ExternalSkillLimits } from "./limits.ts";
import { scanForRisk } from "./risk-scan.ts";
import { type ParsedSkillMd, parseSkillMd } from "./skill-frontmatter.ts";
import { dirname, isSafeRepoPath, joinPath, relativeTo } from "./skill-path.ts";

export const SKILL_FILE_NAME = "SKILL.md";

const SYMLINK_MODE = "120000";
const FOLDERS: Readonly<Record<string, ExternalSkillFileKind>> = {
  references: "reference",
  assets: "asset",
  scripts: "script",
};
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "yaml",
  "yml",
  "csv",
  "tsv",
  "toml",
  "rst",
]);
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};
const SKIPPED_PATH_SEGMENTS: ReadonlySet<string> = new Set([".git", "node_modules"]);

export interface SkillCandidate {
  /** Skill directory in the repository (`""` for the root). */
  path: string;
  valid: boolean;
  name?: string;
  description?: string;
  license?: string;
  errors: string[];
  warnings: string[];
  riskFlags: string[];
  skillMdBytes: number;
  files: { references: number; assets: number; scripts: number };
}

export interface DiscoveryResult {
  repository: { owner: string; repo: string; defaultBranch: string; license?: string };
  ref?: string;
  commitSha: string;
  /** Directory the search was narrowed to, `""` for the whole repository. */
  path: string;
  /** False when GitHub truncated the tree and the bounded walk did not cover everything. */
  treeComplete: boolean;
  candidates: SkillCandidate[];
  /** Candidates beyond the per-request bound that were not examined. */
  notExamined: number;
}

interface PlannedFile {
  entry: GitHubTreeEntry;
  /** Path below the skill directory. */
  rel: string;
  kind: ExternalSkillFileKind;
}

interface PlannedSkill {
  dir: string;
  skillMd: GitHubTreeEntry;
  files: PlannedFile[];
  skipped: ExternalSkillSkippedFile[];
  licensePath?: string;
}

/** A skill bundle downloaded as data: parsed `SKILL.md` plus the bytes of every ingestible file. */
export interface LoadedSkill {
  dir: string;
  parsed: ParsedSkillMd;
  skillMd: { path: string; bytes: Uint8Array; text: string; sha256: string };
  files: Array<{ meta: ExternalSkillFile; bytes?: Uint8Array }>;
  skipped: ExternalSkillSkippedFile[];
  riskFlags: string[];
  warnings: string[];
  errors: string[];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function underSkippedDir(path: string): boolean {
  return path.split("/").some((s) => SKIPPED_PATH_SEGMENTS.has(s));
}

/**
 * Find every skill directory (a directory holding `SKILL.md`) in a tree listing, without assuming a layout,
 * and assign each file under `references/`, `assets/` and `scripts/` to its nearest skill. Symlinks,
 * submodules and unsafe paths are never planned for download.
 */
export function planSkills(
  entries: readonly GitHubTreeEntry[],
  scope: string,
  limits: ExternalSkillLimits = EXTERNAL_SKILL_LIMITS,
): { skills: PlannedSkill[]; notExamined: number; rejected: Array<{ dir: string; reason: string }> } {
  const inScope = (path: string) => scope === "" || path === scope || path.startsWith(`${scope}/`);
  const skillFiles = entries.filter(
    (e) => e.type === "blob" && inScope(e.path) && e.path.split("/").pop() === SKILL_FILE_NAME,
  );
  const rejected: Array<{ dir: string; reason: string }> = [];
  const dirs = new Map<string, GitHubTreeEntry>();
  for (const entry of skillFiles) {
    const dir = dirname(entry.path);
    if (!isSafeRepoPath(entry.path) || underSkippedDir(entry.path)) continue;
    if (entry.mode === SYMLINK_MODE) {
      rejected.push({ dir, reason: "SKILL.md is a symbolic link" });
      continue;
    }
    dirs.set(dir, entry);
  }
  const sorted = [...dirs.keys()].sort();
  const notExamined = Math.max(0, sorted.length - limits.maxSkillsPerRepo);
  const examined = sorted.slice(0, limits.maxSkillsPerRepo);
  const allDirs = new Set(dirs.keys());

  const nearestSkillDir = (path: string): string | undefined => {
    let dir = dirname(path);
    for (;;) {
      if (allDirs.has(dir)) return dir;
      if (dir === "") return undefined;
      dir = dirname(dir);
    }
  };

  const skills = new Map<string, PlannedSkill>();
  for (const dir of examined) {
    skills.set(dir, { dir, skillMd: dirs.get(dir) as GitHubTreeEntry, files: [], skipped: [] });
  }
  for (const entry of entries) {
    if (underSkippedDir(entry.path)) continue;
    const owner = nearestSkillDir(entry.path);
    const skill = owner === undefined ? undefined : skills.get(owner);
    if (!skill) continue;
    const rel = relativeTo(skill.dir, entry.path);
    if (rel === undefined) continue;
    const first = rel.split("/")[0] ?? "";
    const kind = rel.includes("/") ? FOLDERS[first] : undefined;
    if (!rel.includes("/") && /^licen[sc]e(\.[A-Za-z]+)?$/i.test(rel) && entry.type === "blob") {
      skill.licensePath = entry.mode === SYMLINK_MODE ? undefined : entry.path;
      continue;
    }
    if (!kind || entry.type === "tree") continue;
    if (entry.type === "commit") {
      skill.skipped.push({ path: rel, reason: "git submodule is not followed" });
    } else if (entry.mode === SYMLINK_MODE) {
      skill.skipped.push({ path: rel, reason: "symbolic link is not followed" });
    } else if (!isSafeRepoPath(entry.path) || !isSafeRepoPath(rel)) {
      skill.skipped.push({ path: rel.slice(0, 200), reason: "unsafe path" });
    } else {
      skill.files.push({ entry, rel, kind });
    }
  }
  return { skills: [...skills.values()], notExamined, rejected };
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

async function mapLimited<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

/**
 * Download one planned skill as data. Only `SKILL.md` and small text files under `references/` and
 * `assets/` are fetched; scripts and binary assets are recorded as metadata and never read. Per-file,
 * per-bundle and file-count bounds apply, and anything over them is listed as skipped with the reason.
 */
export async function loadSkill(
  source: GitHubSkillSource,
  pinned: PinnedRepo,
  plan: PlannedSkill,
  limits: ExternalSkillLimits = EXTERNAL_SKILL_LIMITS,
): Promise<LoadedSkill> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const skipped = [...plan.skipped];
  const skillPath = plan.skillMd.path;

  if (plan.skillMd.size !== undefined && plan.skillMd.size > limits.maxSkillMdBytes) {
    errors.push(`SKILL.md is larger than ${limits.maxSkillMdBytes} bytes`);
  }
  let skillBytes: Uint8Array = new Uint8Array();
  if (errors.length === 0) {
    try {
      skillBytes = await source.readFile(pinned, skillPath, limits.maxSkillMdBytes);
    } catch (err) {
      if (err instanceof StudixError && err.code === "VALIDATION") {
        errors.push(`SKILL.md is larger than ${limits.maxSkillMdBytes} bytes`);
      } else throw err;
    }
  }
  const text = errors.length === 0 ? decodeUtf8(skillBytes) : "";
  if (text === undefined) errors.push("SKILL.md is not valid UTF-8 text");
  const parsed = parseSkillMd(text ?? "");
  errors.push(...(errors.length === 0 ? parsed.errors : []));
  warnings.push(...parsed.warnings);

  const files: LoadedSkill["files"] = [];
  const texts: string[] = [text ?? ""];
  if (errors.length === 0) {
    let storedBytes = skillBytes.byteLength;
    const toFetch: PlannedFile[] = [];
    const ordered = [...plan.files].sort((a, b) => a.rel.localeCompare(b.rel));
    for (const file of ordered) {
      const { entry, rel, kind } = file;
      const base = { path: rel, kind, bytes: entry.size ?? 0, gitSha: entry.sha } as const;
      if (files.length + toFetch.length >= limits.maxFilesPerSkill) {
        skipped.push({ path: rel, reason: `more than ${limits.maxFilesPerSkill} files in the bundle` });
        continue;
      }
      if (kind === "script") {
        files.push({ meta: { ...base, stored: false, reason: "scripts are never fetched or executed" } });
        continue;
      }
      const ext = extensionOf(rel);
      if (!TEXT_EXTENSIONS.has(ext)) {
        files.push({
          meta: { ...base, stored: false, reason: "not a supported text file; kept as metadata only" },
        });
        continue;
      }
      if ((entry.size ?? 0) > limits.maxFileBytes) {
        files.push({ meta: { ...base, stored: false, reason: `larger than ${limits.maxFileBytes} bytes` } });
        continue;
      }
      if (storedBytes + (entry.size ?? 0) > limits.maxBundleBytes) {
        files.push({ meta: { ...base, stored: false, reason: "bundle size limit reached" } });
        continue;
      }
      storedBytes += entry.size ?? 0;
      toFetch.push(file);
    }
    const fetched = await mapLimited(toFetch, limits.concurrency, async (file) => {
      try {
        return {
          file,
          bytes: await source.readFile(pinned, joinPath(plan.dir, file.rel), limits.maxFileBytes),
        };
      } catch (err) {
        if (err instanceof StudixError && (err.code === "VALIDATION" || err.code === "NOT_FOUND")) {
          return { file, error: err.message };
        }
        throw err;
      }
    });
    for (const item of fetched) {
      const { file } = item;
      const base = {
        path: file.rel,
        kind: file.kind,
        bytes: file.entry.size ?? 0,
        gitSha: file.entry.sha,
      } as const;
      if (!("bytes" in item) || item.bytes === undefined) {
        skipped.push({ path: file.rel, reason: item.error ?? "could not be read" });
        continue;
      }
      const decoded = decodeUtf8(item.bytes);
      if (decoded === undefined) {
        skipped.push({ path: file.rel, reason: "not valid UTF-8 text" });
        continue;
      }
      texts.push(decoded);
      const ext = extensionOf(file.rel);
      files.push({
        meta: {
          ...base,
          bytes: item.bytes.byteLength,
          sha256: sha256Hex(item.bytes),
          contentType: `${CONTENT_TYPES[ext] ?? "text/plain"}; charset=utf-8`,
          stored: true,
        },
        bytes: item.bytes,
      });
    }
    files.sort((a, b) => a.meta.path.localeCompare(b.meta.path));
  }

  return {
    dir: plan.dir,
    parsed,
    skillMd: { path: skillPath, bytes: skillBytes, text: text ?? "", sha256: sha256Hex(skillBytes) },
    files,
    skipped,
    riskFlags: scanForRisk(texts),
    warnings,
    errors,
  };
}

/** Counts of planned bundle files by kind, for the discovery listing. */
function countKinds(plan: PlannedSkill): SkillCandidate["files"] {
  const counts = { references: 0, assets: 0, scripts: 0 };
  for (const f of plan.files) counts[`${f.kind}s` as keyof typeof counts] += 1;
  return counts;
}

/**
 * Examine a repository at a pinned commit and report every skill candidate, valid or not. Only `SKILL.md`
 * is downloaded (to validate it); one broken skill never hides the others.
 */
export async function discoverSkills(
  source: GitHubSkillSource,
  pinned: PinnedRepo,
  scope: string,
  limits: ExternalSkillLimits = EXTERNAL_SKILL_LIMITS,
): Promise<{ result: DiscoveryResult; plans: PlannedSkill[] }> {
  const tree = await source.listTree(pinned, scope === "" ? {} : { prefix: scope });
  const { skills, notExamined, rejected } = planSkills(tree.entries, scope, limits);
  const loaded = await mapLimited(skills, limits.concurrency, async (plan) => {
    const bundle = await loadSkill(source, pinned, { ...plan, files: [] }, limits);
    const candidate: SkillCandidate = {
      path: plan.dir,
      valid: bundle.errors.length === 0,
      ...(bundle.parsed.name ? { name: bundle.parsed.name } : {}),
      ...(bundle.parsed.description ? { description: bundle.parsed.description } : {}),
      ...(bundle.parsed.license ? { license: bundle.parsed.license } : {}),
      errors: bundle.errors,
      warnings: bundle.warnings,
      riskFlags: bundle.riskFlags,
      skillMdBytes: bundle.skillMd.bytes.byteLength,
      files: countKinds(plan),
    };
    return candidate;
  });
  const candidates = [
    ...loaded,
    ...rejected.map<SkillCandidate>((r) => ({
      path: r.dir,
      valid: false,
      errors: [r.reason],
      warnings: [],
      riskFlags: [],
      skillMdBytes: 0,
      files: { references: 0, assets: 0, scripts: 0 },
    })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  return {
    result: {
      repository: {
        owner: pinned.owner,
        repo: pinned.repo,
        defaultBranch: pinned.defaultBranch,
        ...(pinned.license ? { license: pinned.license } : {}),
      },
      ...(pinned.ref ? { ref: pinned.ref } : {}),
      commitSha: pinned.commitSha,
      path: scope,
      treeComplete: tree.complete,
      candidates,
      notExamined,
    },
    plans: skills,
  };
}
