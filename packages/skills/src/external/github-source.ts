import { StudixError } from "@studix/shared";
import { isFullCommitSha, isSafeRepoPath } from "./github-url.ts";
import type { SkillImportLimits } from "./import-limits.ts";

export interface GitTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  /** Git file mode: 100644 file, 100755 executable, 120000 symlink, 160000 submodule, 040000 directory. */
  mode: string;
  /** Git object id (sha1), not a content hash. */
  sha: string;
  size?: number;
}

export interface GitHubRepositoryInfo {
  defaultBranch: string;
  license?: { spdx?: string; name?: string };
}

export interface GitHubTree {
  entries: GitTreeEntry[];
  /** True when the listing could not be completed within the limits; skills may be missing. */
  truncated: boolean;
}

/**
 * Read-only view of one public GitHub repository, pinned by commit. The importer talks to GitHub only
 * through this port, so tests and other providers replace it without touching the import logic.
 */
export interface GitHubSource {
  repository(owner: string, repo: string): Promise<GitHubRepositoryInfo>;
  /** Commit sha of a branch, tag or commit; undefined when the ref does not exist. */
  commit(owner: string, repo: string, ref: string): Promise<string | undefined>;
  tree(owner: string, repo: string, commitSha: string): Promise<GitHubTree>;
  /** Bytes of one file at a commit; fails with VALIDATION when it is larger than `maxBytes`. */
  blob(owner: string, repo: string, commitSha: string, path: string, maxBytes: number): Promise<Uint8Array>;
}

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["api.github.com", "raw.githubusercontent.com"]);
const API_HOST = "api.github.com";
const MAX_JSON_BYTES = 12 * 1024 * 1024;

export interface GitHubSourceOptions {
  limits: SkillImportLimits;
  fetch?: typeof fetch;
  /** Optional token; sent to api.github.com only, to raise the rate limit. Public data either way. */
  token?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function isHex(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * GitHub over HTTPS with hard bounds. Requests only go to api.github.com and raw.githubusercontent.com on
 * the default port; a redirect elsewhere (an internal address, another host, plain http) is refused, so
 * the importer cannot be steered at private network targets. Responses are read through a byte cap.
 * Create one per operation: the total-time budget starts when it is created.
 */
export function createGitHubSource(options: GitHubSourceOptions): GitHubSource {
  const { limits } = options;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + limits.totalTimeoutMs;

  const checkUrl = (url: URL) => {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !ALLOWED_HOSTS.has(url.hostname)
    ) {
      throw new StudixError("PROVIDER_ERROR", "Refused a request outside public GitHub", {
        details: { host: url.hostname },
        retryable: false,
      });
    }
  };

  const readCapped = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new StudixError("VALIDATION", "A file is larger than the import limit", {
        details: { maxBytes },
      });
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new StudixError("VALIDATION", "A file is larger than the import limit", {
          details: { maxBytes },
        });
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  };

  const rateLimited = (headers: Headers): StudixError => {
    const reset = Number(headers.get("x-ratelimit-reset"));
    const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined;
    return new StudixError("RATE_LIMITED", "GitHub rate limit reached", {
      retryable: true,
      details: resetAt ? { resetAt } : undefined,
      suggestedAction: resetAt
        ? `Retry after ${resetAt}, or ask the operator to configure a GitHub token.`
        : "Retry later, or ask the operator to configure a GitHub token.",
    });
  };

