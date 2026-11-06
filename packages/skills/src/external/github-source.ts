import { StudixError } from "@studix/shared";
import { EXTERNAL_SKILL_LIMITS, type ExternalSkillLimits } from "./limits.ts";

export interface GitHubTreeEntry {
  path: string;
  /** Git file mode: 100644 file, 100755 executable, 120000 symlink, 160000 submodule, 040000 tree. */
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

/** A repository pinned to one immutable commit. */
export interface PinnedRepo {
  owner: string;
  repo: string;
  defaultBranch: string;
  /** SPDX id (or name) of the repository license, when GitHub reports one. */
  license?: string;
  /** Branch, tag or sha the caller asked for; absent when the default branch head was used. */
  ref?: string;
  commitSha: string;
}

export interface TreeListing {
  entries: GitHubTreeEntry[];
  /** False when GitHub truncated the listing and the bounded walk could not cover the repository. */
  complete: boolean;
}

/**
 * Read-only view of a public GitHub repository. Nothing here clones, extracts or executes anything; the
 * implementation fetches JSON metadata and individual file bytes at a pinned commit.
 */
export interface GitHubSkillSource {
  /** Repository metadata plus the commit `ref` (default branch head when omitted) currently points at. */
  pin(owner: string, repo: string, ref?: string): Promise<PinnedRepo>;
  /** Whether `ref` names a branch, tag or commit of the repository. */
  refExists(owner: string, repo: string, ref: string): Promise<boolean>;
  /** Entries of the commit's tree; `prefix` narrows the walk when GitHub truncates the full listing. */
  listTree(pinned: PinnedRepo, options?: { prefix?: string }): Promise<TreeListing>;
  /** Bytes of one file at the pinned commit. Throws VALIDATION when it exceeds `maxBytes`. */
  readFile(pinned: PinnedRepo, path: string, maxBytes: number): Promise<Uint8Array>;
}

export interface GitHubHttpSourceOptions {
  fetch?: typeof fetch;
  /** Optional token raising the API rate limit; only ever sent to the fixed GitHub hosts below. */
  token?: string;
  limits?: Partial<ExternalSkillLimits>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const API_HOST = "api.github.com";
const RAW_HOST = "raw.githubusercontent.com";
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([API_HOST, RAW_HOST]);
const HEX40 = /^[0-9a-f]{40}$/i;
/** Directories never worth walking when a huge repository has to be listed level by level. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules", "vendor", "dist", "build"]);

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

interface Response1 {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/**
 * GitHub over HTTPS, restricted to `api.github.com` and `raw.githubusercontent.com`. Redirects are never
 * followed (a redirect target could be anything), every response is size-capped while streaming, requests
 * share one wall-clock deadline, and only server errors and network failures are retried, a bounded number
 * of times. Rate limiting is reported, not waited out.
 */
export function createGitHubHttpSource(options: GitHubHttpSourceOptions = {}): GitHubSkillSource {
  const doFetch = options.fetch ?? fetch;
  const limits: ExternalSkillLimits = { ...EXTERNAL_SKILL_LIMITS, ...options.limits };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadlines = new WeakMap<object, number>();

  const deadlineFor = (key: object): number => {
    let at = deadlines.get(key);
    if (at === undefined) {
      at = now() + limits.totalTimeoutMs;
      deadlines.set(key, at);
    }
    return at;
  };

  async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    if (!res.body) return new Uint8Array();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  function tooLarge(maxBytes: number): StudixError {
    return new StudixError("VALIDATION", `Response exceeds the ${maxBytes} byte limit`, {
      details: { maxBytes },
      retryable: false,
    });
  }

  function rateLimited(res: Pick<Response1, "headers" | "status">): StudixError {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retryAfter = Number(res.headers.get("retry-after"));
    const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined;
    return new StudixError("RATE_LIMITED", "GitHub rate limit reached", {
      retryable: true,
      details: {
        ...(resetAt ? { resetAt } : {}),
        ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
      },
      suggestedAction: resetAt
        ? `Retry after ${resetAt}, or import fewer skills per call.`
        : "Retry later, or import fewer skills per call.",
    });
  }

  async function request(
    scope: object,
    host: string,
    path: string,
    init: { accept: string; maxBytes: number },
  ): Promise<Response1> {
    if (!ALLOWED_HOSTS.has(host)) {
      throw new StudixError("FORBIDDEN", "Host is not allowed", { details: { host } });
    }
    const url = `https://${host}${path}`;
    const deadline = deadlineFor(scope);
    for (let attempt = 0; ; attempt += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new StudixError("TIMEOUT", "GitHub import exceeded its time limit", { retryable: true });
      }
      try {
        const res = await doFetch(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: init.accept,
            "user-agent": "studix-skill-importer",
            "x-github-api-version": "2022-11-28",
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          signal: AbortSignal.timeout(Math.min(limits.requestTimeoutMs, remaining)),
        });
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined);
          throw new StudixError(
            "PROVIDER_ERROR",
            "GitHub redirected the request; redirects are not followed",
            {
              retryable: false,
              suggestedAction: "The repository may have moved or been renamed; use its current URL.",
            },
          );
        }
        if (res.status === 429) throw rateLimited({ headers: res.headers, status: res.status });
        if (
          res.status === 403 &&
          (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))
        ) {
          throw rateLimited({ headers: res.headers, status: res.status });
        }
        if (res.status >= 500) throw new TransientError(`GitHub answered ${res.status}`);
        if (res.status >= 400) {
          await res.body?.cancel().catch(() => undefined);
          return { status: res.status, headers: res.headers, body: new Uint8Array() };
        }
        return { status: res.status, headers: res.headers, body: await readCapped(res, init.maxBytes) };
      } catch (err) {
        const transient = err instanceof TransientError || isNetworkFailure(err);
        if (!transient || attempt >= limits.maxRetries) {
          if (err instanceof StudixError) throw err;
          throw new StudixError("PROVIDER_ERROR", "Could not reach GitHub", {
            retryable: true,
            details: { reason: err instanceof Error ? err.name : "unknown" },
          });
        }
        await sleep(Math.min(250 * 2 ** attempt, 2000));
      }
    }
  }

  const api = async (scope: object, path: string, accept = "application/vnd.github+json") =>
    request(scope, API_HOST, path, { accept, maxBytes: limits.maxApiBytes });

  const json = <T>(res: Response1): T => {
    try {
      return JSON.parse(new TextDecoder().decode(res.body)) as T;
    } catch {
      throw new StudixError("PROVIDER_ERROR", "GitHub returned an unreadable response", { retryable: true });
    }
  };

  function notFound(owner: string, repo: string): StudixError {
    return new StudixError("NOT_FOUND", `Repository ${owner}/${repo} was not found or is not public`, {
      suggestedAction: "Check the URL. Only public GitHub repositories can be imported.",
    });
  }

  /** One scope object per pin/list/read call chain keeps the deadline per top-level operation. */
  const scopeOf = new WeakMap<object, object>();
  const scopeFor = (token: object): object => {
    let s = scopeOf.get(token);
    if (!s) {
      s = {};
      scopeOf.set(token, s);
    }
    return s;
  };

  async function commitSha(
    scope: object,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<string | undefined> {
    const res = await api(
      scope,
      `/repos/${owner}/${repo}/commits/${encodePath(ref)}`,
      "application/vnd.github.sha",
    );
    if (res.status === 404 || res.status === 422) return undefined;
    if (res.status !== 200)
      throw new StudixError("PROVIDER_ERROR", `GitHub answered ${res.status}`, { retryable: true });
    const sha = new TextDecoder().decode(res.body).trim();
    return HEX40.test(sha) ? sha.toLowerCase() : undefined;
  }

  return {
    async pin(owner, repo, ref) {
      const scope = {};
      const meta = await api(scope, `/repos/${owner}/${repo}`);
      if (meta.status === 404 || meta.status === 451) throw notFound(owner, repo);
      if (meta.status !== 200) {
        throw new StudixError("PROVIDER_ERROR", `GitHub answered ${meta.status}`, {
          retryable: meta.status >= 500,
        });
      }
      const info = json<{
        full_name?: string;
        private?: boolean;
        default_branch?: string;
        license?: { spdx_id?: string | null; name?: string | null } | null;
      }>(meta);
      if (info.private !== false) throw notFound(owner, repo);
      const [canonicalOwner, canonicalRepo] = (info.full_name ?? `${owner}/${repo}`).split("/");
      const defaultBranch = info.default_branch ?? "main";
      const sha = await commitSha(scope, owner, repo, ref ?? defaultBranch);
      if (!sha) {
        throw new StudixError("NOT_FOUND", `Ref ${ref ?? defaultBranch} was not found in ${owner}/${repo}`, {
          suggestedAction: "Check the branch, tag or commit.",
        });
      }
      const spdx = info.license?.spdx_id;
      const license = spdx && spdx !== "NOASSERTION" ? spdx : (info.license?.name ?? undefined);
      return {
        owner: canonicalOwner ?? owner,
        repo: canonicalRepo ?? repo,
        defaultBranch,
        ...(license ? { license } : {}),
        ...(ref ? { ref } : {}),
        commitSha: sha,
      };
    },

    async refExists(owner, repo, ref) {
      return (await commitSha({}, owner, repo, ref)) !== undefined;
    },

    async listTree(pinned, listOptions = {}) {
      const scope = scopeFor(pinned);
      const base = `/repos/${pinned.owner}/${pinned.repo}/git/trees`;
      const full = await api(scope, `${base}/${pinned.commitSha}?recursive=1`);
      if (full.status === 404) throw notFound(pinned.owner, pinned.repo);
      if (full.status !== 200) {
        throw new StudixError("PROVIDER_ERROR", `GitHub answered ${full.status}`, {
          retryable: full.status >= 500,
        });
      }
      const listing = json<{ tree?: GitHubTreeEntry[]; truncated?: boolean }>(full);
      const tree = listing.tree ?? [];
      if (tree.length > limits.maxTreeEntries) {
        throw new StudixError("VALIDATION", "Repository tree is too large to scan", {
          details: { entries: tree.length },
        });
      }
      if (!listing.truncated) return { entries: tree, complete: true };

      // Truncated: walk level by level, within a request budget, narrowed to the requested prefix.
      const prefix = listOptions.prefix ?? "";
      const entries: GitHubTreeEntry[] = [];
      let requests = 0;
      let complete = true;
      const queue: Array<{ sha: string; dir: string }> = [{ sha: pinned.commitSha, dir: "" }];
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        if (requests >= limits.maxTreeRequests) {
          complete = false;
          break;
        }
        requests += 1;
        const res = await api(scope, `${base}/${next.sha}`);
        if (res.status !== 200) {
          complete = false;
          continue;
        }
        const level = json<{ tree?: GitHubTreeEntry[]; truncated?: boolean }>(res);
        if (level.truncated) complete = false;
        for (const entry of level.tree ?? []) {
          const path = next.dir === "" ? entry.path : `${next.dir}/${entry.path}`;
          entries.push({ ...entry, path });
          if (entries.length > limits.maxTreeEntries) {
            throw new StudixError("VALIDATION", "Repository tree is too large to scan");
          }
          if (entry.type !== "tree" || SKIPPED_DIRS.has(entry.path)) continue;
          const relevant =
            prefix === "" ||
            path.startsWith(`${prefix}/`) ||
            prefix.startsWith(`${path}/`) ||
            path === prefix;
          if (relevant && path.split("/").length <= limits.maxPathDepth)
            queue.push({ sha: entry.sha, dir: path });
        }
      }
      return { entries, complete };
    },

    async readFile(pinned, path, maxBytes) {
      const scope = scopeFor(pinned);
      const res = await request(
        scope,
        RAW_HOST,
        `/${pinned.owner}/${pinned.repo}/${pinned.commitSha}/${encodePath(path)}`,
        { accept: "*/*", maxBytes },
      );
      if (res.status === 404) {
        throw new StudixError("NOT_FOUND", `File ${path} was not found at the pinned commit`);
      }
      if (res.status !== 200) {
        throw new StudixError("PROVIDER_ERROR", `GitHub answered ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      return res.body;
    },
  };
}

class TransientError extends Error {}

function isNetworkFailure(err: unknown): boolean {
  if (err instanceof StudixError) return false;
  const name = (err as { name?: string } | null)?.name;
  return name === "TypeError" || name === "TimeoutError" || name === "AbortError" || name === "FetchError";
}
