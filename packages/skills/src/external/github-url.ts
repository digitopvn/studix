import { StudixError } from "@studix/shared";

/** A validated `https://github.com/<owner>/<repo>[...]` URL. */
export interface ParsedGithubRepositoryUrl {
  owner: string;
  repo: string;
  /** `owner/repo`, lower-cased. */
  repository: string;
  /**
   * Decoded segments after `/tree/` (or `/blob/`, without the trailing `SKILL.md`). They hold
   * `<ref>/<path>`, which is ambiguous when the ref itself contains slashes.
   */
  refPath?: string[];
}

const MAX_URL_LENGTH = 2048;
const MAX_SEGMENT_LENGTH = 255;
const MAX_REF_LENGTH = 255;
const URL_PREFIX = "https://github.com/";
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SHA_RE = /^[0-9a-f]{40}$/;

function invalid(message: string): StudixError {
  return new StudixError("VALIDATION", message, {
    suggestedAction: "Use a public repository URL like https://github.com/<owner>/<repo>/tree/<ref>/<path>",
  });
}

/**
 * Parse a public GitHub repository URL. Only the exact `https://github.com/` origin is accepted (no
 * other hosts, ports, user info, query strings or IP literals), and traversal is checked on the raw
 * path before any URL normalisation could hide it.
 */
export function parseGithubRepositoryUrl(input: string): ParsedGithubRepositoryUrl {
  if (typeof input !== "string") throw invalid("Repository URL must be a string");
  const raw = input.trim();
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) throw invalid("Repository URL is empty or too long");
  if (CONTROL_RE.test(raw) || raw.includes("\\") || /\s/.test(raw)) {
    throw invalid("Repository URL contains forbidden characters");
  }
  if (raw.slice(0, URL_PREFIX.length).toLowerCase() !== URL_PREFIX) {
    throw invalid("Only https://github.com/<owner>/<repo> URLs are accepted");
  }
  let rest = raw.slice(URL_PREFIX.length);
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  if (rest.includes("?")) throw invalid("Repository URL must not contain a query string");

  // Defence in depth: the WHATWG parser must agree on the origin.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid("Repository URL is not a valid URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw invalid("Only https://github.com/<owner>/<repo> URLs are accepted");
  }

  const rawSegments = rest.split("/");
  if (rawSegments.length > 1 && rawSegments.at(-1) === "") rawSegments.pop();
  const segments = rawSegments.map(decodeSegment);
  const [owner, repoSegment, mode, ...tail] = segments;
  if (owner === undefined || repoSegment === undefined) {
    throw invalid("Repository URL must name an owner and a repository");
  }
  const repo = repoSegment.endsWith(".git") ? repoSegment.slice(0, -4) : repoSegment;
  if (!OWNER_RE.test(owner)) {
    throw invalid("Repository owner is not a valid GitHub name");
  }
  if (!REPO_RE.test(repo) || repo === "." || repo === "..") {
    throw invalid("Repository name is not a valid GitHub name");
  }
  const result: ParsedGithubRepositoryUrl = {
    owner,
    repo,
    repository: `${owner}/${repo}`.toLowerCase(),
  };
  if (mode === undefined) return result;
  if (mode !== "tree" && mode !== "blob") {
    throw invalid("Only repository, /tree/ and /blob/ URLs are accepted");
  }
  if (repoSegment !== repo) throw invalid("A .git suffix is only accepted on a bare repository URL");
  if (tail.length === 0) throw invalid("A /tree/ or /blob/ URL must name a ref");
  if (mode === "blob") {
    if (tail.at(-1) !== "SKILL.md" || tail.length < 2) {
      throw invalid("A /blob/ URL must point at a SKILL.md file");
    }
    tail.pop();
  }
  result.refPath = tail;
  return result;
}

function decodeSegment(segment: string): string {
  if (segment.length === 0) throw invalid("Repository URL contains an empty path segment");
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw invalid("Repository URL contains invalid percent-encoding");
  }
  if (
    decoded === "." ||
    decoded === ".." ||
    decoded.length === 0 ||
    decoded.length > MAX_SEGMENT_LENGTH ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    CONTROL_RE.test(decoded)
  ) {
    throw invalid("Repository URL contains a forbidden path segment");
  }
  return decoded;
}

/** Validate an `owner/repo` name as returned by discovery; returns its parts. */
export function parseRepositoryName(repository: string): { owner: string; repo: string; repository: string } {
  const parts = typeof repository === "string" ? repository.split("/") : [];
  const [owner, repo] = parts;
  if (
    parts.length !== 2 ||
    owner === undefined ||
    repo === undefined ||
    !OWNER_RE.test(owner) ||
    !REPO_RE.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    throw new StudixError("VALIDATION", "Repository must be `owner/repo`");
  }
  return { owner, repo, repository: `${owner}/${repo}`.toLowerCase() };
}

/** Validate a branch, tag or commit name (a conservative subset of git's ref-name rules). */
export function validateGitRef(ref: string): string {
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > MAX_REF_LENGTH ||
    CONTROL_RE.test(ref) ||
    /[\s~^:?*[\\]/.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.startsWith("/") ||
    ref.startsWith("-") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock")
  ) {
    throw new StudixError("VALIDATION", "Ref is not a valid branch, tag or commit name");
  }
  return ref;
}

/** Whether a string is a full, lower-case 40-hex git object id. */
export function isGitSha(value: unknown): value is string {
  return typeof value === "string" && SHA_RE.test(value);
}

/**
 * Normalise a repository-relative path: `/`-separated, no leading/trailing slash, no empty, `.` or
 * `..` segment, no backslash, control character or NUL, at most `maxLength` characters. Returns
 * undefined when the path is unsafe. The empty string (repository root) is valid.
 */
export function normaliseRelativePath(path: string, maxLength: number): string | undefined {
  if (typeof path !== "string") return undefined;
  if (path.length > maxLength) return undefined;
  if (path.includes("\\") || CONTROL_RE.test(path) || path.startsWith("/")) return undefined;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "") return "";
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return undefined;
  }
  return trimmed;
}
