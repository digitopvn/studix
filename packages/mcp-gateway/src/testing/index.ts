import { StudixError } from "@studix/shared";
import type { SecretResolver } from "../secrets/secret-resolver.ts";
import type { HostResolver, ResolvedAddress } from "../url-policy/connector-url-policy.ts";

export * from "./in-memory-connector-repository.ts";

/**
 * Test resolver: `secrets[workspaceId][secretRef] = token`. Refs resolve only inside their own workspace.
 * Records every resolution so tests can assert secrets are resolved only at test/execute time.
 */
export function createStaticSecretResolver(
  secrets: Record<string, Record<string, string>>,
): SecretResolver & {
  resolutions: Array<{ workspaceId: string; connectorId: string; secretRef: string }>;
} {
  const resolutions: Array<{ workspaceId: string; connectorId: string; secretRef: string }> = [];
  return {
    resolutions,
    async resolve(ctx, owner, secretRef) {
      resolutions.push({ workspaceId: ctx.workspaceId, connectorId: owner.connectorId, secretRef });
      const token = secrets[ctx.workspaceId]?.[secretRef];
      if (!token)
        throw new StudixError("UNAVAILABLE", "Connector credential is not configured", { retryable: false });
      return { headers: { authorization: `Bearer ${token}` } };
    },
  };
}

/**
 * DNS stub: answers are consumed in order per hostname (the last answer repeats), which lets tests model
 * a rebinding attacker whose second answer differs from the first.
 */
export function createStubHostResolver(answers: Record<string, ResolvedAddress[][]>): HostResolver & {
  calls: string[];
} {
  const calls: string[] = [];
  const cursor = new Map<string, number>();
  return {
    calls,
    async lookup(hostname) {
      calls.push(hostname);
      const list = answers[hostname];
      if (!list || list.length === 0) throw new Error(`ENOTFOUND ${hostname}`);
      const i = cursor.get(hostname) ?? 0;
      cursor.set(hostname, i + 1);
      return list[Math.min(i, list.length - 1)]!;
    },
  };
}
