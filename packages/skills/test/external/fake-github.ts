import { createHash } from "node:crypto";

/** A file in a fake commit: content, or a symlink / submodule entry. */
export type FakeEntry =
  | string
  | Uint8Array
  | { content: string | Uint8Array; size?: number; sha?: string }
  | { symlink: string }
  | { submodule: true };

export interface FakeRepo {
  owner: string;
  repo: string;
  defaultBranch?: string;
  private?: boolean;
  /** No commits at all (GitHub answers 409). */
  empty?: boolean;
  refs: Record<string, string>;
  commits: Record<string, { files: Record<string, FakeEntry>; truncated?: boolean; extra?: RawEntry[] }>;
}

interface RawEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

export type Interceptor = (url: URL, init: RequestInit | undefined, call: number) => Response | undefined;

const encoder = new TextEncoder();

export function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function blobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export function commitSha(label: string): string {
  return sha1(`commit:${label}`);
}

/** In-memory GitHub REST API served through an injected `fetch`. Records every requested URL. */
export class FakeGithub {
  readonly calls: string[] = [];
  readonly inits: (RequestInit | undefined)[] = [];
  interceptor?: Interceptor;
  private readonly repos = new Map<string, FakeRepo>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly trees = new Map<string, { repo: string; commit: string; dir: string }>();

  constructor(...repos: FakeRepo[]) {
    for (const repo of repos) this.add(repo);
  }

  add(repo: FakeRepo): void {
    this.repos.set(`${repo.owner}/${repo.repo}`.toLowerCase(), repo);
    for (const [sha, commit] of Object.entries(repo.commits)) {
      this.trees.set(sha, { repo: `${repo.owner}/${repo.repo}`.toLowerCase(), commit: sha, dir: "" });
      for (const dir of directories(Object.keys(commit.files))) {
        this.trees.set(dirSha(sha, dir), {
          repo: `${repo.owner}/${repo.repo}`.toLowerCase(),
          commit: sha,
          dir,
        });
      }
      for (const entry of Object.values(commit.files)) {
        const bytes = entryBytes(entry);
        if (bytes) this.blobs.set(blobSha(bytes), bytes);
      }
    }
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    this.calls.push(url.href);
    this.inits.push(init);
    const intercepted = this.interceptor?.(url, init, this.calls.length);
    if (intercepted) return intercepted;
    if (url.origin !== "https://api.github.com") return new Response("wrong host", { status: 599 });
    return this.route(url);
  };

  private route(url: URL): Response {
    const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return json({ message: "Not Found" }, 404);
    const repo = this.repos.get(
      `${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`.toLowerCase(),
    );
    if (!repo) return json({ message: "Not Found" }, 404);
    const rest = match[3];
    if (rest === undefined) {
      return json({ default_branch: repo.defaultBranch ?? "main", private: repo.private ?? false });
    }
    if (rest.startsWith("commits/")) {
      if (repo.empty) return json({ message: "Git Repository is empty." }, 409);
      const ref = rest.slice("commits/".length).split("/").map(decodeURIComponent).join("/");
      const sha = repo.refs[ref] ?? (repo.commits[ref] ? ref : undefined);
      return sha
        ? new Response(sha, { status: 200 })
        : json({ message: `No commit found for SHA: ${ref}` }, 422);
    }
    if (rest.startsWith("git/trees/")) {
      const tree = this.trees.get(rest.slice("git/trees/".length));
      const commit = tree ? repo.commits[tree.commit] : undefined;
      if (!tree || !commit) return json({ message: "Not Found" }, 404);
      return json(listTree(tree.commit, commit, tree.dir, url.searchParams.get("recursive") === "1"));
    }
    if (rest.startsWith("git/blobs/")) {
      const bytes = this.blobs.get(rest.slice("git/blobs/".length));
      return bytes
        ? new Response(new Uint8Array(bytes), { status: 200 })
        : json({ message: "Not Found" }, 404);
    }
    return json({ message: "Not Found" }, 404);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function entryBytes(entry: FakeEntry): Uint8Array | undefined {
  if (typeof entry === "string") return encoder.encode(entry);
  if (entry instanceof Uint8Array) return entry;
  if ("content" in entry)
    return typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
  if ("symlink" in entry) return encoder.encode(entry.symlink);
  return undefined;
}

function dirSha(commit: string, dir: string): string {
  return sha1(`tree:${commit}:${dir}`);
}

function directories(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
  }
  return [...dirs].sort();
}

function listTree(
  sha: string,
  commit: { files: Record<string, FakeEntry>; truncated?: boolean; extra?: RawEntry[] },
  dir: string,
  recursive: boolean,
): { sha: string; tree: RawEntry[]; truncated: boolean } {
  const prefix = dir === "" ? "" : `${dir}/`;
  const entries: RawEntry[] = [];
  for (const sub of directories(Object.keys(commit.files))) {
    if (!sub.startsWith(prefix)) continue;
    const relative = sub.slice(prefix.length);
    if (!recursive && relative.includes("/")) continue;
    entries.push({ path: relative, mode: "040000", type: "tree", sha: dirSha(sha, sub) });
  }
  for (const [path, entry] of Object.entries(commit.files)) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (!recursive && relative.includes("/")) continue;
    if (typeof entry === "object" && "submodule" in entry) {
      entries.push({ path: relative, mode: "160000", type: "commit", sha: sha1(`sub:${path}`) });
      continue;
    }
    const bytes = entryBytes(entry) ?? new Uint8Array();
    const isSymlink = typeof entry === "object" && "symlink" in entry;
    const override = typeof entry === "object" && "content" in entry ? entry : undefined;
    entries.push({
      path: relative,
      mode: isSymlink ? "120000" : "100644",
      type: "blob",
      sha: override?.sha ?? blobSha(bytes),
      size: override?.size ?? bytes.byteLength,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const isRootRecursive = dir === "" && recursive;
  if (isRootRecursive && commit.extra) entries.push(...commit.extra);
  if (isRootRecursive && commit.truncated) {
    return { sha, tree: entries.filter((entry) => !entry.path.includes("/")), truncated: true };
  }
  return { sha, tree: entries, truncated: false };
}

export function skillMd(name: string, description: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody text.\n`;
}
