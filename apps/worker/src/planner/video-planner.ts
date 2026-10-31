import { resolveWorkflowPack } from "@studix/core";
import type { DecisionProvider } from "@studix/decision-routing";
import { type Logger, StudixError } from "@studix/shared";
import { applyBriefDraft, needsBriefDraft, type PackRegistry, packRegistry } from "@studix/skills";
import type { Planner, PlanUsage } from "@studix/workflow";
import { applyBrandFacts, type BrandLookup } from "./brand-lookup-enrichment.ts";
import { type BriefDecisionOptions, decideBriefDraft } from "./brief-decision.ts";

export interface VideoPlannerDeps {
  /** DecisionRouter (route `video.brief`, e.g. `openrouter>rules`) used only when the brief is prompt-only. */
  decisions: Pick<DecisionProvider, "decide">;
  /** Optional workspace-connector brand lookup; failures never fail the plan. */
  brandLookup?: BrandLookup;
  logger: Logger;
  briefDecision?: BriefDecisionOptions;
  /** Where `workflowTemplate` packs are looked up (default: the process-wide registry). */
  packs?: Pick<PackRegistry, "packs">;
}

/**
 * Brief -> IR with the job's workflow pack (brand intro by default). A prompt-only brief is first turned
 * into a structured brief by one decision (model or deterministic rules); a drafted brand is optionally
 * enriched from a connector; the IR itself is built by the pack's deterministic template, so there is no
 * second model call.
 */
export function createVideoPlanner(deps: VideoPlannerDeps): Planner {
  const log = deps.logger.child({ component: "video-planner" });
  const packs = deps.packs ?? packRegistry;
  return async (brief, ctx, signal) => {
    // Resolved first, so an unknown pack fails the job before any decision is paid for.
    const template = resolveWorkflowPack(packs, ctx.workflowTemplate).templates[0];
    if (!template) {
      throw new StudixError("VALIDATION", `workflow pack ${ctx.workflowTemplate} has no template`, {
        retryable: false,
      });
    }
    const usage: PlanUsage[] = [];
    let planned = brief;
    if (needsBriefDraft(brief)) {
      const decided = await decideBriefDraft(deps.decisions, brief, ctx, signal, deps.briefDecision);
      usage.push(decided.usage);
      if (decided.fallbackReason) {
        log.warn("brief decision fell back", {
          jobId: ctx.jobId,
          provider: decided.usage.provider,
          reason: decided.fallbackReason,
        });
      }
      planned = applyBriefDraft(brief, decided.draft);
      // Only a brand the planner drafted is enriched; a brand kit the user supplied is authoritative.
      if (planned.brand && deps.brandLookup) {
        const facts = await deps.brandLookup(planned.brand.name, ctx, signal);
        if (facts) planned = applyBrandFacts(planned, facts);
      }
    }
    signal.throwIfAborted();
    const ir = template.run(planned);
    log.info("video planned", {
      jobId: ctx.jobId,
      template: template.id,
      scenes: ir.scenes.length,
      durationMs: ir.format.durationMs,
      decisions: usage.length,
    });
    return { ir, usage };
  };
}
