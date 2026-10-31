import { DEFAULT_KNOWLEDGE_LINT_CONFIG, type KnowledgeLintConfig } from "./knowledge-lint-config.ts";
import { KnowledgePack, parseSourceRef } from "./knowledge-pack-schema.ts";

export type KnowledgeLintRule =
  | "schema"
  | "duplicate-pack"
  | "duplicate-id"
  | "check-prefix"
  | "unpinned-source"
  | "absolute-path"
  | "secret"
  | "banned-term";

export interface KnowledgeLintIssue {
  /** Pack id, or `#<index>` when the pack has no usable id. */
  pack: string;
  /** JSON path inside the pack, e.g. `checks.2.id`. */
  path: string;
  rule: KnowledgeLintRule;
  message: string;
}

// Machine paths: drive letters, UNC shares, home shortcuts and the usual absolute POSIX roots.
const ABSOLUTE_PATH =
  /(?:^|[\s"'`(=,])(?:[A-Za-z]:[\\/]|\\\\[\w.-]+[\\/]|~[\\/]|\/(?:Users|home|root|var|tmp|etc|opt|mnt|srv|private|Volumes|usr)\/)/;
const SECRETS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}/i,
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function termMatchers(terms: readonly string[]): Array<{ term: string; re: RegExp }> {
  return terms.map((term) => ({
    term,
    // Unicode-aware word boundaries so "Apple" matches "Apple-like" but not "pineapple".
    re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "iu"),
  }));
}

/** Every string inside `value` with its JSON path, skipping the `sources` subtree (refs are real paths). */
function* strings(value: unknown, path: string[] = []): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path.join("."), value];
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* strings(v, [...path, String(i)]);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (path.length === 0 && k === "sources") continue;
      yield* strings(v, [...path, k]);
    }
  }
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/**
 * Lints knowledge packs: schema, unique ids (packs, check ids across packs, sections and entries within a
 * pack), check ids prefixed by their pack id, sources cited at the pinned commit, and content free of
 * machine paths, secrets and banned names. Returns every issue; an empty list means the packs are clean.
 */
export function lintKnowledgePacks(
  packs: readonly unknown[],
  config: KnowledgeLintConfig = DEFAULT_KNOWLEDGE_LINT_CONFIG,
): KnowledgeLintIssue[] {
  const issues: KnowledgeLintIssue[] = [];
  const banned = termMatchers(config.bannedTerms);
  const valid: KnowledgePack[] = [];

  for (const [index, raw] of packs.entries()) {
    const rawId = (raw as { id?: unknown } | null)?.id;
    const name = typeof rawId === "string" && rawId.length > 0 ? rawId : `#${index}`;
    const add = (path: string, rule: KnowledgeLintRule, message: string) =>
      issues.push({ pack: name, path, rule, message });

    // Content rules run on the raw value so a pack that fails the schema still gets them reported.
    for (const [path, text] of strings(raw)) {
      if (ABSOLUTE_PATH.test(text)) add(path, "absolute-path", "contains an absolute or machine path");
      if (SECRETS.some((re) => re.test(text))) add(path, "secret", "looks like a credential");
      for (const { term, re } of banned) {
        if (re.test(text)) add(path, "banned-term", `names "${term}", which the lint config bans`);
      }
    }

    const parsed = KnowledgePack.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) add(issue.path.join("."), "schema", issue.message);
      continue;
    }
    const pack = parsed.data;
    valid.push(pack);

    for (const [i, source] of pack.sources.entries()) {
      const pinned = config.pinnedSources[source.repo];
      if (parseSourceRef(source.ref)?.sha !== pinned) {
        add(
          `sources.${i}.ref`,
          "unpinned-source",
          `${source.repo} must be cited at its pinned commit ${pinned}`,
        );
      }
    }
    for (const id of duplicates(pack.sections.map((s) => s.id))) {
      add("sections", "duplicate-id", `section id "${id}" repeats`);
    }
    for (const id of duplicates(pack.sections.flatMap((s) => s.entries.map((e) => e.id)))) {
      add("sections", "duplicate-id", `entry id "${id}" repeats`);
    }
    for (const [i, check] of pack.checks.entries()) {
      if (!check.id.startsWith(`${pack.id}.`)) {
        add(`checks.${i}.id`, "check-prefix", `check id "${check.id}" must start with "${pack.id}."`);
      }
    }
  }

  for (const id of duplicates(valid.map((p) => p.id))) {
    issues.push({ pack: id, path: "id", rule: "duplicate-pack", message: `pack id "${id}" repeats` });
  }
  for (const id of duplicates(valid.flatMap((p) => p.checks.map((c) => c.id)))) {
    const owner = valid.find((p) => p.checks.some((c) => c.id === id))?.id ?? id;
    issues.push({ pack: owner, path: "checks", rule: "duplicate-id", message: `check id "${id}" repeats` });
  }
  return issues;
}

/** One line per issue, for error messages and test output. */
export function formatLintIssues(issues: readonly KnowledgeLintIssue[]): string {
  return issues.map((i) => `${i.pack}${i.path ? `:${i.path}` : ""} [${i.rule}] ${i.message}`).join("\n");
}
