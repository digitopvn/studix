import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";

/*
 * The files of the skills a tenant has enabled, as the skill store hands them to the runtime. The runtime
 * only reads them: it never decides which skills are enabled, scanned or trusted. That is the store's job.
 */

export type SkillBundleScope = "workspace" | "platform";

export interface SkillBundleFile {
  /** POSIX path relative to the skill root, e.g. `SKILL.md` or `scripts/render.mjs`. No `..`, no leading `/`. */
  path: string;
  content: Uint8Array;
  /** True for a file the skill runs directly (kept as mode 0755 in the sandbox). */
  executable?: boolean;
}

export interface SkillBundle {
  /** Skill name from the SKILL.md frontmatter; lowercase kebab-case, unique within one listing. */
  name: string;
  description: string;
  scope: SkillBundleScope;
  /** The store's version id of the files, so a mount can be told apart from an older one. */
  version: string;
  /** Every file of the skill, `SKILL.md` among them. */
  files: SkillBundleFile[];
}

/** Port the skill store implements. Returns the enabled skills (workspace and platform) for one tenant. */
export interface SkillBundleSource {
  listEnabled(ctx: TenantContext): Promise<SkillBundle[]>;
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True for a relative POSIX path that stays inside its root. */
export function isSafeSkillPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Writes the bundles under `root/<name>/...` for a sandbox mount. A workspace skill wins a name clash: it is
 * the workspace's own copy of the skill (an upload, or an agent's edit of a platform skill). Throws VALIDATION on a bad name or path rather than skipping it, so
 * a broken store entry is visible instead of a silently missing skill.
 */
export async function materializeSkillBundles(
  bundles: readonly SkillBundle[],
  root: string,
): Promise<SkillBundle[]> {
  const byName = new Map<string, SkillBundle>();
  for (const bundle of bundles) {
    if (!SKILL_NAME.test(bundle.name)) {
      throw new StudixError("VALIDATION", `Skill name "${bundle.name}" is not lowercase kebab-case`, {
        retryable: false,
      });
    }
    const existing = byName.get(bundle.name);
    if (!existing || (existing.scope === "platform" && bundle.scope === "workspace")) {
      byName.set(bundle.name, bundle);
    }
  }
  const mounted = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const stored of mounted) {
    // A zip made on Windows may name entries with "\"; inside a skill it is always a separator.
    const bundle = {
      ...stored,
      files: stored.files.map((f) => ({ ...f, path: f.path.replaceAll("\\", "/") })),
    };
    if (!bundle.files.some((f) => f.path === "SKILL.md")) {
      throw new StudixError("VALIDATION", `Skill "${bundle.name}" has no SKILL.md`, { retryable: false });
    }
    // Some zip tools store a folder as an empty file entry ("assets" next to "assets/x.png"). It names a
    // directory the other paths create, so writing it as a file would break the mount.
    const dirs = new Set(
      bundle.files.flatMap((f) =>
        f.path
          .split("/")
          .slice(0, -1)
          .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
      ),
    );
    for (const file of bundle.files) {
      if (dirs.has(file.path) && file.content.byteLength === 0) continue;
      if (!isSafeSkillPath(file.path)) {
        throw new StudixError("VALIDATION", `Skill "${bundle.name}" has an unsafe path`, {
          retryable: false,
          details: { path: file.path.slice(0, 200) },
        });
      }
      const target = join(root, bundle.name, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, { mode: file.executable ? 0o755 : 0o644 });
    }
  }
  return mounted;
}

/** First `---` block of a SKILL.md: just the `name` and `description` scalars. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (!field) continue;
    const raw = field[2]!.trim();
    const value = /^(["'])([\s\S]*)\1$/.exec(raw)?.[2] ?? raw;
    out[field[1] as "name" | "description"] = value;
  }
  return out;
}

const MAX_FILES = 2_000;

async function readTree(dir: string, base: string, files: SkillBundleFile[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // Symlinks are not followed: a skill tree must not reach outside itself.
    const info = await lstat(full);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await readTree(full, base, files);
      continue;
    }
    if (!info.isFile()) continue;
    if (files.length >= MAX_FILES) {
      throw new StudixError("VALIDATION", `Skill at ${base} has more than ${MAX_FILES} files`);
    }
    files.push({
      path: relative(base, full).split(sep).join("/"),
      content: await readFile(full),
      executable: (info.mode & 0o111) !== 0,
    });
  }
}

/** Every regular file under a skill directory, symlinks skipped. */
export async function readSkillFiles(dir: string): Promise<SkillBundleFile[]> {
  const files: SkillBundleFile[] = [];
  await readTree(dir, dir, files);
  return files;
}

/**
 * The skills whose files under `root/<name>/` differ from the bundle that was mounted there, with their new
 * files. A folder entry the mount skipped (an empty file named like a directory) is not a change.
 */
export async function changedSkillBundles(
  mounted: readonly SkillBundle[],
  root: string,
): Promise<Array<{ bundle: SkillBundle; files: SkillBundleFile[] }>> {
  const changed: Array<{ bundle: SkillBundle; files: SkillBundleFile[] }> = [];
  for (const bundle of mounted) {
    const files = await readSkillFiles(join(root, bundle.name)).catch(() => undefined);
    if (!files) continue;
    const before = new Map(
      bundle.files
        .map((f) => ({ ...f, path: f.path.replaceAll("\\", "/") }))
        .filter(
          (f, _, all) => !(f.content.byteLength === 0 && all.some((g) => g.path.startsWith(`${f.path}/`))),
        )
        .map((f) => [f.path, f.content] as const),
    );
    const same =
      files.length === before.size &&
      files.every((f) => {
        const old = before.get(f.path);
        return old !== undefined && Buffer.compare(Buffer.from(old), Buffer.from(f.content)) === 0;
      });
    if (!same) changed.push({ bundle, files });
  }
  return changed;
}

/**
 * Skills read from `<root>/<scope>/<skill>/SKILL.md` on disk, for local runs and tests. Every skill found is
 * treated as enabled; the real store decides that per tenant.
 */
export function createFilesystemSkillBundleSource(root: string): SkillBundleSource {
  return {
    async listEnabled() {
      const bundles: SkillBundle[] = [];
      for (const scope of ["platform", "workspace"] as const) {
        const scopeDir = join(root, scope);
        const entries = await readdir(scopeDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillDir = join(scopeDir, entry.name);
          const skillMd = await readFile(join(skillDir, "SKILL.md"), "utf8").catch(() => undefined);
          if (skillMd === undefined) continue;
          const meta = parseSkillFrontmatter(skillMd);
          const files: SkillBundleFile[] = [];
          await readTree(skillDir, skillDir, files);
          bundles.push({
            name: meta.name ?? entry.name,
            description: meta.description ?? "",
            scope,
            version: "local",
            files,
          });
        }
      }
      return bundles;
    },
  };
}
