import YAML from "yaml";
import { EXTERNAL_SKILL_LIMITS } from "./limits.ts";

export interface ParsedSkillMd {
  /** Scalar frontmatter values by key (`metadata.*` flattened), bounded. */
  frontmatter: Record<string, string>;
  name?: string;
  description?: string;
  license?: string;
  errors: string[];
  warnings: string[];
}

const NAME_SPEC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_KEYS = 20;
const MAX_VALUE = 500;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const HARD_MAX_DESCRIPTION = 4000;

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return collapse(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** Split `SKILL.md` into its YAML frontmatter block and body. */
export function splitFrontmatter(text: string): { block?: string; body: string } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (!open) return { body: source };
  const afterOpen = source.slice(open[0].length);
  const close = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(afterOpen);
  if (!close) return { body: source };
  return { block: afterOpen.slice(0, close.index), body: afterOpen.slice(close.index + close[0].length) };
}

/**
 * Read name, description and license from the frontmatter of an Agent Skill. YAML aliases are capped and
 * only the core schema is used, so no tag can construct anything but plain data. Findings that make the
 * skill unusable are `errors`; deviations from the Agent Skills format are `warnings`.
 */
export function parseSkillMd(text: string): ParsedSkillMd {
  const out: ParsedSkillMd = { frontmatter: {}, errors: [], warnings: [] };
  const { block } = splitFrontmatter(text);
  if (block === undefined) {
    out.errors.push(
      "SKILL.md has no YAML frontmatter (expected a leading --- block with name and description)",
    );
    return out;
  }
  if (Buffer.byteLength(block, "utf8") > EXTERNAL_SKILL_LIMITS.maxFrontmatterBytes) {
    out.errors.push("SKILL.md frontmatter is too large");
    return out;
  }
  let data: unknown;
  try {
    data = YAML.parse(block, { schema: "core", maxAliasCount: 10, prettyErrors: false });
  } catch (err) {
    out.errors.push(`SKILL.md frontmatter is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
    return out;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    out.errors.push("SKILL.md frontmatter must be a YAML mapping");
    return out;
  }
  const record = data as Record<string, unknown>;

  const name = scalar(record.name);
  const description = scalar(record.description);
  if (!name) out.errors.push("frontmatter is missing a name");
  else if (name.length > MAX_NAME) out.errors.push(`name is longer than ${MAX_NAME} characters`);
  else {
    out.name = name;
    if (!NAME_SPEC.test(name)) out.warnings.push("name is not lowercase letters, digits and single hyphens");
  }
  if (!description) out.errors.push("frontmatter is missing a description");
  else if (description.length > HARD_MAX_DESCRIPTION) out.errors.push("description is too long");
  else {
    out.description = description;
    if (description.length > MAX_DESCRIPTION) {
      out.warnings.push(`description is longer than the ${MAX_DESCRIPTION} characters the format allows`);
    }
  }
  const license = scalar(record.license);
  if (license) out.license = license.slice(0, MAX_VALUE);

  const put = (key: string, value: unknown) => {
    if (Object.keys(out.frontmatter).length >= MAX_KEYS) return;
    const v = scalar(value);
    if (v !== undefined && key.length <= 100) out.frontmatter[key] = v.slice(0, MAX_VALUE);
  };
  for (const [key, value] of Object.entries(record)) {
    if (key === "metadata" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) put(`metadata.${k}`, v);
    } else put(key, value);
  }
  return out;
}
