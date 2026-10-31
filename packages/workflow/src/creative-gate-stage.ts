import type { Approval } from "@studix/core";
import { StudixError } from "@studix/shared";
import {
  dependentsOf,
  invalidatedNodes,
  nodeDigests,
  nodeKey,
  type VideoIR,
  VideoIR as VideoIRSchema,
  videoIrNodes,
} from "@studix/video-ir";
import { z } from "zod";
import { StageSuspended } from "./stage-signals.ts";
import type { StageContext, StageDefinition, StageUsage } from "./workflow-types.ts";

/** Gate id inside a job: `G0`, `G1`, ... (scope `gate:<id>` of its `creative.gate` approval). */
const GateId = z.string().regex(/^G[0-9]{1,2}$/, "expected a gate id such as G0");

/** One change request the gate acted on, in the order it was made. */
export const GateRevision = z.object({
  /** The `changes_requested` decision. */
  approvalId: z.string().min(1),
  targets: z.array(z.string().min(1)).min(1),
  note: z.string().min(1),
  /** Project version of the revised board. */
  versionId: z.string().min(1),
  /** Node keys the revision invalidated: dependents of the targets and every changed node, sorted. */
  invalidated: z.array(z.string()),
});
export type GateRevision = z.infer<typeof GateRevision>;

export const CreativeGateOutput = z.object({
  gate: GateId,
  approvalId: z.string().min(1),
  decidedBy: z.string().min(1),
  decidedAt: z.string().min(1),
  /** The board as approved, when change requests revised it; later stages read it as the job's IR. */
  ir: VideoIRSchema.optional(),
  revisions: z.array(GateRevision).optional(),
});
export type CreativeGateOutput = z.infer<typeof CreativeGateOutput>;

/** Approval scope of a creative gate. */
export const creativeGateScope = (gate: string): string => `gate:${gate}`;

/** What a reviewer asked to redo. */
export interface GateChange {
  approvalId: string;
  /** Asset ids of the board to regenerate. */
  targets: string[];
  note: string;
}

/** How a gate redoes the assets a reviewer named, owned by the pack that builds its board. */
export interface CreativeGateRevise {
  /** The board the reviewer saw before any change request. */
  initial(s: StageContext): VideoIR;
  /** Estimated cost of redoing `change`, checked against the job budget before the gate runs it. */
  estimateCostCents?(s: StageContext, change: GateChange): number | Promise<number>;
  /**
   * Regenerate `change.targets` of `base` (nothing else), then publish the revised board as a new project
   * version for the reviewer. Must be idempotent per change: when the revision was already published it
   * returns it without generating, so replaying earlier requests never pays again.
   */
  apply(
    s: StageContext,
    base: VideoIR,
    change: GateChange,
  ): Promise<{ ir: VideoIR; versionId: string; usage?: StageUsage[] }>;
}

export interface CreativeGateOptions {
  /** Gate id (`G0`, `G1`, ...); unique within the workflow. */
  gate: string;
  /** Stage name; defaults to `gate.<id>` in lower case. */
  name?: string;
  /** What the reviewer signs off, shown on the approval request. */
  summary: string;
  /** Lets a reviewer request changes to named assets of the board instead of only approving or rejecting. */
  revise?: CreativeGateRevise;
}

const changeOf = (a: Approval): GateChange | undefined =>
  a.status === "changes_requested" && a.changes
    ? { approvalId: a.id, targets: a.changes.targets, note: a.changes.note }
    : undefined;

/**
 * What a revision invalidated: every node of the reviewed board that depends on a target (the targets
 * included, even when kept as history), and every node the revised board removed, changed or added.
 */
function revisionInvalidated(before: VideoIR, after: VideoIR, targets: readonly string[]): string[] {
  const prev = nodeDigests(videoIrNodes(before));
  const next = nodeDigests(videoIrNodes(after));
  const removed = [...prev.keys()].filter((k) => !next.has(k));
  const dependents = dependentsOf(videoIrNodes(before), targets.map(nodeKey.asset));
  return [...new Set([...dependents, ...removed, ...invalidatedNodes(prev, next)])].sort();
}

