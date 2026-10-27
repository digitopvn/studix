import type { TenantContext } from "@studix/core";
import { registerSecret, StudixError } from "@studix/shared";

/** Outbound headers for one downstream server. Built only from a secretRef, never from inbound requests. */
export interface OutboundCredential {
  headers: Record<string, string>;
}

/** Identity of the connector a secret is being resolved for, so resolvers can bind secrets to servers. */
export interface SecretOwner {
  connectorId: string;
  connectorName: string;
}

/**
 * Resolves an opaque `secretRef` to outbound credentials at execute/test time only. Implementations must
 * be tenant-aware (a ref from workspace A never resolves for workspace B) and must throw rather than
 * return a partial credential.
 */
export interface SecretResolver {
  resolve(ctx: TenantContext, owner: SecretOwner, secretRef: string): Promise<OutboundCredential>;
}

const ALLOWED_HEADER = /^(authorization|x-[a-z0-9-]{1,64})$/i;

/**
 * Validate resolver output and register every value with the redactor so it is scrubbed from logs,
 * traces and error messages even if a downstream server echoes it back.
 */
export function sanitizeOutboundCredential(credential: OutboundCredential): OutboundCredential {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(credential.headers ?? {})) {
    if (!ALLOWED_HEADER.test(name) || typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new StudixError("INTERNAL", "Secret resolver produced an invalid outbound header", {
        details: { header: name },
      });
    }
    registerSecret(value);
    const token = /^Bearer\s+(.+)$/i.exec(value)?.[1];
    registerSecret(token);
    headers[name.toLowerCase()] = value;
  }
  return { headers };
}

export interface EnvSecretResolverOptions {
  env?: NodeJS.ProcessEnv;
  /** Only variables with this prefix may be referenced (default `STUDIX_CONNECTOR_SECRET_`). */
  prefix?: string;
}

/**
 * P0 resolver for operator-managed credentials: `secretRef = "env:STUDIX_CONNECTOR_SECRET_<NAME>"` maps
 * to a bearer token held in the server environment (injected from the deployment secret store).
 * Encrypted per-workspace secrets arrive with the connector dashboard in P1.
 */
export function createEnvSecretResolver(options: EnvSecretResolverOptions = {}): SecretResolver {
  const env = options.env ?? process.env;
  const prefix = options.prefix ?? "STUDIX_CONNECTOR_SECRET_";
  return {
    async resolve(_ctx, _owner, secretRef) {
      const match = /^env:([A-Z0-9_]+)$/.exec(secretRef);
      if (!match || !match[1]!.startsWith(prefix)) {
        throw new StudixError("VALIDATION", "Unsupported secret reference", {
          suggestedAction: `Use env:${prefix}<NAME>.`,
        });
      }
      const value = env[match[1]!];
      if (!value) {
        throw new StudixError("UNAVAILABLE", "Connector credential is not configured", { retryable: false });
      }
      return { headers: { authorization: `Bearer ${value}` } };
    },
  };
}
