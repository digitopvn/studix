import type { NewRecord } from "../entities/common.ts";
import type {
  ModelPreference,
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderConnectionTestResult,
  ResolvedModelSnapshot,
} from "../entities/provider-connection.ts";
import type { TenantContext } from "../tenant.ts";

export type NewProviderConnection = Omit<NewRecord<ProviderConnection>, "version" | "lastTest">;

export interface ProviderConnectionPatch {
  label?: string;
  status?: ProviderConnectionStatus;
  secretRef?: string | null;
  keyHint?: string | null;
  baseUrl?: string | null;
  runtimes?: ProviderConnection["runtimes"];
  billingSource?: ProviderConnection["billingSource"];
  lastTest?: ProviderConnectionTestResult;
}

/**
 * Connections visible to the caller: workspace-owned ones plus the caller's own personal ones. Another
 * member's personal connection is never returned, by list or by get.
 */
export interface ProviderConnectionRepository {
  create(ctx: TenantContext, input: NewProviderConnection): Promise<ProviderConnection>;
  get(ctx: TenantContext, id: string): Promise<ProviderConnection | undefined>;
  list(ctx: TenantContext, query?: { provider?: string }): Promise<ProviderConnection[]>;
  /** Bumps `version`. */
  update(ctx: TenantContext, id: string, patch: ProviderConnectionPatch): Promise<ProviderConnection>;
  delete(ctx: TenantContext, id: string): Promise<void>;
}

export type NewModelPreference = Omit<NewRecord<ModelPreference>, "updatedAt">;

export interface ModelPreferenceRepository {
  /** One row per (scope owner, stage, runtime); replaces an existing entry. */
  upsert(ctx: TenantContext, input: NewModelPreference): Promise<ModelPreference>;
  /** Workspace-scoped entries plus the caller's own user-scoped entries. */
  list(ctx: TenantContext, query?: { runtime?: ModelPreference["runtime"] }): Promise<ModelPreference[]>;
  delete(ctx: TenantContext, id: string): Promise<void>;
}

/**
 * Sealed secret storage. Callers hand over ciphertext only; the vault in @studix/auth does the
 * encryption, so a database dump alone never reveals a credential.
 */
export interface SealedCredentialStore {
  put(ctx: TenantContext, secretRef: string, sealed: string): Promise<void>;
  get(ctx: TenantContext, secretRef: string): Promise<string | undefined>;
  delete(ctx: TenantContext, secretRef: string): Promise<void>;
}

/**
 * The model a job resolved for a stage, recorded once. Later attempts of the same job read it back instead
 * of re-resolving, so a preference changed mid-job never reroutes it (ADR 0011).
 */
export interface ModelSnapshotRepository {
  /** First write wins: returns the stored snapshot, which is `snapshot` only when none existed yet. */
  pin(ctx: TenantContext, jobId: string, snapshot: ResolvedModelSnapshot): Promise<ResolvedModelSnapshot>;
  get(
    ctx: TenantContext,
    jobId: string,
    key: Pick<ResolvedModelSnapshot, "runtime" | "stage">,
  ): Promise<ResolvedModelSnapshot | undefined>;
}
