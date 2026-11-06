import { createHash } from "node:crypto";
import { StudixError } from "@studix/shared";
import type {
  GitHubRepositoryInfo,
  GitHubSource,
  GitHubTree,
  GitTreeEntry,
} from "../external/github-source.ts";

export type FakeFile =
  | string
  | Uint8Array
  | { content?: string | Uint8Array; mode?: string; size?: number; type?: "blob" | "commit" };

export interface FakeRepository {
  defaultBranch?: string;
  license?: string;
  private?: boolean;
  /** Branch or tag name -> files by path. */
  refs: Record<string, Record<string, FakeFile>>;
  /** Report the tree as truncated and make `tree()` return only the root entries. */
  truncatedTree?: boolean;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function bytesOf(file: FakeFile): { bytes: Uint8Array; mode: string; type: "blob" | "commit"; size: number } {
  const obj = typeof file === "string" || file instanceof Uint8Array ? { content: file } : file;
  const raw = obj.content ?? "";
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  return { bytes, mode: obj.mode ?? "100644", type: obj.type ?? "blob", size: obj.size ?? bytes.byteLength };
}

/**
 * In-memory stand-in for public GitHub: repositories with refs, commits and trees, so import tests run
 * without a network. Commit ids derive from the files, so changing a ref's files moves it to a new commit.
 */
export function createFakeGitHub(repos: Record<string, FakeRepository>) {
  const calls = { repository: 0, commit: 0, tree: 0, blob: 0 };
  const blobPaths: string[] = [];
  const commits = new Map<string, { repo: string; files: Record<string, FakeFile> }>();

  const commitOf = (key: string, ref: string): string | undefined => {
    const files = repos[key]?.refs[ref];
    if (!files) return undefined;
    const sha = sha1(
      `${key}@${ref}:${JSON.stringify(Object.entries(files).map(([p, f]) => [p, bytesOf(f).mode, [...bytesOf(f).bytes]]))}`,
    );
    commits.set(sha, { repo: key, files });
    return sha;
  };
  const keyOf = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();
  const find = (owner: string, repo: string) => {
    const key = Object.keys(repos).find((k) => k.toLowerCase() === keyOf(owner, repo));
    if (!key || repos[key]!.private) {
      throw new StudixError("NOT_FOUND", "Repository not found or not public");
    }
    return { key, repo: repos[key]! };
  };

  const source: GitHubSource = {
    async repository(owner, repo): Promise<GitHubRepositoryInfo> {
      calls.repository++;
      const { repo: r } = find(owner, repo);
      return {
        defaultBranch: r.defaultBranch ?? "main",
        ...(r.license ? { license: { spdx: r.license } } : {}),
      };
    },
    async commit(owner, repo, ref) {
      calls.commit++;
      const { key } = find(owner, repo);
      if (/^[0-9a-f]{40}$/.test(ref)) {
        for (const name of Object.keys(repos[key]!.refs)) commitOf(key, name);
        return commits.get(ref)?.repo === key ? ref : undefined;
      }
      return commitOf(key, ref);
    },
    async tree(owner, repo, commitSha): Promise<GitHubTree> {
      calls.tree++;
      const { key, repo: r } = find(owner, repo);
      const commit = commits.get(commitSha);
      if (!commit || commit.repo !== key) throw new StudixError("NOT_FOUND", "commit not found");
      const entries: GitTreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, file] of Object.entries(commit.files)) {
        const { bytes, mode, type, size } = bytesOf(file);
        entries.push({ path, type, mode, sha: sha1(`blob:${path}:${bytes.byteLength}`), size });
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      for (const dir of dirs)
        entries.push({ path: dir, type: "tree", mode: "040000", sha: sha1(`tree:${dir}`) });
      if (r.truncatedTree) return { entries: entries.filter((e) => !e.path.includes("/")), truncated: true };
      return { entries, truncated: false };
    },
    async blob(owner, repo, commitSha, path, maxBytes) {
      calls.blob++;
      blobPaths.push(path);
      const { key } = find(owner, repo);
      const commit = commits.get(commitSha);
      const file = commit?.repo === key ? commit.files[path] : undefined;
      if (file === undefined) throw new StudixError("NOT_FOUND", "File not found in the repository");
      const { bytes } = bytesOf(file);
      if (bytes.byteLength > maxBytes)
        throw new StudixError("VALIDATION", "A file is larger than the import limit");
      return bytes;
    },
  };

  return {
    source,
    calls,
    /** Repository paths read through `blob()`, in order. */
    blobPaths,
    /** Replace the files of a ref (a new commit). */
    setFiles(repoKey: string, ref: string, files: Record<string, FakeFile>) {
      repos[repoKey]!.refs[ref] = files;
    },
    /** Remove a repository, as when its owner deletes it. */
    remove(repoKey: string) {
      delete repos[repoKey];
    },
  };
}

export type FakeGitHub = ReturnType<typeof createFakeGitHub>;

/** A well-formed SKILL.md. */
export function skillMarkdown(
  fields: { name: string; description?: string; license?: string; extra?: Record<string, string> },
  body = "# Steps\n\nFollow the steps.\n",
): string {
  const lines = [
    "---",
    `name: ${fields.name}`,
    `description: ${fields.description ?? `Use ${fields.name} when asked.`}`,
    ...(fields.license ? [`license: ${fields.license}`] : []),
    ...Object.entries(fields.extra ?? {}).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
    body,
  ];
  return lines.join("\n");
}
