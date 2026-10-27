import { performance } from "node:perf_hooks";
import { actorRef } from "@studix/core";
import { redact, redactDeep, StudixError, toStudixError } from "@studix/shared";
import { z } from "zod";
import { CONNECTOR_NAME_PATTERN, normalizeTools } from "../catalog/tool-normalizer.ts";
import { parseInput } from "../discovery/tool-discovery-service.ts";
import type { GatewayCallContext } from "../execution/gateway-call-context.ts";
import { authorizeCall, downstreamTarget, type GatewayRuntime } from "../gateway-runtime.ts";
import {
  EMPTY_TOOL_POLICY,
  GATEWAY_PERMISSIONS,
  validateToolPolicy,
} from "../policy/tool-permission-policy.ts";
import {
  type Connector,
  type ConnectorPatch,
  type ConnectorTestResult,
  type ConnectorView,
  type ToolPolicy,
  toConnectorView,
} from "../registry/connector-types.ts";

export const AddConnectorInput = z.object({
  name: z
    .string()
    .regex(CONNECTOR_NAME_PATTERN, "lowercase letters, digits, _ or -, 2-40 chars, starting with a letter"),
  url: z.string().min(8).max(2048),
  secretRef: z
    .string()
    .regex(/^[A-Za-z0-9:_./-]{1,200}$/)
    .optional(),
  toolPolicy: z.unknown().optional(),
});
export type AddConnectorInput = z.input<typeof AddConnectorInput>;

/** Workspace-admin operations on the connector registry. Every change bumps the version (cache invalidation). */
export interface ConnectorAdmin {
  add(call: GatewayCallContext, input: AddConnectorInput): Promise<ConnectorView>;
  /** Connect, list tools, store the bounded catalog and the test result ("test/refresh"). */
  refresh(
    call: GatewayCallContext,
    id: string,
  ): Promise<{ connector: ConnectorView; result: ConnectorTestResult }>;
  enable(call: GatewayCallContext, id: string): Promise<ConnectorView>;
  disable(call: GatewayCallContext, id: string): Promise<ConnectorView>;
  setToolPolicy(call: GatewayCallContext, id: string, policy: ToolPolicy): Promise<ConnectorView>;
  /** Terminal: drops the credential reference and catalog; a revoked connector cannot be re-enabled. */
  revoke(call: GatewayCallContext, id: string): Promise<ConnectorView>;
  list(call: GatewayCallContext): Promise<ConnectorView[]>;
  get(call: GatewayCallContext, id: string): Promise<ConnectorView>;
}

