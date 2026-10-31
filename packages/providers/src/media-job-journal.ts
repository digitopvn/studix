import type { MediaKind, ProviderJobRef, TenantContext } from "@studix/core";

/**
 * submitting: the request is about to reach (or may have reached) an upstream that cannot deduplicate it,
 * so no job id is known yet; submitted: paid and running upstream; completed: outputs collected;
 * failed: ended without outputs.
 */
export type MediaJobState = "submitting" | "submitted" | "completed" | "failed";

/** What a provider must remember about an upstream job to collect it later instead of paying again. */
export interface MediaJobRecord {
  idempotencyKey: string;
  kind: MediaKind;
  model: string;
  /** Absent while `state` is "submitting": the upstream has not reported an id yet. */
  job?: ProviderJobRef;
  /** Submission attempt for this idempotency key; a failed job is resubmitted as the next attempt. */
  attempt: number;
  state: MediaJobState;
  estimatedCostCents: number;
  /** Charge reported when the job completed. */
  receiptCents?: number;
  submittedAt: string;
  updatedAt: string;
}

/**
 * Durable memory of upstream jobs, keyed by workspace and idempotency key. The record is written right
 * after submission, so a worker that dies while waiting leaves enough behind for the next attempt to
 * resume the same paid job. Implementations must scope reads and writes by `ctx.workspaceId`. `put` is an
 * unconditional overwrite, so it is only safe for transitions of a record the caller already owns. The
 * "submitting" intent goes through `claim`, which is atomic: of two callers racing to submit the same
 * idempotency key, exactly one wins.
 */
export interface MediaJobJournal {
  get(ctx: TenantContext, idempotencyKey: string): Promise<MediaJobRecord | undefined>;
  put(ctx: TenantContext, record: MediaJobRecord): Promise<void>;
  /**
   * Atomically write `record` only if no record exists for its idempotency key, or the stored one is a
   * "failed" record of the previous attempt (`record.attempt - 1`). Returns false, writing nothing, when
   * another caller already holds the key. A durable implementation must do this in one conditional write.
   */
  claim(ctx: TenantContext, record: MediaJobRecord): Promise<boolean>;
}

/** The stored record that `record` may replace in `claim`: none, or the failed previous attempt. */
export function canClaim(stored: MediaJobRecord | undefined, record: MediaJobRecord): boolean {
  return stored === undefined || (stored.state === "failed" && stored.attempt === record.attempt - 1);
}

/**
 * Process-local journal. It survives retries inside one worker process only; production wiring stores the
 * record with the stage checkpoint so another worker can resume it.
 */
export class InMemoryMediaJobJournal implements MediaJobJournal {
  private readonly records = new Map<string, MediaJobRecord>();

  async get(ctx: TenantContext, idempotencyKey: string): Promise<MediaJobRecord | undefined> {
    const record = this.records.get(this.key(ctx, idempotencyKey));
    return record ? structuredClone(record) : undefined;
  }

  async put(ctx: TenantContext, record: MediaJobRecord): Promise<void> {
    this.records.set(this.key(ctx, record.idempotencyKey), structuredClone(record));
  }

  async claim(ctx: TenantContext, record: MediaJobRecord): Promise<boolean> {
    // No await between the check and the write, so this is atomic within the process.
    const key = this.key(ctx, record.idempotencyKey);
    if (!canClaim(this.records.get(key), record)) return false;
    this.records.set(key, structuredClone(record));
    return true;
  }

  private key(ctx: TenantContext, idempotencyKey: string): string {
    return JSON.stringify([ctx.workspaceId, idempotencyKey]);
  }
}
