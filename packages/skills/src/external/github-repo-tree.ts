import { StudixError } from "@studix/shared";
import type { GithubApiSession } from "./github-api-client.ts";
import type { GithubSkillLimits } from "./github-skill-limits.ts";
import { isGitSha, normaliseRelativePath } from "./github-url.ts";

export const SYMLINK_MODE = "120000";
export const SUBMODULE_MODE = "160000";
const IGNORED_DIRS = new Set(["node_modules", ".git"]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this replaces
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

export interface TreeEntry {
  /** Repository-relative, validated path. */
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

/** An entry the walk saw but refused (unsafe path, too deep), reported instead of read. */
export interface DroppedEntry {
  path: string;
  reason: string;
}

export interface TreeListing {
  entries: TreeEntry[];
  dropped: DroppedEntry[];
  /** GitHub returned a truncated listing. */
  truncated: boolean;
  /** The entry cap stopped the walk. */
  entryLimited: boolean;
  /** Entries deeper than `maxDepth` were ignored. */
  depthLimited: boolean;
}

/** Make an untrusted path safe to echo in a report: no control characters, bounded length. */
export function reportablePath(path: unknown, maxLength = 240): string {
  const text = typeof path === "string" ? path.replace(CONTROL_RE, "?") : "?";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * Lazily read git trees of one pinned commit. The recursive listing is fetched once; when GitHub
 * truncates it, a folder is listed on its own (walking non-recursive trees to find its object id).
 */
export class RepoTree {
  private full?: Promise<TreeListing>;
  private rootLevel?: Promise<TreeEntry[]>;

  constructor(
    private readonly session: GithubApiSession,
    private readonly limits: GithubSkillLimits,
    private readonly owner: string,
    private readonly repo: string,
    private readonly commitSha: string,
  ) {}

  /** The recursive listing of the whole commit. */
  root(): Promise<TreeListing> {
    this.full ??= this.read(this.commitSha, true, "");
    return this.full;
  }

  /** Entries at the repository root (files and folders). */
  rootEntries(): Promise<TreeEntry[]> {
    this.rootLevel ??= this.root().then(async (full) =>
      full.truncated
        ? (await this.read(this.commitSha, false, "")).entries
        : full.entries.filter((entry) => !entry.path.includes("/")),
    );
    return this.rootLevel;
  }

  /** Everything below `path` (repository-relative paths), or undefined when no such folder exists. */
  async subtree(path: string): Promise<TreeListing | undefined> {
    const full = await this.root();
    if (path === "") return full;
    const folder = full.entries.find((entry) => entry.path === path && entry.type === "tree");
    if (!full.truncated) return folder ? within(full, path) : undefined;
    const sha = folder?.sha ?? (await this.locate(path));
    return sha === undefined ? undefined : this.read(sha, true, path);
  }

  private async locate(path: string): Promise<string | undefined> {
    const segments = path.split("/");
    if (segments.length > this.limits.maxDepth) return undefined;
    let sha = this.commitSha;
    let prefix = "";
    for (const segment of segments) {
      const listing = await this.read(sha, false, prefix);
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      const next = listing.entries.find((entry) => entry.path === prefix && entry.type === "tree");
      if (!next) return undefined;
      sha = next.sha;
    }
    return sha;
  }

  private async read(treeSha: string, recursive: boolean, prefix: string): Promise<TreeListing> {
    const query = recursive ? "?recursive=1" : "";
    const { status, data } = await this.session.json(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${treeSha}${query}`,
      { maxBytes: this.limits.maxResponseBytes, pass: [404, 409] },
    );
    if (status === 409) throw emptyRepository();
    if (status === 404) {
      throw new StudixError("NOT_FOUND", "Commit or folder not found in this repository", {
        suggestedAction: "Discover the repository again to pin a current commit",
      });
    }
    return this.parse(data, prefix);
  }

  private parse(data: unknown, prefix: string): TreeListing {
    const listing: TreeListing = {
      entries: [],
      dropped: [],
      truncated: false,
      entryLimited: false,
      depthLimited: false,
    };
    if (!isRecord(data) || !Array.isArray(data.tree)) {
      throw new StudixError("PROVIDER_ERROR", "GitHub returned an unexpected tree listing", {
        retryable: false,
      });
    }
    listing.truncated = data.truncated === true;
    let visited = 0;
    for (const item of data.tree) {
      if (++visited > this.limits.maxTreeEntries) {
        listing.entryLimited = true;
        break;
      }
      if (!isRecord(item)) continue;
      const rawPath =
        typeof item.path === "string" ? (prefix === "" ? item.path : `${prefix}/${item.path}`) : "";
      const path = normaliseRelativePath(rawPath, this.limits.maxPathLength);
      if (path === undefined || path === "") {
        listing.dropped.push({ path: reportablePath(rawPath), reason: "unsafe path; not read" });
        continue;
      }
      const segments = path.split("/");
      if (segments.some((segment) => IGNORED_DIRS.has(segment))) continue;
      const type = item.type;
      if ((type !== "blob" && type !== "tree" && type !== "commit") || !isGitSha(item.sha)) {
        listing.dropped.push({ path, reason: "unrecognised tree entry; not read" });
        continue;
      }
      if (segments.length > this.limits.maxDepth) {
        listing.depthLimited = true;
        if (type !== "tree")
          listing.dropped.push({ path, reason: `deeper than ${this.limits.maxDepth} folders` });
        continue;
      }
      const entry: TreeEntry = {
        path,
        mode: typeof item.mode === "string" ? item.mode : "",
        type,
        sha: item.sha,
      };
      if (typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0)
        entry.size = item.size;
      listing.entries.push(entry);
    }
    return listing;
  }
}

export function emptyRepository(): StudixError {
  return new StudixError("NOT_FOUND", "The repository has no commits yet, so it has no skills to import", {
    retryable: false,
  });
}

function within(listing: TreeListing, path: string): TreeListing {
  const prefix = `${path}/`;
  return {
    ...listing,
    entries: listing.entries.filter((entry) => entry.path.startsWith(prefix)),
    dropped: listing.dropped.filter((entry) => entry.path.startsWith(prefix)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
