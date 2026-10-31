import type { Storyboard } from "@studix/video-ir";
import type { ActorRef, TenantOwned } from "./common.ts";

/**
 * Immutable stored revision of a project's storyboard with its review state. `revision` is 1-based and
 * increases per project; every review decision or content change appends a new revision, so the history
 * of who approved what stays readable. `versionId` is the project version the storyboard describes.
 */
export interface ProjectStoryboard extends TenantOwned {
  projectId: string;
  revision: number;
  versionId: string;
  storyboard: Storyboard;
  createdBy: ActorRef;
}
