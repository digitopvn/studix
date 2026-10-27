import type { DecisionProvider } from "@studix/decision-routing";
import type { Logger } from "@studix/shared";
import { applyBriefDraft, brandIntroTemplate, needsBriefDraft } from "@studix/skills";
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
}

/**
 * Brief -> brand-intro IR. A prompt-only brief is first turned into a structured brief by one decision
 * (model or deterministic rules); a drafted brand is optionally enriched from a connector; the IR itself
 * is always built by the deterministic brand-intro template, so there is no second model call.
 */
export function createVideoPlanner(deps: VideoPlannerDeps): Planner {
  const log = deps.logger.child({ component: "video-planner" });
  return async (brief, ctx, signal) => {
    const usage: PlanUsage[] = [];
    let planned = brief;
    if (needsBriefDraft(brief)) {
      const decided = await decideBriefDraft(deps.decisions, brief, ctx, signal, deps.briefDecision);
      if (decided.usage) usage.push(decided.usage);
      if (decided.fallbackReason) {
        log.warn("brief decision fell back", {
          jobId: ctx.jobId,
          provider: decided.usage?.provider,
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
    const ir = brandIntroTemplate(planned);
    log.info("video planned", {
      jobId: ctx.jobId,
      scenes: ir.scenes.length,
      durationMs: ir.format.durationMs,
      decisions: usage.length,
    });
    return { ir, usage };
  };
}
