import {
  createPiSdkAgentRuntime,
  findPiModel,
  isRuntimeKeyProvider,
  listPiCatalog,
  type PiCatalogProvider,
  type PiRunBinding,
} from "@studix/agent-runtime";
import { type CredentialVault, keyHintOf } from "@studix/auth";
import {
  AGENT_RUNTIME_IDS,
  assertPermission,
  DEFAULT_STAGE,
  type ModelPreference,
  type ModelPreferenceRepository,
  type ModelSelectionSource,
  type ProviderConnection,
  type ProviderConnectionRepository,
  type ProviderConnectionTestResult,
  type PublicProviderConnection,
  resolveModelSelection,
  type TenantContext,
  toPublicConnection,
} from "@studix/core";
import { type Clock, StudixError, systemClock, toStudixError } from "@studix/shared";
import { z } from "zod";

/** Stages the dashboard offers a model choice for, `default` first. */
export const MODEL_STAGES = [DEFAULT_STAGE, "plan"] as const;

const Label = z.string().trim().min(1).max(60);
/** Keys are pasted, never typed: bounded, single line, no surrounding whitespace. */
const ApiKey = z.string().trim().min(8).max(4096).regex(/^\S+$/, "must not contain whitespace");
const ModelId = z.string().trim().min(1).max(200);
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

/**
 * API-key connections only. There is deliberately no `baseUrl`: custom endpoints stay off until outbound
 * URLs are checked against private networks, and OAuth stays off until a provider is cleared (ADR 0012).
 */
export const CreateConnectionBody = z
  .object({
    provider: z.string().trim().min(1).max(60),
    label: Label,
    owner: z.enum(["workspace", "personal"]),
    apiKey: ApiKey,
    runtimes: z.array(z.enum(AGENT_RUNTIME_IDS)).min(1).max(AGENT_RUNTIME_IDS.length).default(["pi"]),
  })
  .strict();

export const RotateConnectionBody = z.object({ apiKey: ApiKey }).strict();
export const TestConnectionBody = z.object({ modelId: ModelId.optional() }).strict();

const Choice = z.object({ connectionId: Id, modelId: ModelId }).strict();
export const UpsertPreferenceBody = z
  .object({
    scope: z.enum(["workspace", "personal"]),
    stage: z.enum(MODEL_STAGES),
    connectionId: Id,
    modelId: ModelId,
    allowFallback: z.boolean().default(false),
    fallbacks: z.array(Choice).max(3).default([]),
  })
  .strict();

export interface ResolutionPreview {
  stage: string;
  choice?: { source: ModelSelectionSource; connectionId: string; provider: string; modelId: string };
}

/** Sends one tiny prompt with the binding's key; resolves when the provider answered. */
export type ConnectionProbe = (ctx: TenantContext, binding: PiRunBinding) => Promise<void>;

export interface ProviderAdmin {
  catalog(): PiCatalogProvider[];
  listConnections(ctx: TenantContext): Promise<PublicProviderConnection[]>;
  createConnection(
    ctx: TenantContext,
    body: z.output<typeof CreateConnectionBody>,
  ): Promise<PublicProviderConnection>;
  testConnection(
    ctx: TenantContext,
    id: string,
    body: z.output<typeof TestConnectionBody>,
  ): Promise<PublicProviderConnection>;
  rotateConnection(
    ctx: TenantContext,
    id: string,
    body: z.output<typeof RotateConnectionBody>,
  ): Promise<PublicProviderConnection>;
  deleteConnection(ctx: TenantContext, id: string): Promise<void>;
  listPreferences(ctx: TenantContext): Promise<ModelPreference[]>;
  upsertPreference(ctx: TenantContext, body: z.output<typeof UpsertPreferenceBody>): Promise<ModelPreference>;
  deletePreference(ctx: TenantContext, id: string): Promise<void>;
  /** Which model each stage would run on for the caller right now. */
  preview(ctx: TenantContext): Promise<ResolutionPreview[]>;
}

export interface ProviderAdminDeps {
  connections: ProviderConnectionRepository;
  preferences: ModelPreferenceRepository;
  vault: CredentialVault;
  clock?: Clock;
  /** Test seam; production asks the real provider through the Pi SDK. */
  probe?: ConnectionProbe;
}

const PROBE_TIMEOUT_MS = 20_000;

