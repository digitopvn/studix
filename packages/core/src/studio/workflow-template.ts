import { StudixError } from "@studix/shared";
import { DEFAULT_WORKFLOW_TEMPLATE } from "./studio-types.ts";

/** The part of a workflow pack registry this needs (structurally `PackRegistry` of `@studix/skills`). */
export interface WorkflowPackSource<P extends { id: string }> {
  packs(): P[];
}

/**
 * The registered pack for a `workflowTemplate` (the default pack when omitted). An unknown id is a
 * VALIDATION error whose details and suggested action list the packs that are registered.
 */
export function resolveWorkflowPack<P extends { id: string }>(
  registry: WorkflowPackSource<P>,
  workflowTemplate: string | undefined,
): P {
  const id = workflowTemplate ?? DEFAULT_WORKFLOW_TEMPLATE;
  const packs = registry.packs();
  const pack = packs.find((p) => p.id === id);
  if (pack) return pack;
  const available = packs.map((p) => p.id);
  throw new StudixError("VALIDATION", `Unknown workflowTemplate "${id}"`, {
    retryable: false,
    details: { workflowTemplate: id, available },
    suggestedAction: `Use one of: ${available.join(", ") || "(no packs registered)"}. studix_inspect lists them.`,
  });
}
