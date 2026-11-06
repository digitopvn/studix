/**
 * A deliberately small, safe parser for the YAML frontmatter of a `SKILL.md`. It understands only the
 * subset skills use: top-level `key: value` pairs with plain, quoted or `|`/`>` block scalars, one-level
 * maps (`metadata:`), and lists of scalars. Anchors, aliases, tags, flow maps and deeper nesting are
 * refused, nothing is evaluated, and every size is capped. The skill text is untrusted data.
 */

export type ParsedSkillMarkdown =
  | {
      ok: true;
      /** Display name: the declared name, trimmed with whitespace collapsed. */
      name: string;
      /** Lower-case ASCII slug derived from the name, for display and matching. */
      slug: string;
      description: string;
      /** Declared license (SPDX id or free text), when present. */
      license?: string;
      /** Remaining short scalar fields; the children of `metadata:` are flattened in. */
      metadata: Record<string, string>;
      /** The Markdown after the frontmatter. */
      body: string;
    }
  | { ok: false; reason: string };

export const SKILL_FRONTMATTER_LIMITS = Object.freeze({
  maxFrontmatterChars: 16 * 1024,
  maxFrontmatterLines: 400,
  maxNameChars: 100,
  maxDescriptionChars: 2000,
  maxLicenseChars: 200,
  maxMetadataEntries: 32,
  maxMetadataKeyChars: 64,
  maxMetadataValueChars: 500,
});

type YamlValue = string | string[] | Map<string, string>;

class FrontmatterError extends Error {}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const KEY_LINE_RE = /^([^\s:#'"[{][^:]*?)\s*:(?:[ \t]+(.*))?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Parse a SKILL.md into its validated frontmatter fields and body; never throws. */
export function parseSkillMarkdown(text: string): ParsedSkillMarkdown {
  if (typeof text !== "string") return { ok: false, reason: "SKILL.md is not text" };
  if (text.includes("\u0000")) return { ok: false, reason: "SKILL.md contains NUL bytes" };
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { ok: false, reason: "SKILL.md has no YAML frontmatter" };
  const limit = Math.min(lines.length, SKILL_FRONTMATTER_LIMITS.maxFrontmatterLines + 2);
  let end = -1;
  for (let i = 1; i < limit; i++) {
    const line = lines[i]?.trimEnd();
    if (line === "---" || line === "...") {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return lines.length > limit
      ? { ok: false, reason: "SKILL.md frontmatter is too long" }
      : { ok: false, reason: "SKILL.md frontmatter is not closed" };
  }
  const frontmatter = lines.slice(1, end);
  if (frontmatter.join("\n").length > SKILL_FRONTMATTER_LIMITS.maxFrontmatterChars) {
    return { ok: false, reason: "SKILL.md frontmatter is too long" };
  }

  let entries: Map<string, YamlValue>;
  try {
    entries = parseEntries(frontmatter);
  } catch (err) {
    if (err instanceof FrontmatterError) return { ok: false, reason: `Invalid frontmatter: ${err.message}` };
    throw err;
  }

  const rawName = entries.get("name");
  if (typeof rawName !== "string") return { ok: false, reason: "Frontmatter `name` is missing" };
  const name = rawName.replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
  if (name.length === 0) return { ok: false, reason: "Frontmatter `name` is empty" };
  if (name.length > SKILL_FRONTMATTER_LIMITS.maxNameChars) {
    return {
      ok: false,
      reason: `Frontmatter \`name\` exceeds ${SKILL_FRONTMATTER_LIMITS.maxNameChars} characters`,
    };
  }
  const rawDescription = entries.get("description");
  if (typeof rawDescription !== "string")
    return { ok: false, reason: "Frontmatter `description` is missing" };
  const description = rawDescription.replace(CONTROL_RE, "").trim();
  if (description.length === 0) return { ok: false, reason: "Frontmatter `description` is empty" };
  if (description.length > SKILL_FRONTMATTER_LIMITS.maxDescriptionChars) {
    return {
      ok: false,
      reason: `Frontmatter \`description\` exceeds ${SKILL_FRONTMATTER_LIMITS.maxDescriptionChars} characters`,
    };
  }

  const rawLicense = entries.get("license");
  const license =
    typeof rawLicense === "string" && !isNull(rawLicense)
      ? clip(rawLicense.replace(CONTROL_RE, "").trim(), SKILL_FRONTMATTER_LIMITS.maxLicenseChars)
      : undefined;

  const result: ParsedSkillMarkdown = {
    ok: true,
    name,
    slug: slugify(name),
    description,
    metadata: collectMetadata(entries),
    body: lines.slice(end + 1).join("\n"),
  };
  if (license) result.license = license;
  return result;
}

function collectMetadata(entries: Map<string, YamlValue>): Record<string, string> {
  const metadata: Record<string, string> = {};
  let count = 0;
  const add = (key: string, value: string) => {
    if (count >= SKILL_FRONTMATTER_LIMITS.maxMetadataEntries) return;
    if (key.length > SKILL_FRONTMATTER_LIMITS.maxMetadataKeyChars || Object.hasOwn(metadata, key)) return;
    const clean = value.replace(CONTROL_RE, "").trim();
    if (clean.length === 0 || isNull(clean)) return;
    metadata[key] = clip(clean, SKILL_FRONTMATTER_LIMITS.maxMetadataValueChars);
    count++;
  };
  // Top-level scalars win over same-named children of `metadata:`.
  for (const [key, value] of entries) {
    if (key === "name" || key === "description" || key === "license") continue;
    if (typeof value === "string") add(key, value);
    else if (Array.isArray(value)) add(key, value.join(", "));
  }
  for (const [key, value] of entries) {
    if (!(value instanceof Map)) continue;
    for (const [child, childValue] of value) add(key === "metadata" ? child : `${key}.${child}`, childValue);
  }
  return metadata;
}

function parseEntries(lines: string[]): Map<string, YamlValue> {
  const entries = new Map<string, YamlValue>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) throw new FrontmatterError(`unexpected indentation on line ${i + 2}`);
    if (line.startsWith("%")) throw new FrontmatterError("YAML directives are not supported");
    const match = KEY_LINE_RE.exec(line);
    const key = match?.[1];
    if (!match || key === undefined || !KEY_RE.test(key)) {
      throw new FrontmatterError(`expected \`key: value\` on line ${i + 2}`);
    }
    if (entries.has(key)) throw new FrontmatterError(`duplicate key \`${key}\``);
    const rest = (match[2] ?? "").trim();
    const children: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? "";
      if (next.trim() !== "" && !/^\s/.test(next)) break;
      children.push(next);
      j++;
    }
    while (children.length > 0 && (children.at(-1) ?? "").trim() === "") children.pop();
    if (children.some((child) => child.trim() !== "" && /^ *\t/.test(child))) {
      throw new FrontmatterError("tabs are not allowed in indentation");
    }
    entries.set(key, parseValue(rest, children));
    i = j;
  }
  return entries;
}

