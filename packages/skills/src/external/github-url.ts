import { StudixError } from "@studix/shared";
import { normalizeRepoPath } from "./repo-path.ts";

export interface GitHubLocation {
  owner: string;
  repo: string;
  /** Ref named by the URL (`/tree/<ref>/...`) or by the caller; absent means the default branch. */
  ref?: string;
  /** Directory inside the repository, `""` for the root. */
  path: string;
}

const MAX_URL_LENGTH = 2048;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const REF_PATTERN = /^[A-Za-z0-9._+@/-]{1,255}$/;
const URL_PATTERN = /^https:\/\/([^/?#]*)([^?#]*)/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected.
const CONTROL_CHARS = /[\u0000-\u001f\u007f\\]/;
const URL_HINT = "Use a public repository URL such as https://github.com/owner/repo or .../tree/<ref>/<path>.";

function invalid(message: string): StudixError {
  return new StudixError("VALIDATION", message, { suggestedAction: URL_HINT });
}

export function isValidOwner(owner: string): boolean {
  return OWNER_PATTERN.test(owner);
}

export function isValidRepo(repo: string): boolean {
  return REPO_PATTERN.test(repo) && repo !== "." && repo !== "..";
}

/** Validate a branch, tag or sha name; throws VALIDATION for anything git would refuse or that is unsafe. */
export function validateRef(ref: string): string {
  const unsafe =
    !REF_PATTERN.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.startsWith("-") ||
    ref.endsWith(".lock");
  if (unsafe) {
    throw new StudixError("VALIDATION", "Invalid git ref", {
      suggestedAction: "Pass a branch name, tag or 40-character commit sha.",
    });
  }
  return ref;
}

function decodeSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw invalid("Repository URL contains invalid percent-encoding");
  }
  if (decoded === "" || decoded === "." || decoded === ".." || decoded.includes("/")) {
    throw invalid("Repository URL path contains an unsafe segment");
  }
  if (CONTROL_CHARS.test(decoded)) throw invalid("Repository URL contains control characters or backslashes");
  return decoded;
}

function joinPath(segments: string[]): string {
  const path = normalizeRepoPath(segments.join("/"));
  if (path === undefined) throw invalid("Repository URL path is not a safe repository path");
  return path;
}

/** Strip `explicitRef`'s segments from the start of `rest` when they match, else reject the conflict. */
function splitTreeRef(rest: string[], explicitRef: string | undefined): { ref: string; path: string[] } {
  const [first, ...tail] = rest;
  if (first === undefined) throw invalid("Repository URL names /tree/ or /blob/ without a ref");
  if (explicitRef === undefined) return { ref: first, path: tail };
  const refSegments = explicitRef.split("/");
  const matches = refSegments.every((segment, index) => rest[index] === segment);
  if (!matches) {
    throw new StudixError("VALIDATION", "The ref argument does not match the ref in the repository URL", {
      suggestedAction: "Omit ref, or pass the same ref the URL names.",
    });
  }
  return { ref: explicitRef, path: rest.slice(refSegments.length) };
}

/**
 * Parse a public GitHub repository URL. Accepts `https://github.com/owner/repo` (optionally without the
 * scheme, with `.git` or trailing slashes), `/tree/<ref>/<path>` and `/blob/<ref>/<path>/SKILL.md`.
 * A `/tree/` ref containing slashes is ambiguous: the first segment is taken as the ref unless the caller
 * passes `ref`, whose segments are then matched against the URL.
 */
export function parseGitHubUrl(input: string, options: { ref?: string } = {}): GitHubLocation {
  if (typeof input !== "string") throw invalid("Repository URL must be a string");
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) throw invalid("Repository URL is empty or too long");
  if (CONTROL_CHARS.test(trimmed)) throw invalid("Repository URL contains control characters or backslashes");
  const withScheme = /^github\.com\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
  const match = URL_PATTERN.exec(withScheme);
  if (!match) throw invalid("Only https://github.com repository URLs are supported");
  const [, authority = "", rawPath = ""] = match;
  if (authority.toLowerCase() !== "github.com") {
    throw invalid("Only github.com repository URLs are supported (no other host, port or credentials)");
  }
  const segments = rawPath.replace(/\/+$/, "").split("/").slice(1).map(decodeSegment);
  const [owner, rawRepo, kind, ...rest] = segments;
  if (owner === undefined || rawRepo === undefined) throw invalid("Repository URL must name an owner and a repo");
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!isValidOwner(owner) || !isValidRepo(repo)) throw invalid("Repository URL has an invalid owner or repo name");
  const explicitRef = options.ref === undefined ? undefined : validateRef(options.ref);
  if (kind === undefined) return { owner, repo, ref: explicitRef, path: "" };
  if (kind !== "tree" && kind !== "blob") throw invalid(`Unsupported GitHub URL section "/${kind}"`);
  if (rawRepo !== repo) throw invalid("A .git suffix is only valid on a plain repository URL");
  const split = splitTreeRef(rest, explicitRef);
  let pathSegments = split.path;
  if (kind === "blob") {
    if (pathSegments.at(-1) !== "SKILL.md") throw invalid("A /blob/ URL must point at a SKILL.md file");
    pathSegments = pathSegments.slice(0, -1);
  }
  return { owner, repo, ref: validateRef(split.ref), path: joinPath(pathSegments) };
}
