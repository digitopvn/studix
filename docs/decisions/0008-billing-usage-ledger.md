# 0008. Billing usage ledger

- Status: Accepted
- Date: 2026-10-27

## Context

The business model is usage-based plus on-prem, and pricing is not decided.
Studix still needs accurate cost accounting from day one for budgets, margins
and metrics. Retries and worker restarts must not double-count usage.
`motion-mcp` kept a credit ledger in a JSONL file.

## Decision

- `@studix/billing` writes usage events to a Postgres ledger, per
  organization, workspace, project, job, stage, provider and model.
- Each event records **COGS** (what Studix paid: tokens, render seconds,
  storage, provider fees) separately from **price** (what the customer is
  charged, set by a `BillingPolicy`).
- **No credit conversion is hardcoded.** Until pricing is decided, price may be
  empty; COGS is always recorded.
- Every event carries a dedupe key derived from job, stage, attempt and
  provider execution; inserts are idempotent.
- Budgets are checked before costly stages; exceeding one returns
  `BUDGET_EXCEEDED`.

## Consequences

- Cost per job and per decision are queryable for [METRICS.md](../METRICS.md).
- Checkout, subscriptions and invoicing are P3 and plug in through
  `BillingPolicy`.

## Alternatives considered

- Port the JSONL credit ledger: single writer, credits baked in.
- Bill directly from provider invoices: no per-job attribution.
