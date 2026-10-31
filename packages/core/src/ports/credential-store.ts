import type { TenantContext } from "../tenant.ts";

/** Material handed to a runtime for exactly one execution. */
export type CredentialMaterial =
  | { kind: "api_key"; apiKey: string }
  | { kind: "oauth"; accessToken: string; expiresAt?: Date };

/**
 * Encrypted, tenant-scoped secret storage behind `ProviderConnection.secretRef`. Implementations must
 * encrypt at rest, bind every ref to its workspace (a ref from workspace A never resolves for B), and
 * never return plaintext except from `resolve`.
 */
export interface CredentialStore {
  /** Store a new secret and return its opaque ref. */
  put(ctx: TenantContext, material: CredentialMaterial): Promise<string>;
  /** Replace the secret behind a ref atomically (rotate / OAuth refresh). */
  replace(ctx: TenantContext, secretRef: string, material: CredentialMaterial): Promise<void>;
  /** Decrypt for one execution. Called by the worker at execution time only, never by API handlers. */
  resolve(ctx: TenantContext, secretRef: string): Promise<CredentialMaterial>;
  /** Destroy the secret. Idempotent. */
  delete(ctx: TenantContext, secretRef: string): Promise<void>;
}
