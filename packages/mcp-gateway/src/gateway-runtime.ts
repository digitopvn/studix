import {
  type ApprovalPolicy,
  type ApprovalRepository,
  type AuditRepository,
  assertPermission,
  assertTenantContext,
  type Permission,
} from "@studix/core";
import { type ActivityRecorder, activeTraceIds } from "@studix/observability";
import { type Clock, createLogger, type Logger, newId, StudixError, systemClock } from "@studix/shared";
import { ToolCatalog } from "./catalog/tool-catalog.ts";
import { parseQualifiedToolName } from "./catalog/tool-normalizer.ts";
import {
  createSdkMcpClientAdapter,
  type DownstreamTarget,
  type McpClientAdapter,
} from "./client/mcp-client-adapter.ts";
import {
  createCallBudget,
  type GatewayBudget,
  WorkspaceConcurrencyLimiter,
} from "./execution/execution-limits.ts";
import type { GatewayCallContext } from "./execution/gateway-call-context.ts";
import type { LargeResultStore } from "./execution/tool-result-capper.ts";
import {
  DEFAULT_GATEWAY_LIMITS,
  type GatewayConfig,
  type GatewayLimits,
  loadGatewayConfig,
} from "./gateway-config.ts";
import type { Connector, ConnectorRepository, ConnectorTool } from "./registry/connector-types.ts";
import { type SecretResolver, sanitizeOutboundCredential } from "./secrets/secret-resolver.ts";
import { type ConnectorUrlPolicy, createConnectorUrlPolicy } from "./url-policy/connector-url-policy.ts";

export interface McpGatewayDeps {
  connectors: ConnectorRepository;
  approvals: ApprovalRepository;
  audit: AuditRepository;
  approvalPolicy: ApprovalPolicy;
  secrets: SecretResolver;
  /** Defaults to `loadGatewayConfig()` (environment). */
  config?: GatewayConfig;
  /** Overrides applied on top of `config.limits`. */
  limits?: Partial<GatewayLimits>;
  /** Defaults to a policy built from `config` (insecure hosts, self origins, system DNS). */
  urlPolicy?: ConnectorUrlPolicy;
  /** Defaults to the MCP SDK Streamable HTTP adapter over the pinned fetch. */
  client?: McpClientAdapter;
  /** Defaults to an in-process call-count budget. */
  budget?: GatewayBudget;
  resultStore?: LargeResultStore;
  activity?: ActivityRecorder;
  logger?: Logger;
  clock?: Clock;
}

/** Fully-resolved dependencies shared by the discovery, execution and admin services. */
export interface GatewayRuntime {
  connectors: ConnectorRepository;
  approvals: ApprovalRepository;
  audit: AuditRepository;
  approvalPolicy: ApprovalPolicy;
  secrets: SecretResolver;
  limits: GatewayLimits;
  urlPolicy: ConnectorUrlPolicy;
  client: McpClientAdapter;
  budget: GatewayBudget;
  resultStore?: LargeResultStore;
  activity?: ActivityRecorder;
  logger: Logger;
  clock: Clock;
  catalog: ToolCatalog;
  concurrency: WorkspaceConcurrencyLimiter;
}

export function createGatewayRuntime(deps: McpGatewayDeps): GatewayRuntime {
  const config = deps.config ?? loadGatewayConfig();
  const limits: GatewayLimits = { ...DEFAULT_GATEWAY_LIMITS, ...config.limits, ...deps.limits };
  const clock = deps.clock ?? systemClock;
  const urlPolicy =
    deps.urlPolicy ??
    createConnectorUrlPolicy({ insecureHosts: config.insecureHosts, selfOrigins: config.selfOrigins });
  return {
    connectors: deps.connectors,
    approvals: deps.approvals,
    audit: deps.audit,
    approvalPolicy: deps.approvalPolicy,
    secrets: deps.secrets,
    limits,
    urlPolicy,
    client:
      deps.client ??
      createSdkMcpClientAdapter({ policy: urlPolicy, maxResponseBytes: limits.maxResponseBytes }),
    budget: deps.budget ?? createCallBudget({ clock }),
    ...(deps.resultStore ? { resultStore: deps.resultStore } : {}),
    ...(deps.activity ? { activity: deps.activity } : {}),
    logger: deps.logger ?? createLogger({ component: "mcp-gateway" }),
    clock,
    catalog: new ToolCatalog({ ttlMs: limits.catalogTtlMs, maxSummaryChars: limits.maxSummaryChars, clock }),
    concurrency: new WorkspaceConcurrencyLimiter(limits.maxConcurrentPerWorkspace),
  };
}

/** Validate the call context at the boundary and check the actor's permission. */
export function authorizeCall(call: GatewayCallContext, permission: Permission): void {
  assertTenantContext(call?.tenant);
  assertPermission(call.tenant, permission);
}

/** Trace id of the active span, or a fresh correlation id when no tracing SDK is registered. */
export function currentTraceId(): string {
  return activeTraceIds()?.traceId ?? newId("trace");
}

/** Look up a qualified tool in the caller's workspace (fresh read; never from a cache). */
export async function loadConnectorTool(
  rt: GatewayRuntime,
  call: GatewayCallContext,
  qualified: string,
): Promise<{ connector: Connector; tool: ConnectorTool }> {
  const { connector: connectorName, tool: toolName } = parseQualifiedToolName(qualified);
  const connector = await rt.connectors.getByName(call.tenant, connectorName);
  const tool = connector?.tools.find((t) => t.name === toolName);
  if (!connector || !tool) {
    throw new StudixError("NOT_FOUND", `Tool ${qualified} not found`, {
      suggestedAction: "Use studix_tool_search to find available tools.",
    });
  }
  return { connector, tool };
}

/** Build the outbound target: URL + credential from the connector's own secretRef, nothing inbound. */
export async function downstreamTarget(
  rt: GatewayRuntime,
  call: GatewayCallContext,
  connector: Connector,
): Promise<DownstreamTarget> {
  const credential = connector.secretRef
    ? sanitizeOutboundCredential(
        await rt.secrets.resolve(
          call.tenant,
          { connectorId: connector.id, connectorName: connector.name, url: connector.url },
          connector.secretRef,
        ),
      )
    : undefined;
  return { url: connector.url, ...(credential ? { credential } : {}), depth: call.depth ?? 0 };
}
