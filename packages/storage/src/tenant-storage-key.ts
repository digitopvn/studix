import { type TenantContext, tenantObjectKey } from "@studix/core";
import { StudixError } from "@studix/shared";

/** Tenant ids become path segments, so they must never contain separators or traversal. */
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** `orgs/<org>/workspaces/<ws>/` for a tenant; every object the tenant owns lives below it. */
export function tenantPrefix(ctx: Pick<TenantContext, "organizationId" | "workspaceId">): string {
  for (const [field, value] of [
    ["organizationId", ctx.organizationId],
    ["workspaceId", ctx.workspaceId],
  ] as const) {
    if (typeof value !== "string" || !TENANT_ID_PATTERN.test(value)) {
      throw new StudixError("UNAUTHENTICATED", `Invalid tenant ${field} for storage`, {
        suggestedAction: "Build the TenantContext from an authenticated session or API key.",
      });
    }
  }
  return `orgs/${ctx.organizationId}/workspaces/${ctx.workspaceId}/`;
}

/**
 * Absolute object key for a tenant-relative key. tenantObjectKey rejects absolute paths, `..` and empty
 * segments; the prefix check below is a second, independent guard so a future change to key building can
 * never let one workspace address another's objects.
 */
export function resolveTenantKey(
  ctx: Pick<TenantContext, "organizationId" | "workspaceId">,
  key: string,
): string {
  const prefix = tenantPrefix(ctx);
  const absolute = tenantObjectKey(ctx, key);
  if (!absolute.startsWith(prefix) || absolute.length <= prefix.length) {
    throw new StudixError("FORBIDDEN", "Storage key is outside the tenant prefix", {
      details: { key },
      suggestedAction: "Pass a tenant-relative key such as renders/<renderId>/preview.mp4.",
    });
  }
  return absolute;
}

const CONTENT_TYPE_PATTERN = /^[a-z]+\/[a-z0-9.+-]+(?:\s*;\s*[a-z0-9-]+=[^;\s]+)*$/i;

export function assertContentType(contentType: string): void {
  if (
    typeof contentType !== "string" ||
    contentType.length > 200 ||
    !CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw new StudixError("VALIDATION", "Invalid content type", {
      details: { contentType },
      suggestedAction: "Use a MIME type such as video/mp4 or image/png.",
    });
  }
}
