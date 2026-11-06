import { createHash } from "node:crypto";

/** A file in a fake repository: text/bytes, a symlink (target path) or a submodule. */
export type FakeFile = string | Uint8Array | { symlink: string } | { submodule: true };

export interface FakeRepo {
  owner: string;
  repo: string;
  defaultBranch?: string;
  /** Extra branch/tag names that resolve to the single commit of the repository. */
  refs?: string[];
  files: Record<string, FakeFile>;
  license?: { spdxId: string | null; name: string; text: string };
  /** Make the recursive tree listing report `truncated: true` with only the top-level entries. */
  truncatedTree?: boolean;
}

export interface FakeCall {
  url: URL;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
}

/** Return a response (or throw) to override the fake for one call; `undefined` falls through. */
export type FakeIntercept = (call: FakeCall) => Response | Promise<Response> | undefined;

interface TreeNode {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

const encoder = new TextEncoder();
const sha1 = (data: Uint8Array | string) => createHash("sha1").update(data).digest("hex");

export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function base64Lines(bytes: Uint8Array): string {
  return (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,60}/g) ?? []
  ).join("\n");
}

function buildRepo(spec: FakeRepo) {
  const blobs = new Map<string, Uint8Array>();
  const dirs = new Map<string, TreeNode[]>([["", []]]);
  const treeShas = new Map<string, string>([["", sha1(`tree:${spec.owner}/${spec.repo}:`)]]);
  const ensureDir = (dir: string): string => {
    const known = treeShas.get(dir);
    if (known) return known;
    const sha = sha1(`tree:${spec.owner}/${spec.repo}:${dir}`);
    treeShas.set(dir, sha);
    dirs.set(dir, []);
    const slash = dir.lastIndexOf("/");
    const parent = slash === -1 ? "" : dir.slice(0, slash);
    ensureDir(parent);
    dirs.get(parent)?.push({ path: dir.slice(slash + 1), mode: "040000", type: "tree", sha });
    return sha;
  };
  for (const [path, file] of Object.entries(spec.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    ensureDir(dir);
    const name = path.slice(slash + 1);
    if (typeof file === "object" && "submodule" in file) {
      dirs.get(dir)?.push({ path: name, mode: "160000", type: "commit", sha: sha1(`submodule:${path}`) });
      continue;
    }
    const bytes =
      typeof file === "string"
        ? encoder.encode(file)
        : file instanceof Uint8Array
          ? file
          : encoder.encode(file.symlink);
    const sha = gitBlobSha(bytes);
    blobs.set(sha, bytes);
    const mode = typeof file === "object" && "symlink" in file ? "120000" : "100644";
    dirs.get(dir)?.push({ path: name, mode, type: "blob", sha, size: bytes.length });
  }
  const shaToDir = new Map([...treeShas].map(([dir, sha]) => [sha, dir]));
  const recursive = (dir: string): TreeNode[] =>
    (dirs.get(dir) ?? []).flatMap((node) => {
      const full = dir === "" ? node.path : `${dir}/${node.path}`;
      return [{ ...node, path: full }, ...(node.type === "tree" ? recursive(full) : [])];
    });
  return {
    spec,
    blobs,
    dirs,
    shaToDir,
    rootTreeSha: treeShas.get("") ?? "",
    commitSha: sha1(`commit:${spec.owner}/${spec.repo}`),
    recursive,
  };
}

/**
 * In-memory GitHub REST API for tests: serves repos, commits, recursive and per-directory trees, blobs
 * and the license endpoint. Every call is recorded so tests can assert hosts, headers and which blobs
 * were requested.
 */
export function createFakeGitHub(specs: FakeRepo[], intercept?: FakeIntercept) {
  const repos = new Map(specs.map((spec) => [`${spec.owner}/${spec.repo}`.toLowerCase(), buildRepo(spec)]));
  const calls: FakeCall[] = [];

  function serve(url: URL): Response {
    if (url.host !== "api.github.com") throw new TypeError(`fake GitHub: unexpected host ${url.host}`);
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    const [root, owner = "", name = "", section, ...rest] = parts;
    const repo = repos.get(`${owner}/${name}`.toLowerCase());
    if (root !== "repos" || !repo) return json({ message: "Not Found" }, 404);
    const { spec } = repo;
    const branch = spec.defaultBranch ?? "main";
    if (section === undefined) return json({ default_branch: branch });
    if (section === "commits") {
      const ref = rest.join("/");
      const known = [branch, ...(spec.refs ?? []), repo.commitSha].includes(ref);
      if (!known) return json({ message: "No commit found for SHA" }, 422);
      return json({ sha: repo.commitSha, commit: { tree: { sha: repo.rootTreeSha } } });
    }
    if (section === "license") {
      if (!spec.license) return json({ message: "Not Found" }, 404);
      const bytes = encoder.encode(spec.license.text);
      return json({
        sha: gitBlobSha(bytes),
        size: bytes.length,
        encoding: "base64",
        content: base64Lines(bytes),
        license: { spdx_id: spec.license.spdxId, name: spec.license.name },
      });
    }
    if (section === "git" && rest[0] === "trees") {
      const dir = repo.shaToDir.get(rest[1] ?? "");
      if (dir === undefined) return json({ message: "Not Found" }, 404);
      if (url.searchParams.get("recursive") !== "1")
        return json({ tree: repo.dirs.get(dir), truncated: false });
      if (spec.truncatedTree) return json({ tree: repo.dirs.get(dir), truncated: true });
      return json({ tree: repo.recursive(dir), truncated: false });
    }
    if (section === "git" && rest[0] === "blobs") {
      const bytes = repo.blobs.get(rest[1] ?? "");
      if (!bytes) return json({ message: "Not Found" }, 404);
      return json({ sha: rest[1], size: bytes.length, encoding: "base64", content: base64Lines(bytes) });
    }
    return json({ message: "Not Found" }, 404);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: FakeCall = { url, headers, redirect: init?.redirect };
    calls.push(call);
    return (await intercept?.(call)) ?? serve(url);
  };

  return {
    fetch,
    calls,
    /** Blob shas requested so far. */
    blobRequests: () =>
      calls.filter((c) => c.url.pathname.includes("/git/blobs/")).map((c) => c.url.pathname),
    blobSha: (owner: string, repo: string, path: string): string => {
      const file = specs.find((s) => s.owner === owner && s.repo === repo)?.files[path];
      if (typeof file === "string") return gitBlobSha(encoder.encode(file));
      if (file instanceof Uint8Array) return gitBlobSha(file);
      throw new Error(`fake GitHub: no regular file ${path}`);
    },
    commitSha: (owner: string, repo: string) => repos.get(`${owner}/${repo}`.toLowerCase())?.commitSha ?? "",
    rootTreeSha: (owner: string, repo: string) =>
      repos.get(`${owner}/${repo}`.toLowerCase())?.rootTreeSha ?? "",
  };
}

export type FakeGitHub = ReturnType<typeof createFakeGitHub>;

/** A minimal valid SKILL.md with optional extra frontmatter lines and body. */
export function skillMd(
  name: string,
  description = `${name} does a thing`,
  extra = "",
  body = "Body.",
): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
}
