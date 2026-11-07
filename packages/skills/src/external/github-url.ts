import { StudixError } from "@studix/shared";

/** A public GitHub repository named by a URL, plus whatever followed `/tree/` or `/blob/`. */
export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  /** Path segments after `tree/` or `blob/`: a ref (which may contain slashes) followed by a path. */
  refAndPath?: string[];
  isBlob: boolean;
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const HEX_SHA = /^[0-9a-f]{40}$/;
const MAX_PATH_CHARS = 512;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new StudixError("VALIDATION", message, {
    ...(details ? { details } : {}),
    suggestedAction: "Use a public repository URL such as https://github.com/<owner>/<repo>.",
  });
}

/** True for a string made only of safe, non-empty path segments (no `.`, `..`, backslash or control characters). */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_CHARS) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Normalize a caller-supplied directory path; `""` is the repository root. Throws on anything unsafe. */
export function normalizeSkillPath(input: string | undefined): string {
  if (input === undefined) return "";
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed === ".") return "";
  const dir = trimmed.replace(/(^|\/)SKILL\.md$/, "");
  if (dir === "") return "";
  if (!isSafeRepoPath(dir)) invalid("Unsafe skill path", { path: input.slice(0, 200) });
  return dir;
}

export function isFullCommitSha(value: string): boolean {
  return HEX_SHA.test(value);
}

/**
 * Parse a GitHub repository URL. Only `https://github.com/<owner>/<repo>[/tree|blob/<ref>/<path>]` is
 * accepted: the host is fixed, so a caller can never aim the importer at another server. The URL is only
 * ever read for names; nothing is fetched from it.
 */
export function parseGitHubUrl(input: string): ParsedGitHubUrl {
  const text = input.trim();
  if (text.length === 0 || text.length > 2000) invalid("Repository URL is empty or too long");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid("Not a valid URL", { url: text.slice(0, 200) });
  }
  if (url.protocol !== "https:") invalid("Only https GitHub URLs are supported");
  if (url.username || url.password || url.port) invalid("The URL must not carry credentials or a port");
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    invalid("Only public github.com repositories are supported", { host });
  }
  let segments: string[];
  try {
    segments = url.pathname
      .split("/")
      .filter((s) => s !== "")
      .map(decodeURIComponent);
  } catch {
    return invalid("The URL path is not valid UTF-8 percent-encoding");
  }
  const [owner, rawRepo, kind, ...rest] = segments;
  if (!owner || !rawRepo) invalid("The URL must name an owner and a repository");
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!OWNER_PATTERN.test(owner)) invalid("Invalid GitHub owner name", { owner });
  if (!REPO_PATTERN.test(repo) || repo === "." || repo === "..")
    invalid("Invalid GitHub repository name", { repo });
  if (kind === undefined) return { owner, repo, isBlob: false };
  if (kind !== "tree" && kind !== "blob")
    invalid("Only repository, tree and blob URLs are supported", { kind });
  if (rest.length === 0) invalid("The tree URL has no ref");
  if (rest.some((s) => !isSafeRepoPath(s))) invalid("The URL path contains an unsafe segment");
  return { owner, repo, refAndPath: rest, isBlob: kind === "blob" };
}

/** Stable identity of a skill source inside one workspace. */
export function sourceKeyOf(owner: string, repo: string, path: string): string {
  return `github.com/${owner.toLowerCase()}/${repo.toLowerCase()}/${path === "" ? "." : path}`;
}

export function githubWebUrl(
  owner: string,
  repo: string,
  commitSha: string | undefined,
  path: string,
): string {
  const base = `https://github.com/${owner}/${repo}`;
  if (!commitSha) return base;
  return path === "" ? `${base}/tree/${commitSha}` : `${base}/tree/${commitSha}/${path}`;
}
