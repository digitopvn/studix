import { testTenant } from "@studix/core/testing";
import { DecisionRouter, FakeDecisionAdapter, RulesAdapter } from "@studix/decision-routing";
import type { McpGateway, ToolExecuteData } from "@studix/mcp-gateway";
import { createLogger, StudixError } from "@studix/shared";
import type { PlannerContext } from "@studix/workflow";
import { describe, expect, it } from "vitest";
import {
  applyBrandFacts,
  contrastRatio,
  createGatewayBrandLookup,
} from "../src/planner/brand-lookup-enrichment.ts";
import { registerBriefRule } from "../src/planner/brief-decision.ts";
import { createVideoPlanner } from "../src/planner/video-planner.ts";

const logger = createLogger({}, { write: () => {} });
const PROMPT =
  "Video giới thiệu thương hiệu cà phê Sương Mai cho khách hàng trẻ, dài 6 giây, dọc.\nRang mới mỗi tuần. Giao tận nơi trong 24 giờ.";

function ctx(over: Partial<PlannerContext> = {}): PlannerContext {
  return {
    tenant: testTenant(),
    jobId: "job_1",
    projectId: "prj_1",
    attempt: 1,
    requestedBy: { type: "system", id: "test" },
    ...over,
  };
}

function rulesRouter(model?: FakeDecisionAdapter): DecisionRouter {
  const rules = registerBriefRule(new RulesAdapter());
  const providers = model ? [model, rules] : [rules];
  return new DecisionRouter({
    providers,
    routes: { "video.brief": providers.map((p) => p.id) },
    maxAttemptsPerProvider: 1,
  });
}

describe("brief decision replay", () => {
  it("keeps the original usage and execution id when a retry is served from the cache", async () => {
    const planner = createVideoPlanner({
      decisions: rulesRouter(
        new FakeDecisionAdapter({
          id: "model",
          fallback: { output: { brandName: "Sương Mai", keyMessages: ["Rang mới mỗi tuần"] }, costCents: 2 },
        }),
      ),
      logger,
    });
    const brief = { prompt: PROMPT } as Parameters<typeof planner>[0];
    const tenant = testTenant();
    const first = await planner(brief, ctx({ tenant }), new AbortController().signal);
    const retry = await planner(brief, ctx({ tenant, attempt: 2 }), new AbortController().signal);
    expect(first.usage).toHaveLength(1);
    expect(first.usage[0]?.costCents).toBe(2);
    expect(retry.usage).toEqual(first.usage);
    expect(retry.ir).toEqual(first.ir);
  });
});

type ExecuteResult = Awaited<ReturnType<McpGateway["execute"]>>;
function gatewayReturning(
  result: Partial<ToolExecuteData["result"]>,
  outcome: ToolExecuteData["outcome"] = "succeeded",
) {
  const calls: unknown[] = [];
  const gateway: Pick<McpGateway, "execute"> = {
    async execute(call, input) {
      calls.push({ call, input });
      return {
        traceId: "trc_1",
        next: [],
        data: {
          tool: "brand.brand_lookup",
          connector: "brand",
          outcome,
          mutating: false,
          attempts: 1,
          latencyMs: 3,
          result: {
            untrusted: true,
            source: "brand",
            notice: "",
            isError: false,
            content: [],
            flags: [],
            truncated: false,
            originalBytes: 10,
            resultBytes: 10,
            ...result,
          },
        },
      } satisfies ExecuteResult;
    },
  };
  return { gateway, calls };
}

const SUONG_MAI = {
  name: "Sương Mai",
  tagline: "Đánh thức buổi sáng",
  colors: { primary: "#5B3A29", secondary: "#F3E6D3", accent: "#C8873A" },
};