/** One short reply from the cheapest-sized request the runtime can make; capped at one cent. */
const piProbe: ConnectionProbe = async (ctx, binding) => {
  const runtime = createPiSdkAgentRuntime({ resolver: { resolve: async () => ({ bindings: [binding] }) } });
  await runtime.run(ctx, {
    skill: "connection-test",
    instructions: "Reply with the single word OK.",
    input: {},
    maxTurns: 1,
    maxCostCents: 1,
    deadlineAt: new Date(Date.now() + PROBE_TIMEOUT_MS),
  });
};

/** Test outcome code shown in the dashboard; the provider message is kept short and key-free. */
function testCode(error: StudixError): { code: string; status?: ProviderConnection["status"] } {
  switch (error.code) {
    case "UNAUTHENTICATED":
      return { code: "unauthenticated", status: "invalid" };
    case "FORBIDDEN":
      return { code: "forbidden", status: "invalid" };
    case "RATE_LIMITED":
      return { code: "quota" };
    case "TIMEOUT":
      return { code: "timeout" };
    case "BUDGET_EXCEEDED":
      // The provider answered; only our one-cent cap stopped it, so the key works.
      return { code: "ok" };
    default:
      return { code: "provider_error" };
  }
}

function cheapestModel(provider: string): string | undefined {
  const models = listPiCatalog().find((p) => p.id === provider)?.models ?? [];
  return [...models].sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output))[0]?.id;
}

const notFound = () => new StudixError("NOT_FOUND", "Provider connection not found");

/**
 * Settings > AI & Models. Workspace-owned connections and workspace defaults need `provider:manage`;
 * personal ones need `provider:connect` and belong to the signed-in user. Keys go straight into the
 * credential vault and are never returned; responses carry only a short hint.
 */
