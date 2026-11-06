import { EXTERNAL_SKILL_LIMITS } from "@studix/core";
import type { GitHubSession } from "./github-client.ts";
import { type TreeEntry, TreeResponse } from "./github-schemas.ts";
import { isWithin, pathDepth } from "./repo-path.ts";

export interface TreeListing {
  entries: TreeEntry[];
  truncated: boolean;
  notes: string[];
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Requests kept back for blob downloads when a truncated tree forces a directory-by-directory walk. */
const WALK_REQUEST_SHARE = 0.5;
/** Stop walking when less than this share of the time budget remains. */
const WALK_TIME_SHARE = 0.33;

function treeSegments(ref: RepoRef, sha: string): string[] {
  return ["repos", ref.owner, ref.repo, "git", "trees", sha];
}

/** A directory is worth walking when it is an ancestor of, or inside, one of the requested scopes. */
function relevant(dir: string, scopes: string[]): boolean {
  return scopes.some((scope) => isWithin(dir, scope) || isWithin(scope, dir));
}

function capEntries(entries: TreeEntry[], notes: string[]): { entries: TreeEntry[]; capped: boolean } {
  if (entries.length <= EXTERNAL_SKILL_LIMITS.maxTreeEntries) return { entries, capped: false };
  notes.push(`Only the first ${EXTERNAL_SKILL_LIMITS.maxTreeEntries} tree entries were examined.`);
  return { entries: entries.slice(0, EXTERNAL_SKILL_LIMITS.maxTreeEntries), capped: true };
}

/** Breadth-first walk of non-recursive tree listings, bounded by requests, entries, depth and time. */
async function walkTree(
  session: GitHubSession,
  ref: RepoRef,
  rootSha: string,
  scopes: string[],
): Promise<TreeListing> {
  const entries: TreeEntry[] = [];
  const queue: Array<{ sha: string; prefix: string }> = [{ sha: rootSha, prefix: "" }];
  const minRequests = EXTERNAL_SKILL_LIMITS.maxRequests * WALK_REQUEST_SHARE;
  const minTime = EXTERNAL_SKILL_LIMITS.maxRuntimeMs * WALK_TIME_SHARE;
  let stopped = false;
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const outOfBudget = session.requestsLeft() <= minRequests || session.remainingMs() <= minTime;
    if (outOfBudget || entries.length >= EXTERNAL_SKILL_LIMITS.maxTreeEntries) {
      stopped = true;
      break;
    }
    const response = await session.getJson(TreeResponse, treeSegments(ref, next.sha));
    for (const entry of response.tree) {
      const path = next.prefix === "" ? entry.path : `${next.prefix}/${entry.path}`;
      entries.push({ ...entry, path });
      const descend = entry.type === "tree" && pathDepth(path) < EXTERNAL_SKILL_LIMITS.maxPathDepth;
      if (descend && relevant(path, scopes)) queue.push({ sha: entry.sha, prefix: path });
    }
  }
  const notes = [
    "The repository tree is too large to list in one response; it was walked directory by directory.",
  ];
  if (stopped) notes.push("The walk stopped at the request, time or entry limit, so some skills may be missing.");
  return { entries: capEntries(entries, notes).entries, truncated: true, notes };
}

/** List the pinned tree, falling back to a bounded walk when GitHub truncates the recursive listing. */
export async function listTree(
  session: GitHubSession,
  ref: RepoRef,
  treeSha: string,
  scopes: string[],
): Promise<TreeListing> {
  const response = await session.getJson(TreeResponse, treeSegments(ref, treeSha), { recursive: "1" });
  if (response.truncated) return walkTree(session, ref, treeSha, scopes);
  const notes: string[] = [];
  const capped = capEntries(response.tree, notes);
  return { entries: capped.entries, truncated: capped.capped, notes };
}
