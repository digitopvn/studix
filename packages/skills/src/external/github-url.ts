import { StudixError } from "@studix/shared";

export interface GitHubTarget {
  owner: string;
  repo: string;
  /**
   * Path segments after `/tree/` or `/blob/`. A ref may contain slashes, so which part is the ref and which
   * the path is only known once the repository has been asked; see `resolveTreeSegments`.
   */
  treeSegments: string[];
  /** The URL pointed at a single file (`/blob/`): the skill directory is that file's directory. */
  blob: boolean;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const HOSTS = new Set(["github.com", "www.github.com"]);

function invalid(message: string, url: string): StudixError {
  return new StudixError("VALIDATION", message, {
    details: { repositoryUrl: url.slice(0, 300) },
    suggestedAction:
      "Pass a public GitHub URL such as https://github.com/<owner>/<repo> or .../tree/<ref>/<skill-dir>.",
  });
}

/**
 * Parse a public GitHub repository, directory or file URL. Only https on github.com is accepted: no other
 * host, port, credentials or scheme ever reaches the network layer, which also only talks to fixed GitHub
 * hosts, so user input cannot steer a request at an internal address.
 */
export function parseGitHubUrl(input: string): GitHubTarget {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("Not a valid URL", raw);
  }
  if (url.protocol !== "https:") throw invalid("Only https GitHub URLs are accepted", raw);
  if (!HOSTS.has(url.hostname.toLowerCase())) {
    throw invalid("Only github.com repositories are supported", raw);
  }
  if (url.username || url.password) throw invalid("URLs with credentials are not accepted", raw);
  if (url.port) throw invalid("URLs with a port are not accepted", raw);

  let segments: string[];
  try {
    segments = url.pathname
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));
  } catch {
    throw invalid("Malformed percent-encoding in the URL path", raw);
  }
  const owner = segments[0];
  const repoSegment = segments[1];
  if (!owner || !repoSegment) throw invalid("The URL must name an owner and a repository", raw);
  const repo = repoSegment.endsWith(".git") ? repoSegment.slice(0, -4) : repoSegment;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") {
    throw invalid("Invalid GitHub owner or repository name", raw);
  }

  const rest = segments.slice(2);
  if (rest.length === 0) return { owner, repo, treeSegments: [], blob: false };
  const kind = rest[0];
  if (kind !== "tree" && kind !== "blob") {
    throw invalid("Unsupported GitHub URL; use a repository, /tree/ or /blob/ URL", raw);
  }
  const treeSegments = rest.slice(1);
  if (treeSegments.length === 0) throw invalid("The /tree/ or /blob/ URL has no ref", raw);
  for (const s of treeSegments) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being rejected
    if (s === "." || s === ".." || s.includes("\\") || /[\u0000-\u001f]/.test(s)) {
      throw invalid("Unsafe path in the URL", raw);
    }
  }
  return { owner, repo, treeSegments, blob: kind === "blob" };
}

/**
 * Split `/tree/<ref>/<path>` segments into ref and path by asking `exists` whether a prefix is a ref,
 * shortest first (the common case is a one-segment branch or tag).
 */
export async function resolveTreeSegments(
  segments: readonly string[],
  exists: (ref: string) => Promise<boolean>,
): Promise<{ ref: string; path: string } | undefined> {
  for (let i = 1; i <= segments.length; i += 1) {
    const ref = segments.slice(0, i).join("/");
    if (await exists(ref)) return { ref, path: segments.slice(i).join("/") };
  }
  return undefined;
}
