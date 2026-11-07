import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillSourceFile } from "./skill-upload.ts";

/** The skills bundled with Studix, one directory per skill (`packages/skills/defaults/<name>/SKILL.md`). */
export const DEFAULT_SKILLS_DIR = fileURLToPath(new URL("../../defaults", import.meta.url));

export interface DefaultSkillSource {
  /** Directory name, for error reports. */
  dir: string;
  files: SkillSourceFile[];
}

async function walk(root: string, rel: string, out: SkillSourceFile[]): Promise<void> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(root, path, out);
    else if (entry.isFile()) {
      const bytes = new Uint8Array(await readFile(join(root, path)));
      // A shebang, not the file mode, marks a script: modes differ between checkouts, the content hash must not.
      const executable = bytes[0] === 0x23 && bytes[1] === 0x21;
      out.push({ path, bytes, ...(executable ? { executable: true } : {}) });
    }
  }
}

/** Read every bundled skill directory. Symbolic links and other special files are ignored. */
export async function loadDefaultSkills(root = DEFAULT_SKILLS_DIR): Promise<DefaultSkillSource[]> {
  const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  const skills: DefaultSkillSource[] = [];
  for (const dir of dirs.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const files: SkillSourceFile[] = [];
    await walk(join(root, dir.name), "", files);
    skills.push({ dir: dir.name, files });
  }
  return skills;
}
