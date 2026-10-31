import type { KnowledgeSource } from "./knowledge-pack-schema.ts";

/** Commits the knowledge packs were ported from; the same pins as docs/PORTING.md. */
export const PINNED_SOURCES = {
  "zuey-workspace": "10719856e9027c92d61892e523b82dd70fca189b",
  agentkit: "9fe4699777a954987bb859bf839dacab1aff14ec",
} as const satisfies Record<KnowledgeSource["repo"], string>;

const ANIME_CREATOR = ".agents/skills/anime-creator";

/** A source file of the anime-creator skill in zuey-workspace, path relative to the skill directory. */
export function animeCreatorSource(path: string, matrix: string): KnowledgeSource {
  return {
    repo: "zuey-workspace",
    ref: `${PINNED_SOURCES["zuey-workspace"]}:${ANIME_CREATOR}/${path}`,
    matrix,
  };
}

/** A source file in agentkit, path relative to the repository root. */
export function agentkitSource(path: string, matrix: string, notice?: string): KnowledgeSource {
  return {
    repo: "agentkit",
    ref: `${PINNED_SOURCES.agentkit}:${path}`,
    matrix,
    ...(notice === undefined ? {} : { notice }),
  };
}
