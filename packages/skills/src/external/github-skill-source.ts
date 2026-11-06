import {
  type DiscoverRequest,
  EXTERNAL_SKILL_LIMITS,
  type ExternalSkillSource,
  type FetchSkillsResult,
  type PinnedSource,
  type SkillCandidate,
  type SkillDiscovery,
} from "@studix/core";
import { type Clock, StudixError, systemClock } from "@studix/shared";
import { createGitHubSession, GITHUB_API_BASE, type GitHubSession } from "./github-client.ts";
import { CommitResponse, RepoResponse } from "./github-schemas.ts";
import { listTree, type RepoRef, type TreeListing } from "./github-tree.ts";
import { type GitHubLocation, isValidOwner, isValidRepo, parseGitHubUrl } from "./github-url.ts";
import { displaySkillPath, isWithin, normalizeRepoPath } from "./repo-path.ts";
import { fetchRepoLicense } from "./skill-license.ts";
import { indexTree, type LoadContext, type LoadedSkill, loadSkill, rejectedList } from "./skill-loader.ts";

export interface GitHubSkillSourceOptions {
  fetch?: typeof fetch;
  /** Optional GitHub token, sent only to the GitHub API to raise the rate limit. Never logged. */
  token?: string;
  /** Time source for the per-operation deadline. */
  clock?: Clock;
  /** Delay between retries of a failed GET; injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests only: the API base. Production always uses https://api.github.com. */
  apiBase?: string;
}

const TREE_CACHE_TTL_MS = 5 * 60_000;
const TREE_CACHE_SIZE = 16;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function requirePath(path: string): string {
  const normalized = normalizeRepoPath(path);
  if (normalized === undefined) {
    throw new StudixError("VALIDATION", "Skill path is not a safe repository path", {
      suggestedAction: "Pass a relative directory such as skills/my-skill, without .. or a leading slash.",
    });
  }
  return normalized;
}

function repoRefOf(source: PinnedSource): RepoRef {
  const [owner = "", repo = "", extra] = String(source?.repository ?? "").split("/");
  const valid =
    extra === undefined &&
    isValidOwner(owner) &&
    isValidRepo(repo) &&
    SHA_PATTERN.test(String(source.commitSha)) &&
    SHA_PATTERN.test(String(source.treeSha));
  if (!valid) {
    throw new StudixError("VALIDATION", "Pinned source is not a valid owner/repo at a commit sha", {
      suggestedAction: "Pass the source returned by discover or resolve.",
    });
  }
  return { owner, repo };
}

