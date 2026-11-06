import type {
  ExternalSkillFileKind,
  ExternalSkillLicense,
  ExternalSkillSkippedFile,
  ExternalSkillSource,
  FetchedSkillFile,
  InvalidSkillCandidate,
  SkillCandidate,
  SkillDiscoverRequest,
  SkillDiscovery,
  SkillFetchRequest,
  SkillFetchResult,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { ACCEPT_RAW, ACCEPT_SHA, GithubApiSession } from "./github-api-client.ts";
import { emptyRepository, RepoTree, reportablePath, SYMLINK_MODE, type TreeEntry } from "./github-repo-tree.ts";
import { type GithubSkillLimits, resolveGithubSkillLimits } from "./github-skill-limits.ts";
import {
  isGitSha,
  normaliseRelativePath,
  parseGithubRepositoryUrl,
  parseRepositoryName,
  validateGitRef,
} from "./github-url.ts";
import {
  describeSkillFile,
  gitBlobSha,
  isLicenseFileName,
  isUtf8Text,
  placeSkillFile,
  sha256Hex,
} from "./skill-file-policy.ts";
import { parseSkillMarkdown } from "./skill-frontmatter.ts";

export interface GithubSkillSourceOptions {
  /** HTTP client; defaults to the global `fetch`. Every call targets https://api.github.com. */
  fetch?: typeof fetch;
  limits?: Partial<GithubSkillLimits>;
  /** Optional GitHub token, sent only to api.github.com. Unauthenticated by default. */
  token?: string;
  /** Clock used for the runtime budget and rate-limit reset times. */
  now?: () => number;
}

const SKILL_FILE = "SKILL.md";
const MAX_SKIPPED_REPORTED = 200;
const MAX_REASON_CHARS = 300;

interface Context {
  session: GithubApiSession;
  limits: GithubSkillLimits;
  owner: string;
  repo: string;
}

type BlobResult = { bytes: Uint8Array } | { skip: string };

/**
 * Read-only `ExternalSkillSource` over the public GitHub REST API. It resolves refs to a pinned commit,
 * reads git trees and blobs only, and treats every skill file as untrusted data: nothing is executed,
 * installed, written to disk or interpreted.
 */
export function createGithubSkillSource(options: GithubSkillSourceOptions = {}): ExternalSkillSource {
  const limits = resolveGithubSkillLimits(options.limits);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const token = options.token?.trim() || undefined;
  if (token !== undefined && !/^[\x21-\x7e]{1,512}$/.test(token)) {
    throw new StudixError("VALIDATION", "GitHub token contains invalid characters");
  }
  const session = () => new GithubApiSession({ fetch: fetchImpl, limits, now, token });
  return {
    discover: (input) => discover(session(), limits, input),
    fetchSkills: (input) => fetchSkills(session(), limits, input),
  };
}

async function discover(
  session: GithubApiSession,
  limits: GithubSkillLimits,
  input: SkillDiscoverRequest,
): Promise<SkillDiscovery> {
  if (typeof input !== "object" || input === null) throw new StudixError("VALIDATION", "Discovery input is required");
  const url = parseGithubRepositoryUrl(input.repositoryUrl);
  const explicitRef = input.ref === undefined ? undefined : validateGitRef(input.ref);
  const explicitPath = input.path === undefined ? undefined : validatePath(input.path, limits);
  const ctx: Context = { session, limits, owner: url.owner, repo: url.repo };

  const defaultBranch = await readDefaultBranch(ctx, url.repository);
  let ref: string;
  let commitSha: string | undefined;
  let urlPath: string[] = [];
  if (explicitRef !== undefined) {
    ref = explicitRef;
    commitSha = await resolveCommit(ctx, explicitRef);
    if (url.refPath) {
      const refSegments = explicitRef.split("/");
      const matches = refSegments.every((segment, i) => url.refPath?.[i] === segment);
      urlPath = url.refPath.slice(matches ? refSegments.length : 1);
    }
  } else if (url.refPath) {
    ref = "";
    const longest = Math.min(url.refPath.length, limits.maxRefCandidates);
    for (let n = longest; n >= 1 && commitSha === undefined; n--) {
      const candidate = url.refPath.slice(0, n).join("/");
      if (!isValidRef(candidate)) continue;
      commitSha = await resolveCommit(ctx, candidate);
      if (commitSha !== undefined) {
        ref = candidate;
        urlPath = url.refPath.slice(n);
      }
    }
    if (commitSha === undefined) {
      throw new StudixError("NOT_FOUND", "Could not resolve the branch, tag or commit named in the URL", {
        suggestedAction: "Pass the ref explicitly",
      });
    }
  } else {
    ref = defaultBranch;
    commitSha = await resolveCommit(ctx, defaultBranch);
  }
  if (commitSha === undefined) {
    throw new StudixError("NOT_FOUND", `Ref "${reportablePath(ref, 100)}" was not found in ${url.repository}`, {
      suggestedAction: "Check the branch, tag or commit name",
    });
  }
  const basePath = explicitPath ?? validatePath(urlPath.join("/"), limits);

  const tree = new RepoTree(session, limits, url.owner, url.repo, commitSha);
  const listing = await tree.subtree(basePath);
  if (!listing) {
    throw new StudixError("NOT_FOUND", `Folder "${reportablePath(basePath, 100)}" does not exist at this commit`);
  }
  const partial: string[] = [];
  if (listing.truncated) partial.push("GitHub truncated the repository tree");
  if (listing.entryLimited) partial.push(`the walk stopped after ${limits.maxTreeEntries} entries`);
  if (listing.depthLimited) partial.push(`folders deeper than ${limits.maxDepth} levels were not searched`);

  const invalid: InvalidSkillCandidate[] = [];
  for (const dropped of listing.dropped) {
    if (baseName(dropped.path) === SKILL_FILE) {
      invalid.push({ path: parentPath(dropped.path), reason: clipReason(dropped.reason) });
    }
  }
  let skillFiles = listing.entries
    .filter((entry) => entry.type === "blob" && baseName(entry.path) === SKILL_FILE)
    .sort((a, b) => compareStrings(a.path, b.path));
  if (skillFiles.length > limits.maxSkillCandidates) {
    partial.push(`only the first ${limits.maxSkillCandidates} SKILL.md files were read`);
    skillFiles = skillFiles.slice(0, limits.maxSkillCandidates);
  }

  const rootEntries = await tree.rootEntries();
  const outcomes = await mapLimit(skillFiles, limits.concurrency, async (entry) => {
    const folder = parentPath(entry.path);
    if (entry.mode === SYMLINK_MODE) return { folder, reason: "SKILL.md is a symlink and was not followed" };
    const blob = await readBlob(ctx, entry, limits.maxSkillMdBytes);
    if ("skip" in blob) return { folder, reason: `SKILL.md ${blob.skip}` };
    if (!isUtf8Text(blob.bytes)) return { folder, reason: "SKILL.md is not valid UTF-8 text" };
    const parsed = parseSkillMarkdown(new TextDecoder().decode(blob.bytes));
    if (!parsed.ok) return { folder, reason: parsed.reason };
    const folderEntries = entriesBelow(listing.entries, folder);
    const summary = summariseFiles(folderEntries, limits);
    const candidate: SkillCandidate = {
      path: folder,
      name: parsed.name,
      description: parsed.description,
      license: detectLicense(parsed.license, folderEntries, rootEntries),
      metadata: parsed.metadata,
      files: summary.files,
      totalBytes: summary.totalBytes,
    };
    return { candidate };
  });

  const skills: SkillCandidate[] = [];
  for (const outcome of outcomes) {
    if ("candidate" in outcome) skills.push(outcome.candidate);
    else invalid.push({ path: outcome.folder, reason: clipReason(outcome.reason) });
  }
  invalid.sort((a, b) => compareStrings(a.path, b.path));

  const discovery: SkillDiscovery = {
    repository: url.repository,
    defaultBranch,
    ref,
    commitSha,
    skills,
    invalid,
  };
  if (partial.length > 0) discovery.partial = { reason: partial.join("; ") };
  return discovery;
}

async function fetchSkills(
  session: GithubApiSession,
  limits: GithubSkillLimits,
  input: SkillFetchRequest,
): Promise<SkillFetchResult[]> {
  if (typeof input !== "object" || input === null) throw new StudixError("VALIDATION", "Fetch input is required");
  const { owner, repo } = parseRepositoryName(input.repository);
  if (!isGitSha(input.commitSha)) {
    throw new StudixError("VALIDATION", "commitSha must be a 40-character lower-case hex commit id");
  }
  if (!Array.isArray(input.paths)) throw new StudixError("VALIDATION", "paths must be an array");
  if (input.paths.length > limits.maxSkillCandidates) {
    throw new StudixError("VALIDATION", `At most ${limits.maxSkillCandidates} skills can be fetched at once`);
  }
  if (input.paths.length === 0) return [];

  const ctx: Context = { session, limits, owner, repo };
  const tree = new RepoTree(session, limits, owner, repo, input.commitSha);
  await tree.root();
  const budget = { remaining: limits.maxImportBytes };
  const results: SkillFetchResult[] = [];
  // Sequential per skill so the import byte budget is spent deterministically in request order.
  for (const requested of input.paths) {
    results.push(await fetchOne(ctx, tree, budget, requested));
  }
  return results;
}

async function fetchOne(
  ctx: Context,
  tree: RepoTree,
  budget: { remaining: number },
  requested: unknown,
): Promise<SkillFetchResult> {
  const { limits } = ctx;
  const reportPath = reportablePath(requested);
  const folder = typeof requested === "string" ? normaliseRelativePath(requested, limits.maxPathLength) : undefined;
  const reject = (reason: string): SkillFetchResult => ({
    path: folder ?? reportPath,
    status: "rejected",
    reason: clipReason(reason),
  });
  if (folder === undefined) return reject("unsafe skill path");

  const listing = await tree.subtree(folder);
  if (!listing) return reject("skill folder not found at this commit");
  if (listing.truncated || listing.entryLimited) return reject("skill folder is too large to list completely");

  const entries = entriesBelow(listing.entries, folder);
  const skillEntry = entries.find((item) => item.relative === SKILL_FILE)?.entry;
  if (!skillEntry || skillEntry.type !== "blob") return reject("no SKILL.md in this folder");
  if (skillEntry.mode === SYMLINK_MODE) return reject("SKILL.md is a symlink and was not followed");
  if ((skillEntry.size ?? 0) > limits.maxSkillMdBytes) return reject(`SKILL.md exceeds ${limits.maxSkillMdBytes} bytes`);

  const skipped: ExternalSkillSkippedFile[] = listing.dropped
    .filter((dropped) => folder === "" || dropped.path.startsWith(`${folder}/`))
    .map((dropped) => ({ path: relativeTo(folder, dropped.path), reason: dropped.reason }));
  const selected: { entry: TreeEntry; relative: string; kind: ExternalSkillFileKind }[] = [];
  for (const { entry, relative } of entries) {
    if (relative === SKILL_FILE || entry.type === "tree") continue;
    if (entry.type === "commit") {
      skipped.push({ path: relative, reason: "git submodule; not followed" });
      continue;
    }
    if (entry.mode === SYMLINK_MODE) {
      skipped.push({ path: relative, reason: "symlink; not followed" });
      continue;
    }
    const placement = placeSkillFile(relative);
    if ("skip" in placement) {
      skipped.push({ path: relative, reason: placement.skip });
      continue;
    }
    if (entry.size === undefined || entry.size > limits.maxFileBytes) {
      skipped.push({ path: relative, reason: `file exceeds ${limits.maxFileBytes} bytes` });
      continue;
    }
    selected.push({ entry, relative, kind: placement.kind });
  }
  if (selected.length > limits.maxFilesPerSkill) {
    return reject(`skill has ${selected.length} files; the limit is ${limits.maxFilesPerSkill}`);
  }
  const plannedBytes = selected.reduce((sum, item) => sum + (item.entry.size ?? 0), skillEntry.size ?? 0);
  if (plannedBytes > limits.maxSkillBytes) {
    return reject(`skill is ${plannedBytes} bytes; the limit is ${limits.maxSkillBytes}`);
  }
  if (plannedBytes > budget.remaining) return reject(`import byte budget of ${limits.maxImportBytes} bytes exhausted`);
  budget.remaining -= plannedBytes;

  const skillBlob = await readBlob(ctx, skillEntry, limits.maxSkillMdBytes);
  if ("skip" in skillBlob) return reject(`SKILL.md ${skillBlob.skip}`);
  if (!isUtf8Text(skillBlob.bytes)) return reject("SKILL.md is not valid UTF-8 text");
  const parsed = parseSkillMarkdown(new TextDecoder().decode(skillBlob.bytes));
  if (!parsed.ok) return reject(parsed.reason);

  const files: FetchedSkillFile[] = [
    {
      path: SKILL_FILE,
      kind: "skill",
      contentType: "text/markdown",
      bytes: skillBlob.bytes,
      size: skillBlob.bytes.byteLength,
      sha256: sha256Hex(skillBlob.bytes),
      text: true,
    },
  ];
  const downloaded = await mapLimit(selected, limits.concurrency, async (item) => ({
    item,
    blob: await readBlob(ctx, item.entry, limits.maxFileBytes),
  }));
  for (const { item, blob } of downloaded) {
    if ("skip" in blob) {
      skipped.push({ path: item.relative, reason: blob.skip });
      continue;
    }
    const content = describeSkillFile(item.relative, blob.bytes, item.kind);
    if ("skip" in content) {
      skipped.push({ path: item.relative, reason: content.skip });
      continue;
    }
    const file: FetchedSkillFile = {
      path: item.relative,
      kind: item.kind,
      contentType: content.contentType,
      size: blob.bytes.byteLength,
      sha256: sha256Hex(blob.bytes),
      text: content.text,
    };
    // Scripts are listed for transparency only; their bytes are never handed on.
    if (item.kind !== "script") file.bytes = blob.bytes;
    files.push(file);
  }

  const rootEntries = await tree.rootEntries();
  return {
    path: folder,
    status: "ok",
    name: parsed.name,
    description: parsed.description,
    license: detectLicense(parsed.license, entries, rootEntries),
    metadata: parsed.metadata,
    files,
    skipped: capSkipped(skipped.sort((a, b) => compareStrings(a.path, b.path))),
  };
}

async function readDefaultBranch(ctx: Context, repository: string): Promise<string> {
  const { status, data } = await ctx.session.json(`/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}`, {
    maxBytes: 1024 * 1024,
    pass: [404],
  });
  const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
  if (status === 404 || record?.private === true) {
    throw new StudixError("NOT_FOUND", `Repository ${repository} was not found on GitHub or is private`, {
      suggestedAction: "Check the URL; only public repositories can be imported",
    });
  }
  const branch = record?.default_branch;
  if (typeof branch !== "string" || !isValidRef(branch)) {
    throw new StudixError("PROVIDER_ERROR", "GitHub did not report a usable default branch", { retryable: false });
  }
  return branch;
}

/** Resolve a ref to its commit id; undefined when GitHub does not know the ref. */
async function resolveCommit(ctx: Context, ref: string): Promise<string | undefined> {
  const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
  const response = await ctx.session.request(
    `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/commits/${encodedRef}`,
    { accept: ACCEPT_SHA, maxBytes: 256, pass: [404, 409, 422] },
  );
  if (response.status === 409) throw emptyRepository();
  if (response.status === 404 || response.status === 422) return undefined;
  const sha = response.tooLarge ? "" : new TextDecoder().decode(response.body).trim();
  if (!isGitSha(sha)) {
    throw new StudixError("PROVIDER_ERROR", "GitHub returned an invalid commit id", { retryable: false });
  }
  return sha;
}

/** Download one blob and check it against the tree: byte size and git object id must both match. */
async function readBlob(ctx: Context, entry: TreeEntry, maxBytes: number): Promise<BlobResult> {
  if (entry.size !== undefined && entry.size > maxBytes) return { skip: `exceeds ${maxBytes} bytes` };
  const response = await ctx.session.request(
    `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/git/blobs/${entry.sha}`,
    { accept: ACCEPT_RAW, maxBytes, pass: [404] },
  );
  if (response.tooLarge) return { skip: `exceeds ${maxBytes} bytes` };
  if (response.status === 404) return { skip: "content not found" };
  const bytes = response.body;
  if (entry.size !== undefined && bytes.byteLength !== entry.size) {
    return { skip: "size does not match the git tree" };
  }
  if (gitBlobSha(bytes) !== entry.sha) return { skip: "content does not match its git object id" };
  return { bytes };
}

function summariseFiles(
  entries: { entry: TreeEntry; relative: string }[],
  limits: GithubSkillLimits,
): { files: Partial<Record<ExternalSkillFileKind, number>>; totalBytes: number } {
  const files: Partial<Record<ExternalSkillFileKind, number>> = {};
  let totalBytes = 0;
  for (const { entry, relative } of entries) {
    if (entry.type !== "blob" || entry.mode === SYMLINK_MODE) continue;
    const size = entry.size ?? 0;
    if (relative === SKILL_FILE) {
      files.skill = 1;
      totalBytes += size;
      continue;
    }
    const placement = placeSkillFile(relative);
    if ("skip" in placement || size > limits.maxFileBytes) continue;
    files[placement.kind] = (files[placement.kind] ?? 0) + 1;
    if (placement.kind !== "script") totalBytes += size;
  }
  return { files, totalBytes };
}

function detectLicense(
  declared: string | undefined,
  folderEntries: { entry: TreeEntry; relative: string }[],
  rootEntries: TreeEntry[],
): ExternalSkillLicense {
  const isLicense = (entry: TreeEntry, name: string) =>
    entry.type === "blob" && entry.mode !== SYMLINK_MODE && isLicenseFileName(name);
  const inFolder = folderEntries
    .filter(({ entry, relative }) => !relative.includes("/") && isLicense(entry, relative))
    .map(({ entry }) => entry.path)
    .sort(compareStrings)[0];
  const atRoot = rootEntries
    .filter((entry) => !entry.path.includes("/") && isLicense(entry, entry.path))
    .map((entry) => entry.path)
    .sort(compareStrings)[0];
  const file = inFolder ?? atRoot;
  const license: ExternalSkillLicense = { status: declared || file ? "declared" : "unknown" };
  if (declared) license.declared = declared;
  if (file) license.file = file;
  return license;
}

function entriesBelow(entries: TreeEntry[], folder: string): { entry: TreeEntry; relative: string }[] {
  const prefix = folder === "" ? "" : `${folder}/`;
  return entries
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ entry, relative: entry.path.slice(prefix.length) }));
}

function capSkipped(skipped: ExternalSkillSkippedFile[]): ExternalSkillSkippedFile[] {
  if (skipped.length <= MAX_SKIPPED_REPORTED) return skipped;
  const kept = skipped.slice(0, MAX_SKIPPED_REPORTED);
  kept.push({ path: "…", reason: `${skipped.length - MAX_SKIPPED_REPORTED} more files skipped` });
  return kept;
}

function validatePath(path: string, limits: GithubSkillLimits): string {
  const normalised = normaliseRelativePath(path, limits.maxPathLength);
  if (normalised === undefined) {
    throw new StudixError("VALIDATION", "Path must be a relative folder without `..`, backslashes or control characters");
  }
  return normalised;
}

function isValidRef(ref: string): boolean {
  try {
    validateGitRef(ref);
    return true;
  } catch {
    return false;
  }
}

function relativeTo(folder: string, path: string): string {
  return folder === "" ? path : path.slice(folder.length + 1);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function clipReason(reason: string): string {
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function mapLimit<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