export function createProviderAdmin(deps: ProviderAdminDeps): ProviderAdmin {
  const clock = deps.clock ?? systemClock;
  const probe = deps.probe ?? piProbe;
  let catalog: PiCatalogProvider[] | undefined;

  const userIdOf = (ctx: TenantContext): string => {
    if (ctx.actor.type !== "user") {
      throw new StudixError("FORBIDDEN", "Only a signed-in member can manage provider connections", {
        retryable: false,
      });
    }
    return ctx.actor.id;
  };
  const assertOwnerPermission = (ctx: TenantContext, owner: "workspace" | "personal") =>
    assertPermission(ctx, owner === "workspace" ? "provider:manage" : "provider:connect");

  /** A visible connection the caller may change: personal ones are only ever visible to their owner. */
  const editable = async (ctx: TenantContext, id: string): Promise<ProviderConnection> => {
    userIdOf(ctx);
    const connection = await deps.connections.get(ctx, id);
    if (!connection) throw notFound();
    assertOwnerPermission(ctx, connection.owner.type === "workspace" ? "workspace" : "personal");
    return connection;
  };

  return {
    catalog() {
      catalog ??= listPiCatalog();
      return catalog;
    },

    async listConnections(ctx) {
      assertPermission(ctx, "workspace:read");
      return (await deps.connections.list(ctx)).map(toPublicConnection);
    },

    async createConnection(ctx, body) {
      const userId = userIdOf(ctx);
      assertOwnerPermission(ctx, body.owner);
      if (!isRuntimeKeyProvider(body.provider)) {
        throw new StudixError("VALIDATION", `${body.provider} cannot be connected with an API key here`, {
          retryable: false,
          suggestedAction: "Choose a provider from the catalog.",
        });
      }
      const secretRef = await deps.vault.put(ctx, body.apiKey);
      try {
        const created = await deps.connections.create(ctx, {
          provider: body.provider,
          label: body.label,
          authMethod: "api_key",
          owner: body.owner === "workspace" ? { type: "workspace" } : { type: "user", userId },
          status: "connected",
          billingSource: "usage-based",
          secretRef,
          keyHint: keyHintOf(body.apiKey),
          runtimes: body.runtimes,
          createdBy: { type: "user", id: userId },
        });
        return toPublicConnection(created);
      } catch (error) {
        await deps.vault.remove(ctx, secretRef).catch(() => {});
        throw error;
      }
    },

    async testConnection(ctx, id, body) {
      const connection = await editable(ctx, id);
      if (!connection.secretRef || connection.authMethod !== "api_key") {
        throw new StudixError("VALIDATION", "Only API key connections can be tested", { retryable: false });
      }
      const modelId = body.modelId ?? cheapestModel(connection.provider);
      if (!modelId || !findPiModel(connection.provider, modelId)) {
        throw new StudixError("VALIDATION", "Choose a model from this provider's catalog to test with", {
          retryable: false,
        });
      }
      const started = clock.now().getTime();
      let result: ProviderConnectionTestResult;
      let status: ProviderConnection["status"] = "connected";
      try {
        const apiKey = await deps.vault.reveal(ctx, connection.secretRef);
        await probe(ctx, { provider: connection.provider, modelId, apiKey, connectionId: connection.id });
        result = { ok: true, at: clock.now(), latencyMs: clock.now().getTime() - started, code: "ok" };
      } catch (error) {
        const failure = toStudixError(error);
        const outcome = testCode(failure);
        if (outcome.status) status = outcome.status;
        result = {
          ok: outcome.code === "ok",
          at: clock.now(),
          latencyMs: clock.now().getTime() - started,
          code: outcome.code,
          ...(outcome.code === "ok" ? {} : { message: failure.message.slice(0, 300) }),
        };
      }
      return toPublicConnection(await deps.connections.update(ctx, id, { status, lastTest: result }));
    },

    async rotateConnection(ctx, id, body) {
      const connection = await editable(ctx, id);
      if (!connection.secretRef || connection.authMethod !== "api_key") {
        throw new StudixError("VALIDATION", "Only API key connections can be rotated", { retryable: false });
      }
      await deps.vault.replace(ctx, connection.secretRef, body.apiKey);
      // A rejected key marked the connection invalid; the replacement gets a fresh chance (run Test to verify).
      return toPublicConnection(
        await deps.connections.update(ctx, id, { keyHint: keyHintOf(body.apiKey), status: "connected" }),
      );
    },

    async deleteConnection(ctx, id) {
      await editable(ctx, id);
      await deps.connections.delete(ctx, id);
    },

    async listPreferences(ctx) {
      assertPermission(ctx, "workspace:read");
      return deps.preferences.list(ctx, { runtime: "pi" });
    },

    async upsertPreference(ctx, body) {
      const userId = userIdOf(ctx);
      assertOwnerPermission(ctx, body.scope);
      const providerOf = async (choice: { connectionId: string; modelId: string }) => {
        const connection = await deps.connections.get(ctx, choice.connectionId);
        if (!connection) throw notFound();
        if (!findPiModel(connection.provider, choice.modelId)) {
          throw new StudixError("VALIDATION", `${choice.modelId} is not a ${connection.provider} model`, {
            retryable: false,
            suggestedAction: "Pick a model from the catalog.",
          });
        }
        return connection.provider;
      };
      const provider = await providerOf(body);
      const fallbacks = body.allowFallback
        ? await Promise.all(body.fallbacks.map(async (f) => ({ ...f, provider: await providerOf(f) })))
        : [];
      // Visibility and ownership of every referenced connection are enforced again by the repository.
      return deps.preferences.upsert(ctx, {
        scope: body.scope === "workspace" ? { type: "workspace" } : { type: "user", userId },
        stage: body.stage,
        runtime: "pi",
        connectionId: body.connectionId,
        provider,
        modelId: body.modelId,
        allowFallback: body.allowFallback,
        fallbacks,
      });
    },

    async deletePreference(ctx, id) {
      userIdOf(ctx);
      const preference = (await deps.preferences.list(ctx)).find((p) => p.id === id);
      if (!preference) throw new StudixError("NOT_FOUND", "Model preference not found");
      assertOwnerPermission(ctx, preference.scope.type === "workspace" ? "workspace" : "personal");
      await deps.preferences.delete(ctx, id);
    },

    async preview(ctx) {
      assertPermission(ctx, "workspace:read");
      const preferences = await deps.preferences.list(ctx, { runtime: "pi" });
      const userId = ctx.actor.type === "user" ? ctx.actor.id : undefined;
      return MODEL_STAGES.map((stage) => {
        const selected = resolveModelSelection(preferences, { runtime: "pi", stage, userId });
        if (!selected) return { stage };
        const { source, preference } = selected;
        return {
          stage,
          choice: {
            source,
            connectionId: preference.connectionId,
            provider: preference.provider,
            modelId: preference.modelId,
          },
        };
      });
    },
  };
}
