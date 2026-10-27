import { StudixError } from "@studix/shared";
import { exportJsonSchemas, type VideoIR } from "@studix/video-ir";
import { type BrandIntroOptions, brandIntroTemplate } from "./brand-intro/brand-intro-template.ts";

export interface SkillMetadata {
  /** Stable id, lowercase kebab-case. */
  id: string;
  title: string;
  description: string;
  version: number;
  /** JSON Schema (draft 2020-12) of the input the skill accepts. */
  inputSchema: Record<string, unknown>;
  /** What run() returns. */
  output: "video-ir";
}

export interface Skill extends SkillMetadata {
  /** Validates `input` at the boundary; throws a VALIDATION StudixError when it does not match. */
  run(input: unknown, options?: SkillRunOptions): VideoIR;
}

/** Inputs a skill may need beyond its JSON input, e.g. stored assets the brief references. */
export type SkillRunOptions = BrandIntroOptions;

let creativeBriefSchema: Record<string, unknown> | undefined;
function briefSchema(): Record<string, unknown> {
  creativeBriefSchema ??= exportJsonSchemas()["creative-brief"];
  return creativeBriefSchema;
}

const SKILLS: readonly Skill[] = [
  {
    id: "brand-intro",
    title: "Brand intro",
    description:
      "Deterministic 6–15s brand introduction: title card, two or three key messages and a call-to-action " +
      "outro in the brief's aspect ratio and brand colors. Vietnamese copy is kept intact.",
    version: 1,
    get inputSchema() {
      // A copy per read so a caller mutating its schema cannot change what other callers see.
      return structuredClone(briefSchema());
    },
    output: "video-ir",
    run: brandIntroTemplate,
  },
];

function metadata(skill: Skill): SkillMetadata {
  const { id, title, description, version, inputSchema, output } = skill;
  return { id, title, description, version, inputSchema, output };
}

/** Metadata of every registered skill, in a stable order. */
export function listSkills(): SkillMetadata[] {
  return SKILLS.map(metadata);
}

export function getSkill(id: string): Skill {
  const skill = SKILLS.find((s) => s.id === id);
  if (!skill) {
    throw new StudixError("NOT_FOUND", `Unknown skill "${id}"`, {
      details: { available: SKILLS.map((s) => s.id) },
    });
  }
  return skill;
}