/** Apply every change request of the gate so far, oldest first, each on the board the previous one left. */
async function reviseAll(
  s: StageContext,
  revise: CreativeGateRevise,
): Promise<{ ir: VideoIR; revisions: GateRevision[]; usage: StageUsage[] }> {
  let ir = revise.initial(s);
  const revisions: GateRevision[] = [];
  const usage: StageUsage[] = [];
  for (const change of (s.approvalHistory ?? []).flatMap((a) => changeOf(a) ?? [])) {
    const done = await revise.apply(s, ir, change);
    revisions.push({
      ...change,
      versionId: done.versionId,
      invalidated: revisionInvalidated(ir, done.ir, change.targets),
    });
    usage.push(...(done.usage ?? []));
    ir = done.ir;
  }
  return { ir, revisions, usage };
}

/**
 * A human sign-off between creative stages, built on the approval mechanism: the job parks with a
 * `creative.gate` request scoped `gate:<id>` (always required, whatever it costs), resumes once a signed-in
 * person approves it, and fails when they reject it. With `revise`, a reviewer may instead request changes
 * to named assets: the job redoes only those, publishes the revised board and asks the same gate again,
 * and the approved output carries the revised board and its revisions. The decision is checkpointed, so a
 * resumed job never asks again. It has no cache key: every job asks its own reviewer.
 */
export function createCreativeGateStage(options: CreativeGateOptions): StageDefinition {
  const gate = GateId.parse(options.gate);
  const scopeKey = creativeGateScope(gate);
  const reason = `${gate}: ${options.summary}`;
  const { revise } = options;
  return {
    name: options.name ?? `gate.${gate.toLowerCase()}`,
    outputSchema: CreativeGateOutput,
    approval: { action: "creative.gate", scopeKey, reason },
    // A gate that redraws calls providers, whose transient failures are worth a retry; the media journal
    // keeps a retry from paying again.
    retry: revise ? "default" : "never",
    estimateCostCents: (s) => {
      const change = s.approval ? changeOf(s.approval) : undefined;
      return change && revise?.estimateCostCents ? revise.estimateCostCents(s, change) : 0;
    },
    async run(s) {
      const approval = s.approval;
      const change = approval ? changeOf(approval) : undefined;
      if (change) {
        if (!revise) {
          // Nothing can be redone here: ask again, so the reviewer approves or rejects instead.
          throw new StageSuspended({
            kind: "approval",
            action: "creative.gate",
            scopeKey,
            reason: `${reason} (this gate cannot redo assets; approve or reject it)`,
          });
        }
        const { revisions, usage } = await reviseAll(s, revise);
        const last = revisions.at(-1) as GateRevision;
        throw new StageSuspended(
          {
            kind: "approval",
            action: "creative.gate",
            scopeKey,
            reason:
              `${reason} (revision ${revisions.length}: redid ${last.targets.join(", ")}; ` +
              `changed ${last.invalidated.join(", ")})`.slice(0, 1000),
          },
          usage,
        );
      }
      if (approval?.status !== "approved" || approval.decidedBy?.type !== "user") {
        // The default policy always requires creative gates; a policy that waives one is a misconfiguration.
        throw new StudixError("APPROVAL_REQUIRED", `${gate} needs a person's approval`, {
          retryable: false,
          details: { gate },
          suggestedAction: "Keep creative.gate in the approval policy's always-required actions.",
        });
      }
      const output: CreativeGateOutput = {
        gate,
        approvalId: approval.id,
        decidedBy: approval.decidedBy.id,
        decidedAt: (approval.decidedAt ?? new Date()).toISOString(),
      };
      const revised =
        revise && (s.approvalHistory ?? []).some((a) => changeOf(a)) ? await reviseAll(s, revise) : undefined;
      if (!revised) return { output };
      return {
        output: { ...output, ir: revised.ir, revisions: revised.revisions },
        usage: revised.usage,
      };
    },
  };
}