  const request = async (startUrl: string, accept: string, maxBytes: number): Promise<HttpResult> => {
    let url = new URL(startUrl);
    let redirects = 0;
    let attempt = 0;
    for (;;) {
      checkUrl(url);
      const remaining = deadline - now();
      if (remaining <= 0) throw new StudixError("TIMEOUT", "The import ran out of time", { retryable: true });
      const headers: Record<string, string> = {
        accept,
        "user-agent": "studix-skill-import",
        "x-github-api-version": "2022-11-28",
      };
      if (options.token && url.hostname === API_HOST) headers.authorization = `Bearer ${options.token}`;
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(limits.requestTimeoutMs, remaining)),
        });
      } catch (err) {
        if (attempt++ < limits.maxRetries) {
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw new StudixError("PROVIDER_ERROR", "GitHub could not be reached", {
          retryable: true,
          details: { reason: (err as Error).name },
        });
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects++ >= limits.maxRedirects) {
          throw new StudixError("PROVIDER_ERROR", "Too many redirects from GitHub", { retryable: false });
        }
        try {
          url = new URL(location, url);
        } catch {
          throw new StudixError("PROVIDER_ERROR", "GitHub sent an invalid redirect", { retryable: false });
        }
        continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        if (attempt++ < limits.maxRetries) {
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw new StudixError("PROVIDER_ERROR", `GitHub answered ${response.status}`, { retryable: true });
      }
      if (response.status === 403 || response.status === 429) {
        const exhausted =
          response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
        await response.body?.cancel();
        if (exhausted || response.status === 429) throw rateLimited(response.headers);
        throw new StudixError("PROVIDER_ERROR", "GitHub refused the request", { retryable: false });
      }
      if (response.status === 404 || response.status === 422) {
        await response.body?.cancel();
        return { status: response.status, headers: response.headers, body: new Uint8Array() };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new StudixError("PROVIDER_ERROR", `GitHub answered ${response.status}`, { retryable: false });
      }
      return {
        status: response.status,
        headers: response.headers,
        body: await readCapped(response, maxBytes),
      };
    }
  };

  const json = async (path: string): Promise<{ status: number; data?: unknown }> => {
    const res = await request(`https://${API_HOST}${path}`, "application/vnd.github+json", MAX_JSON_BYTES);
    if (res.status !== 200) return { status: res.status };
    try {
      return { status: 200, data: JSON.parse(new TextDecoder().decode(res.body)) };
    } catch {
      throw new StudixError("PROVIDER_ERROR", "GitHub sent an unreadable response", { retryable: true });
    }
  };

  const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  const parseEntries = (value: unknown, prefix: string): GitTreeEntry[] => {
    const out: GitTreeEntry[] = [];
    for (const raw of Array.isArray(value) ? value : []) {
      const e = asRecord(raw);
      if (typeof e.path !== "string" || typeof e.sha !== "string" || typeof e.mode !== "string") continue;
      if (e.type !== "blob" && e.type !== "tree" && e.type !== "commit") continue;
      const path = prefix === "" ? e.path : `${prefix}/${e.path}`;
      // A path GitHub would never produce is dropped rather than trusted.
      if (!isSafeRepoPath(path)) continue;
      out.push({
        path,
        type: e.type,
        mode: e.mode,
        sha: e.sha,
        ...(typeof e.size === "number" ? { size: e.size } : {}),
      });
    }
    return out;
  };

  return {
    async repository(owner, repo) {
      const res = await json(repoPath(owner, repo));
      if (res.status === 404) {
        throw new StudixError("NOT_FOUND", "Repository not found or not public", {
          details: { owner, repo },
          suggestedAction: "Check the URL; only public GitHub repositories can be imported.",
        });
      }
      if (res.status !== 200) throw new StudixError("PROVIDER_ERROR", `GitHub answered ${res.status}`);
      const data = asRecord(res.data);
      if (data.private === true) {
        throw new StudixError("NOT_FOUND", "Repository not found or not public", {
          details: { owner, repo },
        });
      }
      const license = asRecord(data.license);
      const spdx =
        typeof license.spdx_id === "string" && license.spdx_id !== "NOASSERTION"
          ? license.spdx_id
          : undefined;
      return {
        defaultBranch: typeof data.default_branch === "string" ? data.default_branch : "main",
        ...(spdx || typeof license.name === "string"
          ? {
              license: {
                ...(spdx ? { spdx } : {}),
                ...(typeof license.name === "string" ? { name: license.name } : {}),
              },
            }
          : {}),
      };
    },

    async commit(owner, repo, ref) {
      if (isFullCommitSha(ref)) {
        // Confirm the commit exists in this repository; the answer carries the canonical id.
        const res = await json(`${repoPath(owner, repo)}/commits/${ref}`);
        return res.status === 200 ? ref : undefined;
      }
      const res = await json(`${repoPath(owner, repo)}/commits/${encodeURIComponent(ref)}`);
      if (res.status !== 200) return undefined;
      const sha = asRecord(res.data).sha;
      return typeof sha === "string" && isHex(sha) ? sha : undefined;
    },

    async tree(owner, repo, commitSha) {
      const base = `${repoPath(owner, repo)}/git/trees`;
      const full = await json(`${base}/${commitSha}?recursive=1`);
      if (full.status !== 200) throw new StudixError("NOT_FOUND", "The commit tree could not be read");
      const data = asRecord(full.data);
      const entries = parseEntries(data.tree, "");
      if (data.truncated !== true && entries.length <= limits.maxTreeEntries)
        return { entries, truncated: false };
      if (data.truncated !== true)
        return { entries: entries.slice(0, limits.maxTreeEntries), truncated: true };

      // The recursive listing was cut off: walk directories one request at a time, within the budget.
      const out: GitTreeEntry[] = [];
      const queue: Array<{ sha: string; prefix: string; depth: number }> = [
        { sha: commitSha, prefix: "", depth: 0 },
      ];
      let requests = 0;
      let complete = true;
      while (queue.length > 0) {
        const dir = queue.shift()!;
        if (requests >= limits.maxTreeRequests || out.length >= limits.maxTreeEntries) {
          complete = false;
          break;
        }
        requests++;
        const res = await json(`${base}/${dir.sha}`);
        if (res.status !== 200) {
          complete = false;
          continue;
        }
        const body = asRecord(res.data);
        if (body.truncated === true) complete = false;
        for (const entry of parseEntries(body.tree, dir.prefix)) {
          out.push(entry);
          if (entry.type === "tree" && dir.depth + 1 <= limits.maxDepth) {
            queue.push({ sha: entry.sha, prefix: entry.path, depth: dir.depth + 1 });
          }
        }
      }
      return { entries: out, truncated: !complete };
    },

    async blob(owner, repo, commitSha, path, maxBytes) {
      if (!isHex(commitSha) || !isSafeRepoPath(path)) {
        throw new StudixError("VALIDATION", "Unsafe file reference");
      }
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commitSha}/${encoded}`;
      const res = await request(url, "application/octet-stream", maxBytes);
      if (res.status !== 200)
        throw new StudixError("NOT_FOUND", "File not found in the repository", { details: { path } });
      return res.body;
    },
  };
}
