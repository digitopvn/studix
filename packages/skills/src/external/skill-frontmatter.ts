import { parseDocument } from "yaml";

export type ParsedSkillMd =
  | { ok: true; name: string; description: string; frontmatter: Record<string, unknown>; warnings: string[] }
  | { ok: false; reason: string };

const MAX_FRONTMATTER_BYTES = 32 * 1024;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_DEPTH = 8;
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected in names.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const YAML_OPTIONS = { maxAliasCount: 10, prettyErrors: false, strict: true, uniqueKeys: true } as const;

/** Copy a parsed YAML value into plain JSON-safe data, dropping prototype-polluting keys. */
function toJsonSafe(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!UNSAFE_KEYS.has(key)) out[key] = toJsonSafe(item, depth + 1);
    }
    return out;
  }
  return null;
}

function extractFrontmatter(text: string): string | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  return end === -1 ? undefined : lines.slice(1, end).join("\n");
}

function parseYamlMapping(source: string): Record<string, unknown> | string {
  try {
    const doc = parseDocument(source, YAML_OPTIONS);
    if (doc.errors.length > 0 || doc.warnings.length > 0) return "malformed YAML frontmatter";
    const value = doc.toJS({ maxAliasCount: YAML_OPTIONS.maxAliasCount });
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return "frontmatter must be a YAML mapping";
    }
    return toJsonSafe(value, 0) as Record<string, unknown>;
  } catch {
    return "malformed YAML frontmatter";
  }
}

/**
 * Parse a `SKILL.md`: YAML frontmatter between the first two `---` lines, with a required `name` and
 * `description`. A name that is not kebab-case or differs from its directory is a warning, not an error.
 */
export function parseSkillMd(text: string, dirName: string): ParsedSkillMd {
  const source = extractFrontmatter(text);
  if (source === undefined)
    return { ok: false, reason: "SKILL.md has no YAML frontmatter between --- lines" };
  if (new TextEncoder().encode(source).length > MAX_FRONTMATTER_BYTES) {
    return { ok: false, reason: `frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes` };
  }
  const frontmatter = parseYamlMapping(source);
  if (typeof frontmatter === "string") return { ok: false, reason: frontmatter };

  const { name, description } = frontmatter;
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, reason: "frontmatter name is missing or not a string" };
  }
  const trimmedName = name.trim();
  if (trimmedName.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `frontmatter name exceeds ${MAX_NAME_LENGTH} characters` };
  }
  if (CONTROL_CHARS.test(trimmedName))
    return { ok: false, reason: "frontmatter name contains control characters" };
  if (typeof description !== "string" || description.trim() === "") {
    return { ok: false, reason: "frontmatter description is missing or not a string" };
  }
  const trimmedDescription = description.trim();
  if (trimmedDescription.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, reason: `frontmatter description exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
  }

  const warnings: string[] = [];
  if (!NAME_PATTERN.test(trimmedName)) warnings.push("name-not-kebab-case");
  if (trimmedName !== dirName) warnings.push("name-differs-from-directory");
  return { ok: true, name: trimmedName, description: trimmedDescription, frontmatter, warnings };
}