describe("video planner", () => {
  it("drafts a prompt-only brief with the rules fallback and builds the IR without a model", async () => {
    const planner = createVideoPlanner({ decisions: rulesRouter(), logger });
    const { ir, usage } = await planner({ prompt: PROMPT }, ctx(), new AbortController().signal);
    expect(ir.brand?.name).toBe("Sương Mai");
    expect(ir.format.durationMs).toBe(6000);
    expect(ir.format.aspectRatio).toBe("9:16");
    expect(usage).toEqual([
      expect.objectContaining({ provider: "rules", model: "rules", costCents: 0, operation: "video.brief" }),
    ]);
  });

  it("falls back to rules when the model provider fails and records the fallback provider", async () => {
    const model = new FakeDecisionAdapter({
      id: "openrouter",
      fallback: { error: new StudixError("UNAVAILABLE", "down", { retryable: true }) },
    });
    const planner = createVideoPlanner({ decisions: rulesRouter(model), logger });
    const { ir, usage } = await planner({ prompt: PROMPT }, ctx(), new AbortController().signal);
    expect(model.calls).toHaveLength(1);
    expect(usage[0]?.provider).toBe("rules");
    expect(ir.brand?.name).toBe("Sương Mai");
  });

  it("skips the decision when the brief is already structured", async () => {
    const model = new FakeDecisionAdapter({ id: "openrouter" });
    const planner = createVideoPlanner({ decisions: rulesRouter(model), logger });
    const { usage } = await planner(
      { prompt: "x", keyMessages: ["Một", "Hai"] },
      ctx(),
      new AbortController().signal,
    );
    expect(usage).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });

  it("enriches a drafted brand from the connector lookup", async () => {
    const { gateway, calls } = gatewayReturning({ structuredContent: SUONG_MAI });
    const brandLookup = createGatewayBrandLookup({ gateway, tool: "brand.brand_lookup", logger });
    const planner = createVideoPlanner({ decisions: rulesRouter(), brandLookup, logger });
    const { ir } = await planner({ prompt: PROMPT }, ctx(), new AbortController().signal);
    expect(calls[0]).toMatchObject({
      call: { jobId: "job_1", projectId: "prj_1", depth: 0 },
      input: { tool: "brand.brand_lookup", arguments: { name: "Sương Mai" } },
    });
    expect(ir.brand?.palette).toMatchObject({ primary: "#5B3A29", accent: "#C8873A", secondary: "#F3E6D3" });
    expect(ir.brand?.tagline).toBe("Đánh thức buổi sáng");
  });
});

describe("gateway brand lookup", () => {
  const signal = new AbortController().signal;

  it("ignores tool errors, suspicious output and malformed colors", async () => {
    for (const result of [
      { isError: true, structuredContent: SUONG_MAI },
      { flags: ["suspicious-instructions" as const], structuredContent: SUONG_MAI },
      { truncated: true, structuredContent: SUONG_MAI },
    ]) {
      const { gateway } = gatewayReturning(result);
      expect(
        await createGatewayBrandLookup({ gateway, tool: "brand.lookup", logger })("x", ctx(), signal),
      ).toBe(undefined);
    }
    const { gateway } = gatewayReturning({
      content: [{ type: "text", text: JSON.stringify({ colors: { primary: "red", accent: "#C8873A" } }) }],
    });
    const facts = await createGatewayBrandLookup({ gateway, tool: "brand.lookup", logger })(
      "x",
      ctx(),
      signal,
    );
    expect(facts).toEqual({ colors: { accent: "#C8873A" } });
  });

  it("never fails the plan when the gateway throws (denied, unreachable)", async () => {
    const gateway: Pick<McpGateway, "execute"> = {
      execute: async () => {
        throw new StudixError("FORBIDDEN", "tool-not-granted");
      },
    };
    const lookup = createGatewayBrandLookup({ gateway, tool: "brand.brand_lookup", logger });
    expect(await lookup("Sương Mai", ctx(), signal)).toBeUndefined();
  });

  it("rejects an unqualified tool name at wiring time", () => {
    const { gateway } = gatewayReturning({});
    expect(() => createGatewayBrandLookup({ gateway, tool: "brand_lookup", logger })).toThrow();
  });
});

describe("applyBrandFacts", () => {
  it("keeps a primary color that would make the foreground text unreadable", () => {
    const brief = {
      prompt: "p",
      brand: {
        name: "B",
        palette: { primary: "#2563EB", background: "#0B1020", foreground: "#F8FAFC" },
        fonts: { heading: "Be Vietnam Pro", body: "Be Vietnam Pro" },
      },
    };
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 0);
    const out = applyBrandFacts(brief, { colors: { primary: "#FFFFF0" } });
    expect(out.brand?.palette.primary).toBe("#2563EB");
    expect(applyBrandFacts(brief, { colors: { primary: "#5B3A29" } }).brand?.palette.primary).toBe("#5B3A29");
  });
});
