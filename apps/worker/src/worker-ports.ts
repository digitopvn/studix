import { createDefaultApprovalPolicy } from "@studix/core";
import { createRepositories } from "@studix/database";
import { createDecisionRouterFromConfig, RulesAdapter } from "@studix/decision-routing";
import { createEnvSecretResolver, createMcpGateway, loadGatewayConfig } from "@studix/mcp-gateway";
import { createActivityRecorder } from "@studix/observability";
import { HyperFramesRenderer, renderToolchain } from "@studix/renderers";
import { createS3StorageAdapterFromConfig } from "@studix/storage";
import { type BrandLookup, createGatewayBrandLookup } from "./planner/brand-lookup-enrichment.ts";
import { registerBriefRule } from "./planner/brief-decision.ts";
import { createExecutionSink } from "./planner/execution-sink.ts";
import { createVideoPlanner } from "./planner/video-planner.ts";
import type { WorkerPorts } from "./wiring.ts";
import type { WorkerPortsRuntime } from "./worker-process.ts";
import type { WorkerSettings } from "./worker-settings.ts";

/** Brand lookup through the workspace's MCP connectors, built only when STUDIX_BRAND_LOOKUP_TOOL is set. */
function gatewayBrandLookup(settings: WorkerSettings, runtime: WorkerPortsRuntime): BrandLookup | undefined {
  if (!settings.brandLookupTool) return undefined;
  const { logger } = runtime;
  const repos = createRepositories(runtime.db);
  const gateway = createMcpGateway({
    connectors: repos.connectors,
    approvals: repos.approvals,
    audit: repos.audit,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: settings.approvalCostThresholdCents }),
    secrets: createEnvSecretResolver({ env: runtime.env }),
    activity: createActivityRecorder(repos.activity, { logger }),
    config: loadGatewayConfig(runtime.env),
    logger: logger.child({ component: "mcp-gateway" }),
  });
  return createGatewayBrandLookup({ gateway, tool: settings.brandLookupTool, logger });
}

/**
 * Production adapters for the standalone worker: S3-compatible storage, the HyperFrames renderer and
 * the brief planner (DecisionRouter for `video.brief` with a deterministic rules fallback, optional
 * connector brand lookup). Misconfiguration (no bucket, bad decision routes) fails startup loudly.
 */
export async function loadWorkerPorts(
  settings: WorkerSettings,
  runtime: WorkerPortsRuntime,
): Promise<WorkerPorts> {
  const { config } = settings;
  const { logger } = runtime;
  const storage = createS3StorageAdapterFromConfig(config);
  const toolchain = renderToolchain(runtime.env);
  if (!toolchain.ok) {
    logger.warn("render toolchain incomplete; render stages will fail until it is installed", {
      reason: toolchain.reason,
    });
  }
  const renderer = new HyperFramesRenderer({
    ffmpegPath: config.FFMPEG_PATH,
    ffprobePath: config.FFPROBE_PATH,
    logger: logger.child({ component: "hyperframes-renderer" }),
  });
  const rules = registerBriefRule(new RulesAdapter({ logger }));
  const { usage } = createRepositories(runtime.db);
  const decisions = createDecisionRouterFromConfig(runtime.env, {
    rules,
    logger,
    sink: createExecutionSink(usage),
  });
  const brandLookup = gatewayBrandLookup(settings, runtime);
  logger.info("worker adapters ready", {
    storage: "s3",
    renderer: renderer.id,
    brandLookup: settings.brandLookupTool ?? "off",
  });
  return {
    planner: createVideoPlanner({ decisions, brandLookup, logger }),
    renderer,
    storage,
    close: async () => storage.destroy(),
  };
}
