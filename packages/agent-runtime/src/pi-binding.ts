import {
  type ActorRef,
  type BillingSource,
  type ModelChoice,
  type ModelPreference,
  type ResolvedModelSnapshot,
  resolveModelSelection,
  type TenantContext,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { isRuntimeKeyProvider } from "./pi-catalog.ts";

/** An OpenAI-compatible or Anthropic-compatible endpoint for a provider the catalog does not know. */
export interface PiEndpoint {
  baseUrl: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  /** Required when the provider is not in the Pi catalog; every model must declare its price. */
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
  connectionId: string;
  endpoint?: PiEndpoint;
  /** Report a 401/403 from the provider so the connection can be re-tested and marked invalid. */
  markRejected?: () => Promise<void>;
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

/** Structural subset of `ProviderConnectionService.resolveForExecution` in @studix/auth. */
export interface PiCredentialSource {
  resolveForExecution(
    ctx: TenantContext,
    input: { connectionId: string; requestedBy: ActorRef; runtime: "pi" },
  ): Promise<{
    apiKey: string;
    connection: { id: string; provider: string; version: number; billing: BillingSource };
    markRejected(): Promise<void>;
  }>;
}

/** Structural subset of the model preference repository in @studix/database. */
export interface PiPreferenceSource {
  list(ctx: TenantContext, query: { userId?: string; runtime?: "pi" }): Promise<ModelPreference[]>;
}

export interface ProviderBindingResolverOptions {
  credentials: PiCredentialSource;
  preferences: PiPreferenceSource;
  /**
   * The person the job runs for, taken from the job record (never from a client). Personal connections
   * and preferences resolve only for this user.
   */
  requestedBy: ActorRef;
  /** This job's earlier resolution for the stage. A retry reuses it; it never re-resolves. */
  snapshot?: ResolvedModelSnapshot;
}

const NO_MODEL_SELECTED = "no_model_selected";

/**
 * True only when nobody chose a model for the stage. Other failures (an unreadable stored key, a key
 * disabled for Pi, a removed model) mean a choice exists but cannot run, and must not be papered over.
 */
export function isNoModelSelected(error: unknown): boolean {
  return error instanceof StudixError && error.details?.reason === NO_MODEL_SELECTED;
}

export function noModelSelected(stage: string): StudixError {
  return new StudixError("UNAVAILABLE", `No model is configured for the pi runtime (stage "${stage}")`, {
    retryable: false,
    suggestedAction: "Connect a provider and choose a default model in Settings → AI & Providers.",
    details: { reason: NO_MODEL_SELECTED },
  });
}

/**
 * Turns the job's model choice into bindings. The connection service enforces ownership, runtime opt-in
 * and status for every connection, so a key enabled only for `claude` never reaches Pi.
 */
export function createProviderBindingResolver(options: ProviderBindingResolverOptions): PiBindingResolver {
  const userId = options.requestedBy.type === "user" ? options.requestedBy.id : undefined;

  return {
    async resolve(ctx, request) {
      const bind = async (choice: ModelChoice) => {
        if (!isRuntimeKeyProvider(choice.provider)) {
          throw new StudixError("FORBIDDEN", `${choice.provider} is not supported on the Pi runtime`, {
            retryable: false,
            suggestedAction: "Choose a provider that authenticates with an API key.",
          });
        }
        const resolved = await options.credentials.resolveForExecution(ctx, {
          connectionId: choice.connectionId,
          requestedBy: options.requestedBy,
          runtime: "pi",
        });
        if (resolved.connection.provider !== choice.provider) {
          throw new StudixError("VALIDATION", "The model does not belong to the connection's provider", {
            retryable: false,
            details: { connectionProvider: resolved.connection.provider, modelProvider: choice.provider },
          });
        }
        // An empty key would make the SDK fall back to the server's own environment credentials.
        if (!resolved.apiKey.trim()) {
          throw new StudixError("UNAUTHENTICATED", "The stored provider key is empty", { retryable: false });
        }
        const binding: PiRunBinding = {
          provider: choice.provider,
          modelId: choice.modelId,
          apiKey: resolved.apiKey,
          connectionId: resolved.connection.id,
          markRejected: () => resolved.markRejected(),
        };
        return { binding, connection: resolved.connection };
      };
      /** Fallbacks are optional: an unusable one is skipped rather than failing a healthy primary. */
      const bindFallbacks = async (choices: ModelChoice[]): Promise<PiRunBinding[]> =>
        (await Promise.allSettled(choices.map(bind))).flatMap((r) =>
          r.status === "fulfilled" ? [r.value.binding] : [],
        );

      const pinned = options.snapshot;
      if (pinned) {
        if (pinned.runtime !== "pi" || pinned.stage !== request.stage) {
          throw new StudixError("VALIDATION", "The job snapshot belongs to a different runtime or stage", {
            retryable: false,
          });
        }
        const { binding } = await bind(pinned);
        const fallbacks = pinned.allowFallback ? await bindFallbacks(pinned.fallbacks) : [];
        return { bindings: [binding, ...fallbacks], snapshot: pinned };
      }

      const preferences = await options.preferences.list(ctx, {
        runtime: "pi",
        ...(userId ? { userId } : {}),
      });
      const selected = resolveModelSelection(preferences, { runtime: "pi", stage: request.stage, userId });
      if (!selected) throw noModelSelected(request.stage);
      const { preference, source } = selected;
      const { binding, connection } = await bind(preference);
      const fallbacks = preference.allowFallback ? await bindFallbacks(preference.fallbacks) : [];
      return {
        bindings: [binding, ...fallbacks],
        snapshot: {
          runtime: "pi",
          stage: request.stage,
          source,
          connectionId: connection.id,
          connectionVersion: connection.version,
          provider: preference.provider,
          modelId: preference.modelId,
          billingSource: connection.billing,
          allowFallback: preference.allowFallback,
          fallbacks: preference.allowFallback ? preference.fallbacks : [],
        },
      };
    },
  };
}
