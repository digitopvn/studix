import { brandIntroPack } from "./brand-intro/brand-intro-pack.ts";
import { BUILTIN_KNOWLEDGE_PACKS } from "./knowledge/builtin-knowledge-packs.ts";
import { createKnowledgeCatalog, type KnowledgeConsumer } from "./knowledge/knowledge-catalog.ts";
import type { KnowledgePack } from "./knowledge/knowledge-pack-schema.ts";
import { marketingVideoPack } from "./marketing-video/marketing-video-pack.ts";
import { motionGraphicPack } from "./motion-graphic/motion-graphic-pack.ts";
import { animePack } from "./narrative-film/anime-pack.ts";
import { longFormFilmPack } from "./narrative-film/long-form-film-pack.ts";
import { createPackRegistry, type Skill, type SkillMetadata, type WorkflowPack } from "./pack-registry.ts";
import { skillAgentPack } from "./skill-agent/skill-agent-pack.ts";

/** Process-wide knowledge catalog; built-in knowledge packs are linted and registered here. */
export const knowledgeCatalog = createKnowledgeCatalog(BUILTIN_KNOWLEDGE_PACKS);

/** Process-wide registry the MCP server and the worker read; built-in packs are registered here. */
export const packRegistry = createPackRegistry(
  [brandIntroPack, marketingVideoPack, motionGraphicPack, animePack, longFormFilmPack, skillAgentPack],
  {
    knowledge: knowledgeCatalog,
  },
);

/** Add a pack to the process-wide registry; returns a function that removes it again. */
export function registerPack(pack: WorkflowPack): () => void {
  return packRegistry.register(pack);
}

/** Lint and add a knowledge pack to the process-wide catalog; returns a function that removes it again. */
export function registerKnowledgePack(pack: unknown): () => void {
  return knowledgeCatalog.register(pack);
}

/** The knowledge packs a stage declared in `knowledge`, and only those. */
export function loadStageKnowledge(stage: KnowledgeConsumer): KnowledgePack[] {
  return knowledgeCatalog.forStage(stage);
}

function metadata(skill: SkillMetadata): SkillMetadata {
  const { id, pack, title, description, version, inputSchema, output } = skill;
  return { id, pack, title, description, version, inputSchema, output };
}

/** Metadata of every registered template, in a stable order. */
export function listSkills(): SkillMetadata[] {
  return packRegistry.templates().map(metadata);
}

export function getSkill(id: string): Skill & { pack: string } {
  return packRegistry.template(id);
}
