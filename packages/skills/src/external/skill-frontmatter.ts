import { parse } from "yaml";

export interface ParsedSkillMarkdown {
  /** Frontmatter fields as plain text (nested values are JSON). */
  frontmatter: Record<string, string>;
  body: string;
}

const MAX_FRONTMATTER_CHARS = 16_000;
const MAX_FIELD_CHARS = 4_000;

export class SkillFormatError extends Error {}

/**
 * Split a SKILL.md into its YAML frontmatter and body. Throws `SkillFormatError` (a per-skill problem,
 * never a failed import) when the frontmatter is missing, malformed or not a mapping. YAML aliases are
 * refused, so a small file cannot expand into a large one.
 */
export function parseSkillMarkdown(text: string): ParsedSkillMarkdown {
  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!source.startsWith("---\n"))
    throw new SkillFormatError("SKILL.md must start with YAML frontmatter (---)");
  const end = source.indexOf("\n---", 4);
  if (end === -1) throw new SkillFormatError("SKILL.md frontmatter is not closed with ---");
  const closing = source.slice(end + 4, end + 5);
  if (closing !== "" && closing !== "\n")
    throw new SkillFormatError("SKILL.md frontmatter is not closed with ---");
  const raw = source.slice(4, end);
  if (raw.length > MAX_FRONTMATTER_CHARS) throw new SkillFormatError("SKILL.md frontmatter is too large");
  let data: unknown;
  try {
    data = parse(raw, { maxAliasCount: 0, schema: "core", uniqueKeys: true });
  } catch (err) {
    throw new SkillFormatError(
      `SKILL.md frontmatter is not valid YAML: ${(err as Error).message.split("\n")[0]}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SkillFormatError("SKILL.md frontmatter must be a mapping");
  }
  const frontmatter: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    frontmatter[key] = text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
  }
  return { frontmatter, body: source.slice(end + 5).replace(/^\n/, "") };
}

export interface SkillIdentity {
  name: string;
  description: string;
}

/** Name and description every valid skill carries. Throws `SkillFormatError` when either is unusable. */
export function skillIdentity(frontmatter: Record<string, string>): SkillIdentity {
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.replace(/\s+/g, " ").trim();
  if (!name) throw new SkillFormatError("SKILL.md frontmatter needs a name");
  if (name.length > 100) throw new SkillFormatError("Skill name is longer than 100 characters");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(name))
    throw new SkillFormatError("Skill name contains control characters");
  if (!description) throw new SkillFormatError("SKILL.md frontmatter needs a description");
  if (description.length > 4_000)
    throw new SkillFormatError("Skill description is longer than 4000 characters");
  return { name, description };
}
