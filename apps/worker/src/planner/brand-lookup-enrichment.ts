import { type McpGateway, parseQualifiedToolName } from "@studix/mcp-gateway";
import { type Logger, toStudixError } from "@studix/shared";
import { normalizeText, truncateText } from "@studix/skills";
import type { BrandPalette, CreativeBrief } from "@studix/video-ir";
import type { PlannerContext } from "@studix/workflow";
import { z } from "zod";

/** Brand facts a workspace connector may supply (colors and tagline); everything is optional. */
export interface BrandFacts {
  tagline?: string;
  colors: { primary?: string; secondary?: string; accent?: string };
}

/** Looks up brand facts by name. Resolves undefined when nothing usable came back; never throws. */
export type BrandLookup = (
  name: string,
  ctx: PlannerContext,
  signal: AbortSignal,
) => Promise<BrandFacts | undefined>;

const Hex6 = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** Third-party output is untrusted: only well-formed fields are kept, anything else is ignored. */
const BrandFactsOutput = z.object({
  tagline: z.string().min(1).max(500).optional().catch(undefined),
  colors: z
    .object({
      primary: Hex6.optional().catch(undefined),
      secondary: Hex6.optional().catch(undefined),
      accent: Hex6.optional().catch(undefined),
    })
    .catch({}),
});

function firstJsonText(content: Array<Record<string, unknown>>): unknown {
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    try {
      return JSON.parse(block.text);
    } catch {
      // Not JSON; keep looking.
    }
  }
  return undefined;
}

/**
 * Brand lookup through a workspace connector tool (qualified `connector.tool`, e.g. `brand.brand_lookup`)
 * via McpGateway.execute, which re-authorizes, applies URL policy and limits, and records the trace.
 * Absence, denial, errors and suspicious or malformed output only skip the enrichment.
 */
export function createGatewayBrandLookup(options: {
  gateway: Pick<McpGateway, "execute">;
  tool: string;
  logger: Logger;
}): BrandLookup {
  parseQualifiedToolName(options.tool);
  const log = options.logger.child({ component: "brand-lookup", tool: options.tool });
  return async (name, ctx, signal) => {
    try {
      const { data, traceId } = await options.gateway.execute(
        { tenant: ctx.tenant, jobId: ctx.jobId, projectId: ctx.projectId, depth: 0 },
        { tool: options.tool, arguments: { name } },
      );
      const out = data.result;
      if (
        data.outcome !== "succeeded" ||
        out.isError ||
        out.truncated ||
        out.flags.includes("suspicious-instructions")
      ) {
        log.warn("brand lookup returned no usable result", {
          traceId,
          outcome: data.outcome,
          flags: out.flags,
        });
        return undefined;
      }
      const parsed = BrandFactsOutput.safeParse(out.structuredContent ?? firstJsonText(out.content));
      if (!parsed.success) {
        log.warn("brand lookup result has an unexpected shape", { traceId });
        return undefined;
      }
      log.info("brand facts found", { traceId, jobId: ctx.jobId });
      return parsed.data;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const err = toStudixError(error);
      log.warn("brand lookup failed; planning continues without it", {
        jobId: ctx.jobId,
        code: err.code,
        error: err.message,
      });
      return undefined;
    }
  };
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of two #rrggbb colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Merge looked-up facts into a drafted brand kit. Colors are taken only when on-screen text stays readable
 * (primary is a scene background under foreground text, accent is the wordmark on primary); a tagline
 * the brief already has is kept.
 */
export function applyBrandFacts(brief: CreativeBrief, facts: BrandFacts): CreativeBrief {
  if (!brief.brand) return brief;
  const palette: BrandPalette = { ...brief.brand.palette };
  const { primary, secondary, accent } = facts.colors;
  if (primary && contrastRatio(primary, palette.foreground.slice(0, 7)) >= 3) palette.primary = primary;
  if (secondary) palette.secondary = secondary;
  if (accent && contrastRatio(accent, palette.primary.slice(0, 7)) >= 1.5) palette.accent = accent;
  const tagline =
    brief.brand.tagline ?? (facts.tagline ? truncateText(normalizeText(facts.tagline), 120) : undefined);
  return { ...brief, brand: { ...brief.brand, palette, ...(tagline ? { tagline } : {}) } };
}
