# 0007. Tenancy isolation

- Status: Accepted
- Date: 2026-10-27

## Context

Agencies run many brands and reviewers in one Studix deployment. A prompt or a
forgotten `WHERE` clause must not be able to leak one tenant's projects,
assets, connectors or credentials to another.

## Decision

- Hierarchy: `Organization -> Workspace -> Member (role)`.
- Every repository method in `@studix/database` takes
  `TenantContext {organizationId, workspaceId, actor}` and filters by it. No
  unscoped query API is exported from the package.
- API keys and sessions resolve to exactly one `TenantContext` before any
  service call.
- Foreign ids return `NOT_FOUND`.
- Storage keys, connector registries, catalogs, grants, budgets and usage are
  all workspace-scoped.
- Cross-tenant tests (tenant A cannot read or mutate tenant B) are required for
  every repository and for the gateway.

## Consequences

- Isolation is checked by code and tests, not by model behavior.
- Platform-level operations (migrations, metrics) use separate, non-exported
  paths.
- Database row-level security can be added later as defense in depth without
  changing the service API.

## Alternatives considered

- Database per tenant: heavy operations for P0.
- Row-level security only: harder to test and easy to bypass with a privileged
  connection.
