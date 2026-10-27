import { createProjectRepository, createRenderRepository, type DbExecutor } from "@studix/database";
import type { Clock } from "@studix/shared";
import type { StageRepos } from "./workflow-types.ts";

/** Postgres repositories bound to one executor, normally the transaction of a fenced stage write. */
export function createStageRepos(tx: DbExecutor, clock: Clock): StageRepos {
  return { projects: createProjectRepository(tx, clock), renders: createRenderRepository(tx, clock) };
}