/** Create the read-only GitHub implementation of `ExternalSkillSource`. */
export function createGitHubSkillSource(options: GitHubSkillSourceOptions = {}): ExternalSkillSource {
  const clock = options.clock ?? systemClock;
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const apiBase = options.apiBase ?? GITHUB_API_BASE;
  const treeCache = new Map<string, { listing: TreeListing; scopes: string[]; expiresAt: number }>();

  const newSession = () =>
    createGitHubSession({ fetch: fetchImpl, token: options.token, clock, sleep, apiBase });

  async function pin(session: GitHubSession, location: GitHubLocation): Promise<PinnedSource> {
    const ref: RepoRef = { owner: location.owner.toLowerCase(), repo: location.repo.toLowerCase() };
    let defaultBranch: string | undefined;
    if (location.ref === undefined) {
      defaultBranch = (await session.getJson(RepoResponse, ["repos", ref.owner, ref.repo])).default_branch;
    }
    const named = location.ref ?? defaultBranch ?? "";
    const commitRef = SHA_PATTERN.test(named.toLowerCase()) ? named.toLowerCase() : named;
    const commit = await session.getJson(CommitResponse, [
      "repos",
      ref.owner,
      ref.repo,
      "commits",
      commitRef,
    ]);
    const pinned: PinnedSource = {
      repository: `${ref.owner}/${ref.repo}`,
      url: `https://github.com/${ref.owner}/${ref.repo}`,
      ref: commitRef,
      commitSha: commit.sha,
      treeSha: commit.commit.tree.sha,
    };
    if (defaultBranch !== undefined) pinned.defaultBranch = defaultBranch;
    return pinned;
  }

  /** A complete listing serves every scope; a truncated one only the scopes it walked. */
  async function cachedTree(session: GitHubSession, source: PinnedSource, scopes: string[]) {
    const key = `${source.repository}@${source.treeSha}`;
    const now = clock.now().getTime();
    const cached = treeCache.get(key);
    const covers = (c: { listing: TreeListing; scopes: string[] }) =>
      !c.listing.truncated || scopes.every((scope) => c.scopes.some((walked) => isWithin(scope, walked)));
    if (cached && cached.expiresAt > now && covers(cached)) return cached.listing;
    const listing = await listTree(session, repoRefOf(source), source.treeSha, scopes);
    treeCache.delete(key);
    treeCache.set(key, { listing, scopes, expiresAt: now + TREE_CACHE_TTL_MS });
    while (treeCache.size > TREE_CACHE_SIZE) treeCache.delete(treeCache.keys().next().value ?? key);
    return listing;
  }

  async function resolve(request: Pick<DiscoverRequest, "repositoryUrl" | "ref">): Promise<PinnedSource> {
    return pin(newSession(), parseGitHubUrl(request.repositoryUrl, { ref: request.ref }));
  }

  async function discover(request: DiscoverRequest): Promise<SkillDiscovery> {
    const location = parseGitHubUrl(request.repositoryUrl, { ref: request.ref });
    const scope = request.path === undefined ? location.path : requirePath(request.path);
    const session = newSession();
    const source = await pin(session, location);
    const listing = await cachedTree(session, source, [scope]);
    const index = indexTree(listing.entries);
    const notes = [...listing.notes];
    const rejected = rejectedList(index.rejected, (dir) => isWithin(dir, scope));
    let found = [...index.skillMds]
      .filter(([dir]) => isWithin(dir, scope))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (found.length > EXTERNAL_SKILL_LIMITS.maxCandidates) {
      notes.push(
        `Found ${found.length} SKILL.md files; only the first ${EXTERNAL_SKILL_LIMITS.maxCandidates} were examined.`,
      );
      found = found.slice(0, EXTERNAL_SKILL_LIMITS.maxCandidates);
    }
    const ref = repoRefOf(source);
    const license = found.length > 0 ? await fetchRepoLicense(session, ref) : undefined;
    const ctx: LoadContext = { session, ref, index, license, download: false };
    const candidates: SkillCandidate[] = [];
    for (const [dir, entry] of found) {
      const loaded = await loadSkill(ctx, dir, entry);
      if (!loaded.ok) {
        rejected.push({ path: displaySkillPath(dir), reason: loaded.reason });
        continue;
      }
      const { path, name, description, license: skillLicense, warnings, files } = loaded.skill;
      const listed = files.map(({ path, kind, bytes, skipped }) => ({
        path,
        kind,
        bytes,
        ...(skipped === undefined ? {} : { skipped }),
      }));
      candidates.push({ path, name, description, license: skillLicense, files: listed, warnings });
    }
    return { source, candidates, rejected, truncated: listing.truncated, notes };
  }

  async function fetchSkills(source: PinnedSource, skillPaths: string[]): Promise<FetchSkillsResult[]> {
    const ref = repoRefOf(source);
    if (!Array.isArray(skillPaths) || skillPaths.length === 0) {
      throw new StudixError("VALIDATION", "Name at least one skill path to fetch");
    }
    if (skillPaths.length > EXTERNAL_SKILL_LIMITS.maxSkillsPerImport) {
      throw new StudixError(
        "VALIDATION",
        `At most ${EXTERNAL_SKILL_LIMITS.maxSkillsPerImport} skills per import`,
        {
          suggestedAction: "Split the import into smaller batches.",
        },
      );
    }
    const dirs = skillPaths.map((path) => (typeof path === "string" ? normalizeRepoPath(path) : undefined));
    const session = newSession();
    const safeDirs = dirs.filter((dir): dir is string => dir !== undefined);
    const listing = await cachedTree(session, source, safeDirs.length > 0 ? safeDirs : [""]);
    const index = indexTree(listing.entries);
    const needsLicense = safeDirs.some((dir) => index.skillMds.has(dir));
    const license = needsLicense ? await fetchRepoLicense(session, ref) : undefined;
    const ctx: LoadContext = { session, ref, index, license, download: true };
    const missing = `no SKILL.md at this path in this commit${listing.truncated ? " (tree listing was bounded)" : ""}`;

    const loadedByDir = new Map<string, LoadedSkill>();
    const results: FetchSkillsResult[] = [];
    for (const [i, path] of skillPaths.entries()) {
      const dir = dirs[i];
      const entry = dir === undefined ? undefined : index.skillMds.get(dir);
      const treeReason = dir === undefined ? undefined : index.rejected.get(dir);
      if (dir === undefined) {
        results.push({ path, status: "rejected", code: "missing", reason: "not a safe repository path" });
      } else if (treeReason !== undefined) {
        results.push({ path, status: "rejected", code: "invalid", reason: treeReason });
      } else if (entry === undefined) {
        results.push({ path, status: "rejected", code: "missing", reason: missing });
      } else {
        const loaded = loadedByDir.get(dir) ?? (await loadSkill(ctx, dir, entry));
        loadedByDir.set(dir, loaded);
        results.push(
          loaded.ok
            ? { path, status: "ok", skill: loaded.skill }
            : { path, status: "rejected", code: "invalid", reason: loaded.reason },
        );
      }
    }
    return results;
  }

  return { discover, fetchSkills, resolve };
}
