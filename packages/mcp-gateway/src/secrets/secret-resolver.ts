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
  /** Downstream URL the credential would be sent to, so resolvers can bind secrets to an origin. */
  url: string;
}

/**
 * Resolves an opaque `secretRef` to outbound credentials at execute/test time only. Implementations must
 * be tenant-aware (a ref from workspace A never resolves for workspace B) and must throw rather than
 * return a partial credential.
 */
export interface SecretResolver {
  /** Throw unless this workspace may use `secretRef` for a connector at `url` (checked when it is registered). */
  authorize(ctx: TenantContext, target: { url: string }, secretRef: string): void;
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

const FORBIDDEN_REF = () =>
  new StudixError("FORBIDDEN", "This workspace may not use that secret reference", {
    suggestedAction: "Ask the operator to grant the secret to this workspace and connector origin.",
  });

/**
 * P0 resolver for operator-managed credentials: `secretRef = "env:STUDIX_CONNECTOR_SECRET_<NAME>"` maps
 * to a bearer token held in the server environment (injected from the deployment secret store).
 * Each secret is bound by two companion variables, both required (fail closed):
 *   `<VAR>_WORKSPACES` comma-separated workspace ids that may reference it,
 *   `<VAR>_ORIGIN`     the only origin (scheme://host[:port]) the token is ever sent to.
 * Without the binding any self-registered workspace could point a connector at its own server and
 * receive the operator's token. Encrypted per-workspace secrets arrive with the connector dashboard in P1.
 */
export function createEnvSecretResolver(options: EnvSecretResolverOptions = {}): SecretResolver {
  const env = options.env ?? process.env;
  const prefix = options.prefix ?? "STUDIX_CONNECTOR_SECRET_";

  const variableOf = (secretRef: string): string => {
    const name = /^env:([A-Z0-9_]+)$/.exec(secretRef)?.[1];
    if (!name?.startsWith(prefix) || name.endsWith("_WORKSPACES") || name.endsWith("_ORIGIN")) {
      throw new StudixError("VALIDATION", "Unsupported secret reference", {
        suggestedAction: `Use env:${prefix}<NAME>.`,
      });
    }
    return name;
  };

  const originOf = (url: string): string | undefined => {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  };

  const authorize = (ctx: TenantContext, target: { url: string }, secretRef: string): string => {
    const name = variableOf(secretRef);
    const workspaces = (env[`${name}_WORKSPACES`] ?? "")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    const allowedOrigin = originOf(env[`${name}_ORIGIN`] ?? "");
    if (!workspaces.includes(ctx.workspaceId) || !allowedOrigin || originOf(target.url) !== allowedOrigin) {
      throw FORBIDDEN_REF();
    }
    return name;
  };

  return {
    authorize(ctx, target, secretRef) {
      authorize(ctx, target, secretRef);
    },
    async resolve(ctx, owner, secretRef) {
      const name = authorize(ctx, owner, secretRef);
      const value = env[name];
      if (!value) {
        throw new StudixError("UNAVAILABLE", "Connector credential is not configured", { retryable: false });
      }
      return { headers: { authorization: `Bearer ${value}` } };
    },
  };
}
