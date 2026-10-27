import { createDefaultApprovalPolicy, type TenantContext } from "@studix/core";
import {
  createInMemoryActivityRepository,
  createInMemoryApprovalRepository,
  createInMemoryAuditRepository,
  testTenant,
} from "@studix/core/testing";
import { createActivityRecorder } from "@studix/observability";
import { createLogger, createManualClock } from "@studix/shared";
import type { McpClientAdapter } from "../src/client/mcp-client-adapter.ts";
import type { GatewayCallContext } from "../src/execution/gateway-call-context.ts";
import { DEFAULT_GATEWAY_LIMITS, type GatewayConfig, type GatewayLimits } from "../src/gateway-config.ts";
import type { McpGatewayDeps } from "../src/gateway-runtime.ts";
import { createMcpGateway } from "../src/mcp-gateway.ts";
import type { ConnectorRepository } from "../src/registry/connector-types.ts";
import { createInMemoryConnectorRepository, createStaticSecretResolver } from "../src/testing/index.ts";
import type { ConnectorUrlPolicy } from "../src/url-policy/connector-url-policy.ts";

/** Values that must never appear in any gateway output, log, audit or activity record. */
export const OUTBOUND_TOKEN = "mock-outbound-token-0f3c9a7e51";
export const SECRET_REF = "vault:connector/mock-brand-secret";
export const INBOUND_KEY = "stx_test_inboundKeyMustNeverLeave01";

export interface HarnessOptions {
  client?: McpClientAdapter;
  urlPolicy?: ConnectorUrlPolicy;
  limits?: Partial<GatewayLimits>;
  config?: Partial<GatewayConfig>;
  connectors?: ConnectorRepository;
  extra?: Partial<McpGatewayDeps>;
}

/** In-memory wiring of the gateway with two tenants, captured logs and a static secret resolver. */
export function createGatewayHarness(options: HarnessOptions = {}) {
  const clock = createManualClock(new Date("2026-10-27T10:00:00Z"));
  const logs: string[] = [];
  const logger = createLogger(
    { component: "mcp-gateway-test" },
    { level: "debug", write: (line) => logs.push(line) },
  );
  const approvals = createInMemoryApprovalRepository(clock);
  const audit = createInMemoryAuditRepository(clock);
  const activityRepo = createInMemoryActivityRepository(clock);
  const connectors = options.connectors ?? createInMemoryConnectorRepository(clock);
  const tenantA = testTenant();
  const tenantB = testTenant({ organizationId: tenantA.organizationId });
  const secrets = createStaticSecretResolver({ [tenantA.workspaceId]: { [SECRET_REF]: OUTBOUND_TOKEN } });
  const gateway = createMcpGateway({
    connectors,
    approvals,
    audit,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
    secrets,
    config: {
      limits: DEFAULT_GATEWAY_LIMITS,
      insecureHosts: ["127.0.0.1"],
      selfOrigins: ["https://app.studix.test"],
      ...options.config,
    },
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.urlPolicy ? { urlPolicy: options.urlPolicy } : {}),
    ...(options.client ? { client: options.client } : {}),
    activity: createActivityRecorder(activityRepo, { logger }),
    logger,
    clock,
    ...options.extra,
  });
  const call = (tenant: TenantContext, extra: Partial<GatewayCallContext> = {}): GatewayCallContext => ({
    tenant,
    ...extra,
  });
  return {
    clock,
    logs,
    approvals,
    audit,
    activityRepo,
    connectors,
    secrets,
    gateway,
    tenantA,
    tenantB,
    call,
  };
}

export type GatewayHarness = ReturnType<typeof createGatewayHarness>;

/** Everything a client, operator or log reader could see, serialized for leak scanning. */
export async function observableSurface(h: GatewayHarness, outputs: unknown[]): Promise<string> {
  const audits = [
    ...(await h.audit.list(h.tenantA, { limit: 100 })).items,
    ...(await h.audit.list(h.tenantB, { limit: 100 })).items,
  ];
  const activity = [
    ...(await h.activityRepo.list(h.tenantA, { limit: 100 })).items,
    ...(await h.activityRepo.list(h.tenantB, { limit: 100 })).items,
  ];
  return JSON.stringify({ outputs, audits, activity, logs: h.logs });
}

/** Run a promise expected to reject and return the error payload. */
export async function rejection(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; details?: Record<string, unknown>; retryable: boolean }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown>; retryable: boolean };
  }
  throw new Error("expected the promise to reject");
}
