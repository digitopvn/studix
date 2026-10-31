import type { NewRecord } from "../entities/common.ts";
import type { ProjectStoryboard } from "../entities/storyboard.ts";
import type { TenantContext } from "../tenant.ts";

export type NewProjectStoryboard = NewRecord<ProjectStoryboard>;

/** Append-only storyboard revisions per project. */
export interface StoryboardRepository {
  /** Newest revision of the project's storyboard, or undefined when none was stored yet. */
  latest(ctx: TenantContext, projectId: string): Promise<ProjectStoryboard | undefined>;
  /**
   * Store the next revision. `input.revision` must be the latest revision plus one (1 for the first);
   * a concurrent writer that took the number first makes this throw CONFLICT. Throws NOT_FOUND when the
   * project or version is not in the tenant.
   */
  append(ctx: TenantContext, input: NewProjectStoryboard): Promise<ProjectStoryboard>;
}
