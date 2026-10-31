import {
  type ActorRef,
  type AgentRuntimeId,
  connectionUsableBy,
  type ModelChoice,
  type ModelPreferenceRepository,
  type ProviderConnection,
  type ProviderConnectionRepository,
  type ResolvedModelSnapshot,
  resolveModelSelection,
  type TenantContext,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { isRuntimeKeyProvider } from "./pi-catalog.ts";

/** A custom or proxied endpoint for a provider (OpenAI-compatible gateways, self-hosted models). */
export interface PiEndpoint {
  baseUrl: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  /** Required when the provider is not in the Pi catalog. */
  models?: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    input?: Array<"text" | "image">;
    contextWindow?: number;
    maxTokens?: number;
    /** USD per million tokens. */
    cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  }>;
}

/** Exactly one provider, one model and one decrypted credential for one attempt. */
export interface PiRunBinding {
  provider: string;
  modelId: string;
  apiKey: string;
  endpoint?: PiEndpoint;
  connectionId: string;
}

export interface PiResolvedRun {
  /** Primary first. Fallbacks are present only when the preference explicitly allows them. */
  bindings: PiRunBinding[];
  snapshot?: ResolvedModelSnapshot;
}

/** Hands the Pi loop its credentials. Implementations are per job and never read process env. */
export interface PiBindingResolver {
  resolve(ctx: TenantContext, request: { stage: string }): Promise<PiResolvedRun>;
}

/** Structural subset of the credential vault in @studix/auth. */
export interface CredentialRevealer {
  reveal(ctx: TenantContext, secretRef: string): Promise<string>;
}

export interface ProviderBindingResolverOptions {
  connections: Pick<ProviderConnectionRepository, "get">;
  preferences: Pick<ModelPreferenceRepository, "list">;
  vault: CredentialRevealer;
  runtime?: AgentRuntimeId;
  /**
   * The person the job runs for, taken from the job record (never from a client). Personal connections
   * and preferences resolve only for this user; without it only workspace-owned ones are visible.
   */
  requestedBy?: ActorRef;
  /** Previous resolution of this job. A retry reuses its connection and model; it never re-resolves. */
  snapshot?: ResolvedModelSnapshot;
  /** Decides the endpoint for a connection (custom base URL), kept out of the credential itself. */
  endpointFor?: (connection: ProviderConnection) => PiEndpoint | undefined;
}

const NO_MODEL_SELECTED = "no_model_selected";

/**
 * True only when nobody chose a model for the stage. Other `UNAVAILABLE` failures (an unreadable stored key,
 * a model removed from the catalog) mean a choice exists but cannot run.
 */
export function isNoModelSelected(error: unknown): boolean {
  return error instanceof StudixError && error.details?.reason === NO_MODEL_SELECTED;
}

const reconnect = (message: string, details?: Record<string, unknown>) =>
  new StudixError("UNAUTHENTICATED", message, {
    retryable: false,
    suggestedAction: "Open Settings > AI & Models, reconnect the provider and choose a model.",
    ...(details ? { details } : {}),
  });

