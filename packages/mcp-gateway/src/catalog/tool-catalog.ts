import type { Clock } from "@studix/shared";
import type { Connector, ConnectorTool } from "../registry/connector-types.ts";
import { qualifyToolName } from "./tool-normalizer.ts";
import { summarize } from "./untrusted-text-hygiene.ts";

/** Search-ready view of one tool. Permission is NOT baked in; it is evaluated per request. */
export interface CatalogEntry {
  qualifiedName: string;
  connectorId: string;
  connectorName: string;
  tool: ConnectorTool;
  summary: string;
  nameTokens: string[];
  titleTokens: string[];
  descriptionTokens: string[];
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

interface CacheSlot {
  entries: CatalogEntry[];
  expiresAt: number;
}

export interface ToolCatalogOptions {
  ttlMs: number;
  maxSummaryChars: number;
  clock: Clock;
  /** Cache slots kept before the oldest is evicted. */
  maxSlots?: number;
}

/**
 * Per-workspace tool catalog cache. Slots are keyed by workspace, connector and connector version, so any
 * refresh/enable/disable/policy change (which bumps the version) misses the cache; explicit invalidation
 * and a TTL bound memory and staleness further. There is no cross-workspace catalog.
 */
export class ToolCatalog {
  private readonly slots = new Map<string, CacheSlot>();
  private readonly maxSlots: number;

  constructor(private readonly options: ToolCatalogOptions) {
    this.maxSlots = options.maxSlots ?? 1_000;
  }

  private key(connector: Pick<Connector, "workspaceId" | "id" | "version">): string {
    return `${connector.workspaceId}:${connector.id}:${connector.version}`;
  }

  entriesFor(connector: Connector): CatalogEntry[] {
    const now = this.options.clock.now().getTime();
    const key = this.key(connector);
    const hit = this.slots.get(key);
    if (hit && hit.expiresAt > now) return hit.entries;
    const entries = connector.tools.map((tool) => ({
      qualifiedName: qualifyToolName(connector.name, tool.name),
      connectorId: connector.id,
      connectorName: connector.name,
      tool,
      summary: summarize(tool.description, this.options.maxSummaryChars),
      nameTokens: tokenize(tool.name),
      titleTokens: tokenize(tool.title ?? ""),
      descriptionTokens: tokenize(tool.description),
    }));
    this.slots.delete(key);
    this.slots.set(key, { entries, expiresAt: now + this.options.ttlMs });
    while (this.slots.size > this.maxSlots) {
      const oldest = this.slots.keys().next().value;
      if (oldest === undefined) break;
      this.slots.delete(oldest);
    }
    return entries;
  }

  /** Drop cached slots for a connector (all versions) or a whole workspace. */
  invalidate(workspaceId: string, connectorId?: string): void {
    const prefix = connectorId ? `${workspaceId}:${connectorId}:` : `${workspaceId}:`;
    for (const key of [...this.slots.keys()]) if (key.startsWith(prefix)) this.slots.delete(key);
  }

  get size(): number {
    return this.slots.size;
  }
}

/** Dice coefficient over character bigrams, for typo-tolerant name matching. */
function bigramSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) ?? 0) + 1);
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [gram, count] of ga) overlap += Math.min(count, gb.get(gram) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/** Exact name first, then lexical token matches, then fuzzy name similarity. Returns score > 0 only. */
export function scoreEntry(entry: CatalogEntry, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  if (entry.qualifiedName.toLowerCase() === q || entry.tool.name.toLowerCase() === q) return 1_000;
  let score = 0;
  const name = entry.tool.name.toLowerCase();
  if (name.includes(q)) score += name.startsWith(q) ? 250 : 200;
  for (const token of tokenize(q)) {
    if (entry.nameTokens.includes(token)) score += 30;
    else if (entry.nameTokens.some((t) => t.startsWith(token))) score += 20;
    else {
      const fuzzy = Math.max(0, ...entry.nameTokens.map((t) => bigramSimilarity(t, token)));
      if (fuzzy >= 0.6) score += Math.round(15 * fuzzy);
    }
    if (entry.titleTokens.includes(token)) score += 15;
    if (entry.descriptionTokens.includes(token)) score += 5;
    if (entry.connectorName === token) score += 3;
  }
  return score;
}
