# 0005. Durable jobs on PostgreSQL

- Status: Accepted
- Date: 2026-10-27

## Context

Video jobs run for minutes, span several stages and must survive pod restarts
on Kubernetes. `motion-mcp` used an in-process queue and marked interrupted
jobs failed on startup. Studix already needs PostgreSQL as its system of record.

## Decision

- The queue is a Postgres `jobs` table owned by `@studix/workflow` and
  `@studix/database`.
- Workers claim with `SELECT ... FOR UPDATE SKIP LOCKED`, take a lease and
  extend it with a heartbeat. An expired lease makes the job claimable again.
- Lease expiry is written and compared on the database clock (`now()`), so
  worker clock skew cannot shorten or stretch a lease. The worker's watchdog
  counts the lease length on its own clock from when each renewal was
  requested, and stops the attempt one safety margin before it lapses;
  `createJobExecutor` rejects a heartbeat interval that is not shorter than the
  lease minus that margin.
- A worker that lost its lease must not change anything for the attempt it no
  longer owns. Stage, progress and usage writes, and the business writes a
  stage makes (projects, renders, via `StageContext.commit`), run in a
  transaction that locks the job row and checks `locked_by`, `attempts` and
  `running` first; a refused write ends the attempt as `lease_lost`.
- Each stage writes a checkpoint; recovery resumes at the last completed stage.
- Enqueue takes an idempotency key, unique per workspace.
- Per-workspace concurrency, cancellation, timeout and budget are checked at
  claim time and at stage boundaries.
- Approval waits are a persisted state, so they survive restarts. A worker opens an approval request and
  its `approval.requested` audit entry in one transaction that locks the job row and checks `locked_by`,
  `attempts` and `running`, reusing a live pending request, so a stale worker neither duplicates nor orphans one.
  Every path that opens a request (studio, worker gate, connector gate) goes through `ApprovalRepository.open`,
  backed by a partial unique index on pending approvals per workspace, subject, action and scope key
  (connector approvals use the tool and argument key as scope), so concurrent openers converge on one row.
  `open` closes pending requests past their expiry first. The worker sweep also closes expired requests of
  parked jobs and fails those jobs with a non-retryable `TIMEOUT` (`approval_expired`), because nobody can
  decide an expired request.
- Mutating downstream calls with unknown outcome are not retried automatically.

## Consequences

- One datastore to operate, back up and migrate; no broker in P0.
- Throughput is bounded by Postgres; adequate for render-bound jobs measured in
  minutes. Revisit if job volume makes polling contention visible.

## Alternatives considered

- Redis/BullMQ: a second stateful service for no P0 benefit.
- Temporal or another workflow engine: strong guarantees, heavy operational
  cost for the bootstrap.
- In-process queue: loses work on restart.
