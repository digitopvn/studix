import { StudixError } from "@studix/shared";
import type { VideoIR } from "@studix/video-ir";
import type { PackPipeline, StageDefinition } from "@studix/workflow";
import type { KnowledgeCatalog } from "./knowledge/knowledge-catalog.ts";

export interface SkillMetadata {
  /** Stable id, lowercase kebab-case, unique across every registered pack. */
  id: string;
  /** Id of the pack that contributes the template. */
  pack: string;
  title: string;
  description: string;
  version: number;
  /** JSON Schema (draft 2020-12) of the input the skill accepts. */
  inputSchema: Record<string, unknown>;
  /** What run() returns. */
  output: "video-ir";
}

/** Inputs a template may need beyond its JSON input, e.g. stored assets the brief references. */
export interface SkillRunOptions {
  assets?: VideoIR["assets"];
}

/** A workflow template: turns a validated input into a VideoIR. */
export interface Skill extends Omit<SkillMetadata, "pack"> {
  /** Validates `input` at the boundary; throws a VALIDATION StudixError when it does not match. */
  run(input: unknown, options?: SkillRunOptions): VideoIR;
}

/**
 * A genre (brand intro, anime, marketing video, ...) packaged for the shared engine: the templates it
 * offers and the typed stage templates its workflows are built from. Registering a pack is all it takes to
 * expose it; the MCP server and the engine read the registry and never name a pack.
 */
export interface WorkflowPack {
  /** Lowercase kebab-case, unique. */
  id: string;
  title: string;
  version: number;
  templates: readonly Skill[];
  /** Stage templates (with input/output schemas and cache keys), unique by name across packs. */
  stages?: readonly StageDefinition[];
  /**
   * How a video.create job of this pack runs (its stages woven between the engine's); packs without one
   * run the engine's default plan -> render chain.
   */
  pipeline?: PackPipeline;
}

export interface PackRegistry {
  /** Adds a pack; throws CONFLICT on a duplicate pack id, template id or stage name. Returns an unregister. */
  register(pack: WorkflowPack): () => void;
  packs(): WorkflowPack[];
  /** Every template of every pack, in registration order. */
  templates(): Array<Skill & { pack: string }>;
  /** Throws NOT_FOUND for an unknown template id. */
  template(id: string): Skill & { pack: string };
  /** Stage template by name, or undefined. */
  stage(name: string): StageDefinition | undefined;
}

const PACK_ID = /^[a-z0-9][a-z0-9-]*$/;

export interface PackRegistryOptions {
  /** When set, a stage may only declare `knowledge` ids this catalog holds. */
  knowledge?: Pick<KnowledgeCatalog, "has">;
}

export function createPackRegistry(
  initial: readonly WorkflowPack[] = [],
  options: PackRegistryOptions = {},
): PackRegistry {
  const packs: WorkflowPack[] = [];
  const registry: PackRegistry = {
    register(pack) {
      if (!PACK_ID.test(pack.id))
        throw new StudixError("VALIDATION", `pack id "${pack.id}" is not lowercase kebab-case`);
      const clash = (what: string, name: string) =>
        new StudixError("CONFLICT", `${what} "${name}" is already registered`, {
          details: { pack: pack.id },
        });
      if (packs.some((p) => p.id === pack.id)) throw clash("pack", pack.id);
      const templateIds = new Set(registry.templates().map((t) => t.id));
      const stageNames = new Set(packs.flatMap((p) => (p.stages ?? []).map((s) => s.name)));
      for (const t of pack.templates) {
        if (!PACK_ID.test(t.id))
          throw new StudixError("VALIDATION", `template id "${t.id}" is not lowercase kebab-case`);
        if (templateIds.has(t.id)) throw clash("template", t.id);
        templateIds.add(t.id);
      }
      for (const s of pack.stages ?? []) {
        if (stageNames.has(s.name)) throw clash("stage", s.name);
        stageNames.add(s.name);
        const unknown = (s.knowledge ?? []).filter((id) => options.knowledge && !options.knowledge.has(id));
        if (unknown.length > 0) {
          throw new StudixError("VALIDATION", `stage "${s.name}" needs unknown knowledge packs`, {
            details: { pack: pack.id, stage: s.name, unknown },
          });
        }
      }
      packs.push(pack);
      return () => {
        const at = packs.indexOf(pack);
        if (at >= 0) packs.splice(at, 1);
      };
    },
    packs: () => [...packs],
    templates: () =>
      packs.flatMap((p) =>
        // Spreading evaluates getters per call, so each caller gets its own inputSchema copy.
        p.templates.map((t) => ({ ...t, pack: p.id })),
      ),
    template(id) {
      const found = registry.templates().find((t) => t.id === id);
      if (!found) {
        throw new StudixError("NOT_FOUND", `Unknown skill "${id}"`, {
          details: { available: registry.templates().map((t) => t.id) },
        });
      }
      return found;
    },
    stage: (name) => packs.flatMap((p) => p.stages ?? []).find((s) => s.name === name),
  };
  for (const pack of initial) registry.register(pack);
  return registry;
}
