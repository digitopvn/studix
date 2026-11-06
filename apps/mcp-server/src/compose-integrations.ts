import {
  type AgentHandoffService,
  type AgentOutputValidator,
  type ApprovalPolicy,
  createAgentHandoffService,
  createExternalSkillService,
  type ExternalSkillService,
} from "@studix/core";
import type { createRepositories } from "@studix/database";
import { createEnvSecretResolver, createMcpGateway, loadGatewayConfig } from "@studix/mcp-gateway";
import type { ActivityRecorder } from "@studix/observability";
import { type Logger, type StudixConfig, StudixError } from "@studix/shared";
import { createGitHubSkillSource, listSkills, type PackRegistry, packRegistry } from "@studix/skills";
import { createS3StorageAdapterFromConfig, type S3StorageAdapter } from "@studix/storage";
import { createConnectorAdminAdapter } from "./connector-admin-adapter.ts";
import { createGatewayMetaTools } from "./mcp/gateway-meta-tools.ts";
import type { ConnectorAdmin, RegisterMetaTools, SkillSummary } from "./ports.ts";

export interface Integrations {
  /** Present when S3_BUCKET is configured; signs playback URLs. */
  storage?: S3StorageAdapter;
  connectors: ConnectorAdmin;
  metaTools: RegisterMetaTools;
  skills: SkillSummary[];
  /** Host-agent handoff of agent stages (the studix_*_agent_task tools). */
  agentHandoffs: AgentHandoffService;
  /** Skills imported from public GitHub repositories (the studix_skill_* tools). */
  externalSkills: ExternalSkillService;
}

/** Workflow templates from the skills registry, as advertised by `studix_inspect`. */
export function skillSummaries(): SkillSummary[] {
  return listSkills().map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    version: s.version,
  }));
}

/**
 * Checks a host agent's output against the output schema of the registered pack stage, the schema the
 * worker applies too. A stage this server does not know is UNAVAILABLE (server and worker out of step).
 */
export function packStageOutputValidator(registry: PackRegistry = packRegistry): AgentOutputValidator {
  return (stage, output) => {
    const schema = registry.stage(stage)?.outputSchema;
    if (!schema) {
      throw new StudixError("UNAVAILABLE", `Stage ${stage} is not registered on this server`, {
        details: { stage },
      });
    }
    const parsed = schema.safeParse(output);
    if (parsed.success) return { ok: true, output: parsed.data as Record<string, unknown> };
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    };
  };
}

/** Media origins for the dashboard CSP: the client-facing S3 origin, plus subdomains for virtual-hosted buckets. */
export function storageMediaOrigins(config: StudixConfig): string[] {
  const endpoint = config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT;
  if (!endpoint) return [];
  const url = new URL(endpoint);
  return config.S3_FORCE_PATH_STYLE ? [url.origin] : [url.origin, `${url.protocol}//*.${url.host}`];
}

/**
 * Adapters from other packages: S3 artifact signing, the MCP gateway (connector admin and meta-tools on
 * `/mcp`) and the skills registry. Bad gateway or storage configuration fails startup.
 */
export function composeIntegrations(input: {
  env: NodeJS.ProcessEnv;
  config: StudixConfig;
  repos: ReturnType<typeof createRepositories>;
  approvalPolicy: ApprovalPolicy;
  activity: ActivityRecorder;
  logger: Logger;
}): Integrations {
  const { config, repos, logger } = input;
  const gatewayConfig = loadGatewayConfig(input.env);
  // The resolved public/app URLs (with their localhost defaults) are self origins too.
  const selfOrigins = [config.STUDIX_PUBLIC_URL, config.STUDIX_APP_URL].map((u) => new URL(u).origin);
  const gateway = createMcpGateway({
    connectors: repos.connectors,
    approvals: repos.approvals,
    audit: repos.audit,
    approvalPolicy: input.approvalPolicy,
    secrets: createEnvSecretResolver({ env: input.env }),
    activity: input.activity,
    config: { ...gatewayConfig, selfOrigins: [...new Set([...gatewayConfig.selfOrigins, ...selfOrigins])] },
    logger: logger.child({ component: "mcp-gateway" }),
  });
  const storage = config.S3_BUCKET ? createS3StorageAdapterFromConfig(config) : undefined;
  return {
    ...(storage ? { storage } : {}),
    connectors: createConnectorAdminAdapter({ admin: gateway.connectors, connectors: repos.connectors }),
    metaTools: createGatewayMetaTools(gateway),
    skills: skillSummaries(),
    agentHandoffs: createAgentHandoffService({
      handoffs: repos.agentHandoffs,
      validateOutput: packStageOutputValidator(),
    }),
    externalSkills: createExternalSkillService({
      skills: repos.externalSkills,
      source: createGitHubSkillSource({ token: config.STUDIX_GITHUB_API_TOKEN }),
      ...(storage ? { storage } : {}),
    }),
  };
}
