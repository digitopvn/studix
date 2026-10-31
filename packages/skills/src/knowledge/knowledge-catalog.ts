import { StudixError } from "@studix/shared";
import { formatLintIssues, lintKnowledgePacks } from "./knowledge-lint.ts";
import { DEFAULT_KNOWLEDGE_LINT_CONFIG, type KnowledgeLintConfig } from "./knowledge-lint-config.ts";
import { type HardCheck, KnowledgePack, type KnowledgePhase } from "./knowledge-pack-schema.ts";
import { createBm25Index } from "./knowledge-search.ts";

/** What a stage declares to get its knowledge: `StageDefinition` satisfies this. */
export interface KnowledgeConsumer {
  name: string;
  knowledge?: readonly string[];
}

export interface KnowledgeHit {
  pack: string;
  /** Set for a hit on one entry; a hit on the pack's own description has neither. */
  section?: string;
  entry?: string;
  title: string;
  score: number;
}

/** A hard check with the pack it belongs to: the contract a measuring tool attaches to by `metric.id`. */
export type HardCheckContract = HardCheck & { pack: string };

export interface KnowledgeCatalog {
  /** Lints and adds a pack; throws VALIDATION on any lint issue (including clashes). Returns an unregister. */
  register(pack: unknown): () => void;
  packs(): KnowledgePack[];
  /** Throws NOT_FOUND for an unknown id. */
  pack(id: string): KnowledgePack;
  has(id: string): boolean;
  /**
   * The packs a stage declared, in its order, and nothing else. A stage without `knowledge` gets none.
   * Throws NOT_FOUND when the stage names a pack that is not registered.
   */
  forStage(stage: KnowledgeConsumer): KnowledgePack[];
  /** BM25 search over pack descriptions and entries, best first. */
  search(query: string, options?: { phase?: KnowledgePhase; limit?: number }): KnowledgeHit[];
  /** Every hard check of every pack. */
  hardChecks(): HardCheckContract[];
}

interface Doc {
  hit: Omit<KnowledgeHit, "score">;
  phases: readonly KnowledgePhase[];
  text: string;
}

function documents(packs: readonly KnowledgePack[]): Doc[] {
  return packs.flatMap((p) => [
    {
      hit: { pack: p.id, title: p.title },
      phases: p.phases,
      text: [p.title, p.summary, p.purpose, ...p.loadWhen, ...p.useCases].join(" "),
    },
    ...p.sections.flatMap((s) =>
      s.entries.map((e) => ({
        hit: { pack: p.id, section: s.id, entry: e.id, title: e.title },
        phases: p.phases,
        text: [e.title, e.text, ...Object.values(e.fields ?? {}), ...(e.tags ?? [])].join(" "),
      })),
    ),
  ]);
}

export function createKnowledgeCatalog(
  initial: readonly unknown[] = [],
  config: KnowledgeLintConfig = DEFAULT_KNOWLEDGE_LINT_CONFIG,
): KnowledgeCatalog {
  const packs: KnowledgePack[] = [];
  let index: { docs: Doc[]; bm25: ReturnType<typeof createBm25Index> } | undefined;

  const lintOrThrow = (candidates: readonly unknown[]) => {
    const issues = lintKnowledgePacks(candidates, config);
    if (issues.length > 0) {
      throw new StudixError("VALIDATION", `knowledge pack lint failed:\n${formatLintIssues(issues)}`, {
        details: { issues },
      });
    }
  };

  const catalog: KnowledgeCatalog = {
    register(raw) {
      // Linting together with the registered packs catches id and check id clashes.
      lintOrThrow([...packs, raw]);
      const pack = KnowledgePack.parse(raw);
      packs.push(pack);
      index = undefined;
      return () => {
        const at = packs.indexOf(pack);
        if (at >= 0) packs.splice(at, 1);
        index = undefined;
      };
    },
    packs: () => [...packs],
    has: (id) => packs.some((p) => p.id === id),
    pack(id) {
      const found = packs.find((p) => p.id === id);
      if (!found) {
        throw new StudixError("NOT_FOUND", `Unknown knowledge pack "${id}"`, {
          details: { available: packs.map((p) => p.id) },
        });
      }
      return found;
    },
    forStage(stage) {
      return (stage.knowledge ?? []).map((id) => {
        if (!catalog.has(id)) {
          throw new StudixError("NOT_FOUND", `Stage "${stage.name}" needs unknown knowledge pack "${id}"`, {
            details: { stage: stage.name, available: packs.map((p) => p.id) },
          });
        }
        return catalog.pack(id);
      });
    },
    search(query, options = {}) {
      if (!index) {
        const docs = documents(packs);
        index = { docs, bm25: createBm25Index(docs.map((d) => d.text)) };
      }
      const { docs, bm25 } = index;
      const limit = options.limit ?? 5;
      return bm25
        .rank(query)
        .map(({ index: i, score }) => ({ doc: docs[i]!, score }))
        .filter(({ doc }) => options.phase === undefined || doc.phases.includes(options.phase))
        .slice(0, limit)
        .map(({ doc, score }) => ({ ...doc.hit, score }));
    },
    hardChecks: () =>
      packs.flatMap((p) =>
        p.checks.filter((c): c is HardCheck => c.kind === "hard").map((c) => ({ ...c, pack: p.id })),
      ),
  };

  lintOrThrow(initial);
  for (const raw of initial) packs.push(KnowledgePack.parse(raw));
  return catalog;
}