export function createConnectorAdmin(rt: GatewayRuntime): ConnectorAdmin {
  const load = async (call: GatewayCallContext, id: string): Promise<Connector> => {
    const connector = await rt.connectors.get(call.tenant, id);
    if (!connector) throw new StudixError("NOT_FOUND", `Connector ${id} not found`);
    return connector;
  };

  const change = async (
    call: GatewayCallContext,
    id: string,
    action: string,
    patch: (current: Connector) => ConnectorPatch,
  ): Promise<ConnectorView> => {
    authorizeCall(call, GATEWAY_PERMISSIONS.manage);
    const current = await load(call, id);
    const updated = await rt.connectors.update(call.tenant, id, patch(current));
    rt.catalog.invalidate(call.tenant.workspaceId, id);
    await audit(call, action, updated);
    return toConnectorView(updated);
  };

  const audit = (
    call: GatewayCallContext,
    action: string,
    connector: Connector,
    data: Record<string, unknown> = {},
  ) =>
    rt.audit.append(call.tenant, {
      actor: actorRef(call.tenant.actor),
      action,
      subjectType: "connector",
      subjectId: connector.id,
      data: redactDeep({
        name: connector.name,
        status: connector.status,
        version: connector.version,
        ...data,
      }),
    });

  const assertNotRevoked = (connector: Connector) => {
    if (connector.status === "revoked") {
      throw new StudixError("CONFLICT", `Connector ${connector.name} is revoked`, {
        suggestedAction: "Add the server again as a new connector.",
      });
    }
  };

  return {
    async add(call, input) {
      authorizeCall(call, GATEWAY_PERMISSIONS.manage);
      const parsed = parseInput(AddConnectorInput, input);
      const url = rt.urlPolicy.validate(parsed.url);
      const toolPolicy =
        parsed.toolPolicy === undefined ? EMPTY_TOOL_POLICY : validateToolPolicy(parsed.toolPolicy);
      const existing = await rt.connectors.list(call.tenant);
      if (existing.length >= rt.limits.maxConnectorsPerWorkspace) {
        throw new StudixError(
          "CONFLICT",
          `A workspace can register at most ${rt.limits.maxConnectorsPerWorkspace} connectors`,
        );
      }
      const connector = await rt.connectors.create(call.tenant, {
        name: parsed.name,
        url: url.toString(),
        transport: "streamable-http",
        status: "enabled",
        ...(parsed.secretRef ? { secretRef: parsed.secretRef } : {}),
        toolPolicy,
        createdBy: actorRef(call.tenant.actor),
      });
      await audit(call, "connector.added", connector, {
        host: url.host,
        hasCredential: parsed.secretRef !== undefined,
      });
      return toConnectorView(connector);
    },

    async refresh(call, id) {
      authorizeCall(call, GATEWAY_PERMISSIONS.manage);
      const connector = await load(call, id);
      assertNotRevoked(connector);
      const started = performance.now();
      let patch: ConnectorPatch;
      try {
        const target = await downstreamTarget(rt, call, connector);
        const raw = await rt.client.listTools(target, {
          signal: AbortSignal.timeout(rt.limits.timeoutMs),
          timeoutMs: rt.limits.timeoutMs,
          maxTools: rt.limits.maxToolsPerConnector,
        });
        const { tools, dropped } = normalizeTools(raw, rt.limits);
        patch = {
          tools,
          lastTest: {
            ok: true,
            at: rt.clock.now(),
            latencyMs: Math.round(performance.now() - started),
            toolCount: tools.length,
            ...(dropped > 0 ? { droppedTools: dropped } : {}),
          },
        };
      } catch (error) {
        const err = toStudixError(error);
        // Keep the previous catalog: a failed refresh must not silently drop working tools.
        patch = {
          lastTest: {
            ok: false,
            at: rt.clock.now(),
            latencyMs: Math.round(performance.now() - started),
            error: { code: err.code, message: redact(err.message).slice(0, 500), retryable: err.retryable },
          },
        };
      }
      const updated = await rt.connectors.update(call.tenant, id, patch);
      rt.catalog.invalidate(call.tenant.workspaceId, id);
      await audit(call, "connector.refreshed", updated, {
        ok: patch.lastTest?.ok,
        toolCount: patch.lastTest?.toolCount,
      });
      return { connector: toConnectorView(updated), result: updated.lastTest! };
    },

    enable: (call, id) =>
      change(call, id, "connector.enabled", (current) => {
        assertNotRevoked(current);
        return { status: "enabled" };
      }),

    disable: (call, id) =>
      change(call, id, "connector.disabled", (current) => {
        assertNotRevoked(current);
        return { status: "disabled" };
      }),

    setToolPolicy: (call, id, policy) => {
      const validated = validateToolPolicy(policy);
      return change(call, id, "connector.policy_updated", (current) => {
        assertNotRevoked(current);
        return { toolPolicy: validated };
      });
    },

    revoke: (call, id) =>
      change(call, id, "connector.revoked", () => ({
        status: "revoked",
        secretRef: null,
        tools: [],
        toolPolicy: EMPTY_TOOL_POLICY,
      })),

    async list(call) {
      authorizeCall(call, GATEWAY_PERMISSIONS.discover);
      return (await rt.connectors.list(call.tenant)).map(toConnectorView);
    },

    async get(call, id) {
      authorizeCall(call, GATEWAY_PERMISSIONS.discover);
      return toConnectorView(await load(call, id));
    },
  };
}