export function createProviderBindingResolver(options: ProviderBindingResolverOptions): PiBindingResolver {
  const runtime = options.runtime ?? "pi";
  const userId = options.requestedBy?.type === "user" ? options.requestedBy.id : undefined;

  return {
    async resolve(ctx, request) {
      // Reads happen as the requesting user so repository visibility rules apply to them, not to the worker.
      const lookup: TenantContext = userId
        ? { ...ctx, actor: { type: "user", id: userId, role: "viewer" } }
        : { ...ctx, actor: { type: "system", id: ctx.actor.id } };

      const bind = async (
        choice: ModelChoice,
      ): Promise<{ binding: PiRunBinding; connection: ProviderConnection }> => {
        const connection = await options.connections.get(lookup, choice.connectionId);
        if (!connection?.secretRef) {
          throw reconnect("The selected provider connection no longer exists", {
            connectionId: choice.connectionId,
          });
        }
        if (!connectionUsableBy(connection, userId)) {
          throw reconnect(
            `The ${connection.provider} connection is ${connection.status} or not yours to use`,
            {
              connectionId: connection.id,
              status: connection.status,
            },
          );
        }
        if (!connection.runtimes.includes(runtime)) {
          throw new StudixError("FORBIDDEN", `This connection is not enabled for the ${runtime} runtime`, {
            retryable: false,
            suggestedAction: "Enable the runtime on the connection in Settings > AI & Models.",
          });
        }
        if (connection.provider !== choice.provider) {
          throw new StudixError("VALIDATION", "The model does not belong to the connection's provider", {
            retryable: false,
            details: { connectionProvider: connection.provider, modelProvider: choice.provider },
          });
        }
        if (connection.authMethod !== "api_key") {
          throw new StudixError("FORBIDDEN", "Only API key connections can run on the Pi runtime", {
            retryable: false,
            suggestedAction: "Connect this provider with an API key in Settings > AI & Models.",
          });
        }
        const endpoint = options.endpointFor?.(connection);
        if (!endpoint && !isRuntimeKeyProvider(connection.provider)) {
          throw new StudixError("FORBIDDEN", `${connection.provider} is not supported on the Pi runtime`, {
            retryable: false,
            suggestedAction: "Choose a provider that authenticates with an API key.",
          });
        }
        const apiKey = await options.vault.reveal(lookup, connection.secretRef);
        // An empty key would make the SDK fall back to the server's own environment credentials.
        if (!apiKey.trim())
          throw reconnect("The stored provider key is empty", { connectionId: connection.id });
        return {
          connection,
          binding: {
            provider: connection.provider,
            modelId: choice.modelId,
            apiKey,
            connectionId: connection.id,
            ...(endpoint ? { endpoint } : {}),
          },
        };
      };
      /** Fallbacks are optional: an unusable one is skipped rather than failing a healthy primary. */
      const bindFallbacks = async (choices: ModelChoice[]): Promise<PiRunBinding[]> =>
        (await Promise.allSettled(choices.map(bind))).flatMap((r) =>
          r.status === "fulfilled" ? [r.value.binding] : [],
        );

      const snapshot = options.snapshot;
      if (snapshot) {
        if (snapshot.runtime !== runtime || snapshot.stage !== request.stage) {
          throw new StudixError("VALIDATION", "The job snapshot belongs to a different runtime or stage", {
            retryable: false,
          });
        }
        const { binding: primary } = await bind(snapshot);
        const fallbacks = snapshot.allowFallback ? await bindFallbacks(snapshot.fallbacks) : [];
        return { bindings: [primary, ...fallbacks], snapshot };
      }

      const preferences = await options.preferences.list(lookup, { runtime });
      const selected = resolveModelSelection(preferences, { runtime, stage: request.stage, userId });
      if (!selected) {
        throw new StudixError("UNAVAILABLE", `No model is configured for the ${runtime} runtime`, {
          retryable: false,
          suggestedAction: "Connect a provider and choose a default model in Settings > AI & Models.",
          details: { reason: NO_MODEL_SELECTED },
        });
      }
      const { preference, source } = selected;
      const { binding: primary, connection } = await bind(preference);
      const fallbacks = preference.allowFallback ? await bindFallbacks(preference.fallbacks) : [];
      return {
        bindings: [primary, ...fallbacks],
        snapshot: {
          runtime,
          stage: request.stage,
          source,
          connectionId: connection.id,
          connectionVersion: connection.version,
          provider: preference.provider,
          modelId: preference.modelId,
          authMethod: connection.authMethod,
          billingSource: connection.billingSource,
          allowFallback: preference.allowFallback,
          fallbacks: preference.allowFallback ? preference.fallbacks : [],
        },
      };
    },
  };
}
