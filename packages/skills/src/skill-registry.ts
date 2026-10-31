import { brandIntroPack } from "./brand-intro/brand-intro-pack.ts";
import { createPackRegistry, type Skill, type SkillMetadata, type WorkflowPack } from "./pack-registry.ts";

/** Process-wide registry the MCP server and the worker read; built-in packs are registered here. */
export const packRegistry = createPackRegistry([brandIntroPack]);

/** Add a pack to the process-wide registry; returns a function that removes it again. */
export function registerPack(pack: WorkflowPack): () => void {
  return packRegistry.register(pack);
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