function parseValue(rest: string, children: string[]): YamlValue {
  const content = children.filter((child) => !isBlankOrComment(child));
  if (rest === "" || rest.startsWith("#")) {
    if (content.length === 0) return "";
    const first = content[0] ?? "";
    return /^\s*-(\s|$)/.test(first) ? parseList(children) : parseMap(children);
  }
  if (rest.startsWith("|") || rest.startsWith(">")) return parseBlockScalar(rest, children);
  const value = parseScalar(rest);
  if (content.length === 0) return value;
  // A plain scalar may continue on more-indented lines; quoted or flow values may not.
  if (typeof value !== "string" || /^["']/.test(rest)) {
    throw new FrontmatterError("multi-line quoted or flow values are not supported");
  }
  return foldLines([value, ...children.map((child) => child.trim())]);
}

function parseMap(children: string[]): Map<string, string> {
  const map = new Map<string, string>();
  let indent = -1;
  for (const child of children) {
    if (isBlankOrComment(child)) continue;
    const childIndent = child.length - child.trimStart().length;
    if (indent < 0) indent = childIndent;
    if (childIndent !== indent) throw new FrontmatterError("nesting deeper than one level is not supported");
    const match = KEY_LINE_RE.exec(child.trimStart());
    const key = match?.[1];
    if (!match || key === undefined || !KEY_RE.test(key)) throw new FrontmatterError("malformed map entry");
    if (map.has(key)) throw new FrontmatterError(`duplicate key \`${key}\``);
    const value = (match[2] ?? "").trim();
    if (value.startsWith("|") || value.startsWith(">")) {
      throw new FrontmatterError("block scalars inside maps are not supported");
    }
    const parsed = value === "" ? "" : parseScalar(value);
    map.set(key, Array.isArray(parsed) ? parsed.join(", ") : parsed);
  }
  return map;
}

function parseList(children: string[]): string[] {
  const items: string[] = [];
  let indent = -1;
  for (const child of children) {
    if (isBlankOrComment(child)) continue;
    const childIndent = child.length - child.trimStart().length;
    if (indent < 0) indent = childIndent;
    const match = /^-(?:\s+(.*))?$/.exec(child.trimStart());
    if (childIndent !== indent || !match) throw new FrontmatterError("only lists of scalars are supported");
    const value = (match[1] ?? "").trim();
    const parsed = value === "" ? "" : parseScalar(value);
    if (Array.isArray(parsed)) throw new FrontmatterError("nested lists are not supported");
    items.push(parsed);
  }
  return items;
}

function parseBlockScalar(header: string, children: string[]): string {
  const match = /^([|>])([+-]?)\s*(?:#.*)?$/.exec(header);
  if (!match) throw new FrontmatterError("unsupported block scalar header");
  const literal = match[1] === "|";
  const chomp = match[2] ?? "";
  let indent = -1;
  for (const child of children) {
    if (child.trim() === "") continue;
    indent = child.length - child.trimStart().length;
    break;
  }
  const body: string[] = [];
  for (const child of children) {
    if (child.trim() === "") {
      body.push("");
      continue;
    }
    const childIndent = child.length - child.trimStart().length;
    if (childIndent < indent) throw new FrontmatterError("inconsistent block scalar indentation");
    body.push(child.slice(indent));
  }
  let trailing = 0;
  while (body.length > 0 && body.at(-1) === "") {
    body.pop();
    trailing++;
  }
  const text = literal ? body.join("\n") : foldLines(body);
  if (text === "") return "";
  if (chomp === "-") return text;
  if (chomp === "+") return `${text}\n${"\n".repeat(trailing)}`;
  return `${text}\n`;
}

/** YAML line folding: single line breaks become spaces, each blank line becomes a newline. */
function foldLines(lines: string[]): string {
  let out = "";
  let previousBlank = true;
  for (const line of lines) {
    if (line === "") {
      out += "\n";
      previousBlank = true;
    } else {
      out += previousBlank ? line : ` ${line}`;
      previousBlank = false;
    }
  }
  return out;
}

function parseScalar(value: string): string | string[] {
  const first = value[0];
  if (first === "&" || first === "*" || first === "!") {
    throw new FrontmatterError("YAML anchors, aliases and tags are not supported");
  }
  if (first === "@" || first === "`") throw new FrontmatterError("reserved YAML indicator");
  if (first === "{") throw new FrontmatterError("flow maps are not supported");
  if (first === '"') return expectEnd(...parseDoubleQuoted(value));
  if (first === "'") return expectEnd(...parseSingleQuoted(value));
  if (first === "[") return parseFlowList(value);
  return stripComment(value);
}

function parseFlowList(value: string): string[] {
  const text = stripComment(value);
  if (!text.endsWith("]")) throw new FrontmatterError("unterminated flow list");
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  if (/[[\]{}]/.test(inner)) throw new FrontmatterError("nested flow collections are not supported");
  return inner.split(",").map((item) => {
    const parsed = parseScalar(item.trim());
    if (Array.isArray(parsed)) throw new FrontmatterError("nested flow collections are not supported");
    return parsed;
  });
}

function parseDoubleQuoted(value: string): [string, string] {
  let out = "";
  for (let i = 1; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') return [out, value.slice(i + 1)];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const esc = value[++i];
    const simple: Record<string, string> = {
      "\\": "\\",
      '"': '"',
      "/": "/",
      n: "\n",
      t: "\t",
      r: "\r",
      " ": " ",
    };
    if (esc !== undefined && simple[esc] !== undefined) {
      out += simple[esc];
    } else if (esc === "u" || esc === "x") {
      const width = esc === "u" ? 4 : 2;
      const hex = value.slice(i + 1, i + 1 + width);
      if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex))
        throw new FrontmatterError("invalid escape sequence");
      const code = Number.parseInt(hex, 16);
      if (code === 0) throw new FrontmatterError("NUL escapes are not allowed");
      out += String.fromCharCode(code);
      i += width;
    } else {
      throw new FrontmatterError("unsupported escape sequence");
    }
  }
  throw new FrontmatterError("unterminated double-quoted string");
}

function parseSingleQuoted(value: string): [string, string] {
  let out = "";
  for (let i = 1; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'") {
      if (value[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return [out, value.slice(i + 1)];
    }
    out += ch;
  }
  throw new FrontmatterError("unterminated single-quoted string");
}

function expectEnd(parsed: string, remainder: string): string {
  const tail = remainder.trim();
  if (tail !== "" && !tail.startsWith("#"))
    throw new FrontmatterError("unexpected text after a quoted string");
  return parsed;
}

function stripComment(value: string): string {
  const hash = value.search(/\s#/);
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function isNull(value: string): boolean {
  return value === "" || value === "~" || value === "null";
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug === "" ? "skill" : slug;
}
