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
- Every write made on behalf of an attempt is fenced: it runs in a transaction that
  locks the job row and checks `locked_by`, `attempts` and `status = running`, and
  writes nothing otherwise. This covers job progress, stage rows and usage events,
  and the project and render writes a stage makes through `StageContext.fenced`
  (the stage's repositories are bound to that transaction). A stalled worker that
  wakes after another worker reclaimed the job gets `lease_lost` and changes nothing.
- Each stage writes a checkpoint; recovery resumes at the last completed stage.
- Enqueue takes an idempotency key, unique per workspace.
- Per-workspace concurrency, cancellation, timeout and budget are checked at
  claim time and at stage boundaries.
- Approval waits are a persisted state, so they survive restarts.
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
